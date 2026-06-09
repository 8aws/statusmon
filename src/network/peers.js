/**
 * network/peers.js
 * Peer table, gossip protocol, reputation scoring
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const PEERS_FILE_NAME = 'peers.json';
const MAX_PEERS = 20;
const PEER_TIMEOUT = 30000; // 30s request timeout
const REPUTATION_DECAY = 0.95; // per check cycle
const MIN_REPUTATION_TO_VOTE = 0.3;

let _dataDir = null;
let _peersFile = null;
let peers = {}; // { nodeId: PeerEntry }

/*
PeerEntry {
  nodeId: string,
  url: string,              // base URL of the StatusMon instance
  publicKey: string,        // base64 ED25519 public key
  isBootstrap: boolean,
  reputation: number,       // 0-1, starts at 0 for new peers
  totalChecks: number,
  successfulChecks: number,
  lastSeen: number,         // timestamp
  lastHeartbeat: number,
  region: string|null,
  version: string|null,
  encryptedWebhook: object|null, // encrypted emergency webhook
  passive: boolean,         // behind NAT, can't receive connections
}
*/

let _configLoader = null;
function init(dataDir, configLoader) {
  _dataDir = dataDir;
  _peersFile = path.join(dataDir, PEERS_FILE_NAME);
  _configLoader = configLoader || null;
  loadPeers();
}

function loadPeers() {
  if (!_peersFile || !fs.existsSync(_peersFile)) return;
  try {
    const raw = JSON.parse(fs.readFileSync(_peersFile, 'utf8'));
    peers = raw || {};
  } catch { peers = {}; }
}

let _peersDirtyTimer = null;
function savePeers() {
  if (!_peersFile) return;
  fs.writeFileSync(_peersFile, JSON.stringify(peers, null, 2));
}
function savePeersThrottled() {
  if (_peersDirtyTimer) return; // already scheduled
  _peersDirtyTimer = setTimeout(() => {
    savePeersThrottled();
    _peersDirtyTimer = null;
  }, 60 * 1000); // max once per minute
}

function getAllPeers() { return Object.values(peers); }
function getActivePeers() {
  const cutoff = Date.now() - 30 * 60 * 1000; // seen in last 30 min
  return Object.values(peers).filter(p => p.lastSeen > cutoff && !p.passive);
}
function getPeer(nodeId) { return peers[nodeId] || null; }

function addOrUpdatePeer(entry) {
  const existing = peers[entry.nodeId];
  peers[entry.nodeId] = {
    reputation: 0.1, // new peers start low
    totalChecks: 0,
    successfulChecks: 0,
    passive: false,
    ...existing,
    ...entry,
    lastSeen: Date.now(),
  };
  // Cap peers
  const all = Object.values(peers).sort((a, b) => b.reputation - a.reputation || b.lastSeen - a.lastSeen);
  if (all.length > MAX_PEERS) {
    const toRemove = all.slice(MAX_PEERS);
    toRemove.forEach(p => delete peers[p.nodeId]);
  }
  savePeersThrottled();
}

function recordPeerSuccess(nodeId) {
  if (!peers[nodeId]) return;
  peers[nodeId].totalChecks = (peers[nodeId].totalChecks || 0) + 1;
  peers[nodeId].successfulChecks = (peers[nodeId].successfulChecks || 0) + 1;
  peers[nodeId].lastSeen = Date.now();
  // Reputation grows toward 1 with successful checks (capped)
  const p = peers[nodeId];
  p.reputation = Math.min(1, (p.reputation || 0) + (1 - (p.reputation || 0)) * 0.05);
  savePeersThrottled();
}

function recordPeerFailure(nodeId) {
  if (!peers[nodeId]) return;
  peers[nodeId].totalChecks = (peers[nodeId].totalChecks || 0) + 1;
  const p = peers[nodeId];
  p.reputation = Math.max(0, (p.reputation || 0) * REPUTATION_DECAY);
  savePeersThrottled();
}

function removePeer(nodeId) {
  delete peers[nodeId];
  savePeersThrottled();
}

function getVotingPeers() {
  return getActivePeers().filter(p => p.reputation >= MIN_REPUTATION_TO_VOTE);
}

// ─── HTTP request to a peer ───────────────────────────────────────
function peerRequest(peerUrl, endpoint, opts = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(endpoint, peerUrl.endsWith('/') ? peerUrl : peerUrl + '/');
    const lib = url.protocol === 'https:' ? https : http;
    const body = opts.body ? JSON.stringify(opts.body) : null;
    const req = lib.request({
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method: opts.method || 'GET',
      timeout: PEER_TIMEOUT,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'StatusMon-Network/5.0',
        ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}),
      },
      rejectUnauthorized: false,
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    if (body) req.write(body);
    req.end();
  });
}

// ─── Gossip — exchange peer lists ─────────────────────────────────
async function gossipWith(peer) {
  try {
    const res = await peerRequest(peer.url, 'api/peer/peers');
    if (res.status !== 200 || !Array.isArray(res.body)) return;
    let newPeers = 0;
    res.body.forEach(p => {
      if (!p.nodeId || !p.url) return;
      if (!peers[p.nodeId]) newPeers++;
      addOrUpdatePeer({ ...p, reputation: Math.min(0.1, p.reputation || 0) }); // trust but verify
    });
    recordPeerSuccess(peer.nodeId);
    return newPeers;
  } catch {
    recordPeerFailure(peer.nodeId);
    return 0;
  }
}

module.exports = {
  init, getAllPeers, getActivePeers, getPeer, addOrUpdatePeer,
  recordPeerSuccess, recordPeerFailure, removePeer,
  getVotingPeers, peerRequest, gossipWith, savePeers,
};
