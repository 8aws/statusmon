/**
 * network/heartbeat.js
 * Send heartbeats to peers and detect offline nodes
 * Triggers emergency webhook via ntfy when a node goes offline
 */

const { getActivePeers, getPeer, recordPeerSuccess, recordPeerFailure, peerRequest, getVotingPeers } = require('./peers');
const { getNodeId, getPublicKeyB64, signedMessage, decryptWebhook } = require('./crypto');
const https = require('https');
const http = require('http');

const HEARTBEAT_INTERVAL = 5 * 60 * 1000; // 5 min
const OFFLINE_THRESHOLD = 3; // missed heartbeats before considered offline
const ALERT_COOLDOWN = 30 * 60 * 1000; // don't re-alert within 30 min

let _cfg = null;
let _nodeUrl = null;
let heartbeatTimer = null;
const missedHeartbeats = {}; // { nodeId: count }
const lastAlert = {}; // { nodeId: timestamp }

function init(configLoader, nodeUrl) {
  _cfg = configLoader;
  _nodeUrl = nodeUrl;
}

// ─── Send heartbeat to all active peers ───────────────────────────
async function sendHeartbeats() {
  const cfg = _cfg();
  if (!cfg.network?.enabled) return;

  const peers = getActivePeers();
  const payload = signedMessage({
    type: 'heartbeat',
    nodeId: getNodeId(),
    url: _nodeUrl,
    publicKey: getPublicKeyB64(),
    version: '5.0.0',
  });

  for (const peer of peers) {
    try {
      const res = await peerRequest(peer.url, 'api/peer/heartbeat', {
        method: 'POST',
        body: payload,
      });
      if (res.status === 200) {
        recordPeerSuccess(peer.nodeId);
        missedHeartbeats[peer.nodeId] = 0;
      } else {
        handleMissedHeartbeat(peer);
      }
    } catch {
      handleMissedHeartbeat(peer);
    }
  }
}

function handleMissedHeartbeat(peer) {
  recordPeerFailure(peer.nodeId);
  missedHeartbeats[peer.nodeId] = (missedHeartbeats[peer.nodeId] || 0) + 1;

  if (missedHeartbeats[peer.nodeId] >= OFFLINE_THRESHOLD) {
    checkAndAlertOfflinePeer(peer);
  }
}

// ─── Detect offline peer and alert ────────────────────────────────
async function checkAndAlertOfflinePeer(peer) {
  // Cooldown check
  if (lastAlert[peer.nodeId] && Date.now() - lastAlert[peer.nodeId] < ALERT_COOLDOWN) return;

  // Verify consensus — ask other peers if they also see this node as offline
  const votingPeers = getVotingPeers().filter(p => p.nodeId !== peer.nodeId);
  if (votingPeers.length < 2) return; // need at least 2 other nodes to confirm

  let offlineVotes = 0;
  const samplePeers = votingPeers.slice(0, 4);

  for (const vp of samplePeers) {
    try {
      const res = await peerRequest(vp.url, `api/peer/verify?url=${encodeURIComponent(peer.url + '/api/peer/info')}`);
      if (res.status === 200 && res.body.reachable === false) offlineVotes++;
    } catch {}
  }

  // Need majority consensus (>50% of asked peers agree it's offline)
  if (offlineVotes < Math.ceil(samplePeers.length / 2)) return;

  // Confirmed offline — trigger emergency webhook if configured
  lastAlert[peer.nodeId] = Date.now();
  missedHeartbeats[peer.nodeId] = 0; // reset to avoid spam

  if (peer.encryptedWebhook) {
    await sendEmergencyAlert(peer);
  }
}

async function sendEmergencyAlert(peer) {
  try {
    // Decrypt the webhook URL using our secret key + peer's encrypted blob
    const webhookUrl = decryptWebhook(peer.encryptedWebhook);
    const minutesOffline = Math.round(HEARTBEAT_INTERVAL * OFFLINE_THRESHOLD / 60000);
    const message = `⚠️ Tu nodo StatusMon en ${peer.url} lleva al menos ${minutesOffline} minutos offline. Verificado por consenso de nodos externos.`;

    // Detect webhook type from URL
    if (webhookUrl.includes('ntfy.sh')) {
      await sendNtfy(webhookUrl, message);
    } else if (webhookUrl.includes('discord.com/api/webhooks')) {
      await sendDiscordWebhook(webhookUrl, message);
    } else if (webhookUrl.includes('api.telegram.org')) {
      // Telegram: url format = https://api.telegram.org/botTOKEN/sendMessage?chat_id=CHATID
      await sendGenericWebhook(webhookUrl, { text: message });
    } else {
      await sendGenericWebhook(webhookUrl, {
        event: 'node_offline',
        nodeId: peer.nodeId,
        url: peer.url,
        message,
        ts: Date.now(),
      });
    }
    console.log(`Emergency alert sent for offline node: ${peer.nodeId}`);
  } catch(e) {
    console.warn(`Failed to send emergency alert for ${peer.nodeId}:`, e.message);
  }
}

async function sendNtfy(url, message) {
  return sendGenericPost(url, message, { 'Content-Type': 'text/plain' });
}

async function sendDiscordWebhook(url, message) {
  return sendGenericPost(url, JSON.stringify({ content: message }), { 'Content-Type': 'application/json' });
}

async function sendGenericWebhook(url, body) {
  return sendGenericPost(url, JSON.stringify(body), { 'Content-Type': 'application/json' });
}

function sendGenericPost(url, body, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const bodyBuf = Buffer.from(body);
    const req = lib.request({
      hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search, method: 'POST',
      headers: { ...headers, 'Content-Length': bodyBuf.length },
      timeout: 10000,
    }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.write(bodyBuf); req.end();
  });
}

// ─── Receive heartbeat from peer ──────────────────────────────────
function receiveHeartbeat(payload) {
  const { nodeId, url, publicKey, version } = payload;
  if (!nodeId || !url) return false;
  const { addOrUpdatePeer } = require('./peers');
  addOrUpdatePeer({ nodeId, url, publicKey, version, lastHeartbeat: Date.now() });
  missedHeartbeats[nodeId] = 0;
  return true;
}

// ─── Schedule ─────────────────────────────────────────────────────
function start() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(sendHeartbeats, HEARTBEAT_INTERVAL);
  sendHeartbeats(); // immediate first run
}

function stop() {
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
}

module.exports = { init, start, stop, receiveHeartbeat, sendEmergencyAlert };
