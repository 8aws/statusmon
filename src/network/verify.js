/**
 * network/verify.js
 * Cross-verification of URLs using peer network
 * Weighted consensus based on peer reputation
 */

const { getVotingPeers, peerRequest, recordPeerSuccess, recordPeerFailure } = require('./peers');
const { getNodeId, signedMessage } = require('./crypto');
const https = require('https');
const http = require('http');

const VERIFY_TIMEOUT = 8000;
const MAX_PEERS_TO_ASK = 4;
const MIN_PEERS_FOR_CONSENSUS = 2;

// ─── SSRF guard ───────────────────────────────────────────────────
// Only allow http/https to public IPs; block private/loopback ranges
const PRIVATE_IP_RE = /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|::1$|fc00:|fd)/i;

function isSafeVerifyUrl(urlStr) {
  try {
    const u = new URL(urlStr);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    const host = u.hostname;
    if (!host || host === 'localhost') return false;
    if (PRIVATE_IP_RE.test(host)) return false;
    return true;
  } catch { return false; }
}

// ─── Ask peers to verify a URL ────────────────────────────────────
async function verifyWithNetwork(url) {
  const peers = getVotingPeers();
  if (peers.length < MIN_PEERS_FOR_CONSENSUS) {
    return { consensus: null, reason: 'insufficient_peers', peers: [], votes: {} };
  }

  // Pick random sample of voting peers
  const sample = peers
    .sort(() => Math.random() - 0.5)
    .slice(0, MAX_PEERS_TO_ASK);

  const votes = [];
  await Promise.allSettled(sample.map(async peer => {
    try {
      const res = await peerRequest(peer.url, `api/peer/verify?url=${encodeURIComponent(url)}`);
      if (res.status === 200 && typeof res.body.reachable === 'boolean') {
        votes.push({ nodeId: peer.nodeId, reachable: res.body.reachable, latency: res.body.latencyMs, reputation: peer.reputation });
        recordPeerSuccess(peer.nodeId);
      }
    } catch { recordPeerFailure(peer.nodeId); }
  }));

  if (votes.length < MIN_PEERS_FOR_CONSENSUS) {
    return { consensus: null, reason: 'not_enough_responses', peers: votes, votes: {} };
  }

  // Weighted consensus
  let upWeight = 0, downWeight = 0;
  votes.forEach(v => {
    if (v.reachable) upWeight += v.reputation;
    else downWeight += v.reputation;
  });

  const totalWeight = upWeight + downWeight;
  const consensus = upWeight / totalWeight >= 0.5 ? 'up' : 'down';
  const confidence = Math.abs(upWeight - downWeight) / totalWeight;

  return {
    consensus,
    confidence: Math.round(confidence * 100),
    upVotes: votes.filter(v => v.reachable).length,
    downVotes: votes.filter(v => !v.reachable).length,
    totalPeersAsked: sample.length,
    totalPeersResponded: votes.length,
    peers: votes.map(v => ({
      nodeId: v.nodeId.slice(0, 8) + '…', // anonymize
      reachable: v.reachable,
      latency: v.latency,
    })),
    ts: Date.now(),
  };
}

// ─── Verify a URL from THIS node (called by peers) ────────────────
async function checkUrlReachable(url) {
  if (!isSafeVerifyUrl(url)) {
    return { reachable: false, error: 'URL not allowed', latencyMs: 0, nodeId: getNodeId() };
  }
  return new Promise(resolve => {
    const start = Date.now();
    try {
      const u = new URL(url);
      const lib = u.protocol === 'https:' ? https : http;
      const req = lib.request({
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname || '/',
        method: 'HEAD',
        timeout: VERIFY_TIMEOUT,
        headers: { 'User-Agent': 'StatusMon-Network/5.0' },
        rejectUnauthorized: false,
      }, res => {
        res.resume();
        resolve({
          reachable: res.statusCode < 500,
          statusCode: res.statusCode,
          latencyMs: Date.now() - start,
          nodeId: getNodeId(),
        });
      });
      req.on('timeout', () => { req.destroy(); resolve({ reachable: false, error: 'Timeout', latencyMs: VERIFY_TIMEOUT, nodeId: getNodeId() }); });
      req.on('error', e => resolve({ reachable: false, error: e.message, latencyMs: Date.now() - start, nodeId: getNodeId() }));
      req.end();
    } catch(e) {
      resolve({ reachable: false, error: e.message, latencyMs: 0, nodeId: getNodeId() });
    }
  });
}

module.exports = { verifyWithNetwork, checkUrlReachable };
