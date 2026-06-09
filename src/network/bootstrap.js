/**
 * network/bootstrap.js
 * Bootstrap server discovery and registration
 * Any node can become a bootstrap server by enabling it in config
 */

const { peerRequest, addOrUpdatePeer, getAllPeers, getActivePeers } = require('./peers');
const { getNodeId, getPublicKeyB64, signedMessage } = require('./crypto');

// Default bootstrap seeds — hardcoded as initial entry points
// More are discovered via gossip and saved locally
const DEFAULT_BOOTSTRAPS = [
  'https://status.uverse.es',
];

let _cfg = null; // reference to config loader
let _nodeUrl = null;

function init(configLoader, nodeUrl) {
  _cfg = configLoader;
  _nodeUrl = nodeUrl;
}

// ─── Discover peers from bootstrap servers ────────────────────────
async function discoverFromBootstrap(bootstrapUrl) {
  try {
    const res = await peerRequest(bootstrapUrl, 'statusmon/peers');
    if (res.status !== 200 || !Array.isArray(res.body)) return 0;
    let added = 0;
    res.body.forEach(p => {
      if (!p.nodeId || !p.url) return;
      addOrUpdatePeer({ ...p, isBootstrap: p.isBootstrap || false });
      added++;
    });
    return added;
  } catch { return 0; }
}

// Try all known bootstraps until one works
async function bootstrap() {
  const cfg = _cfg();
  const bootstraps = [
    ...DEFAULT_BOOTSTRAPS,
    ...(cfg.network?.extraBootstraps || []),
  ];

  // Also try peers we already know that are bootstraps
  const knownBootstraps = getAllPeers().filter(p => p.isBootstrap).map(p => p.url);
  const allBootstraps = [...new Set([...bootstraps, ...knownBootstraps])];

  let totalDiscovered = 0;
  for (const url of allBootstraps) {
    const n = await discoverFromBootstrap(url);
    totalDiscovered += n;
    if (n > 0) break; // found one that works, gossip will do the rest
  }
  return totalDiscovered;
}

// ─── Register self with bootstrap servers ────────────────────────
async function registerWithBootstrap(bootstrapUrl) {
  if (!_nodeUrl) return false;
  try {
    const payload = signedMessage({
      nodeId: getNodeId(),
      url: _nodeUrl,
      publicKey: getPublicKeyB64(),
      version: '5.0.0',
    });
    const res = await peerRequest(bootstrapUrl, 'statusmon/peers/register', {
      method: 'POST',
      body: payload,
    });
    return res.status === 200;
  } catch { return false; }
}

async function registerWithAllBootstraps() {
  const cfg = _cfg();
  const bootstraps = [
    ...DEFAULT_BOOTSTRAPS,
    ...(cfg.network?.extraBootstraps || []),
  ];
  const results = await Promise.allSettled(bootstraps.map(url => registerWithBootstrap(url)));
  return results.filter(r => r.status === 'fulfilled' && r.value).length;
}

// ─── Bootstrap server mode ────────────────────────────────────────
// In-memory registry for bootstrap mode (peers saved to disk via peers.js)
function getPublicPeerList() {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000; // active in last 24h
  return getActivePeers()
    .filter(p => p.lastSeen > cutoff)
    .map(p => ({
      nodeId: p.nodeId,
      url: p.url,
      publicKey: p.publicKey,
      isBootstrap: p.isBootstrap || false,
      version: p.version,
      region: p.region,
      reputation: Math.round(p.reputation * 100) / 100,
    }));
}

async function handleRegistration(payload) {
  // Verify signature
  const { verifyMessage } = require('./crypto');
  const { nodeId, url, publicKey, sig, ts } = payload;
  if (!nodeId || !url || !publicKey) return { error: 'Missing fields' };
  if (!verifyMessage(payload, publicKey)) return { error: 'Invalid signature' };

  // Verify the node is actually reachable at the claimed URL
  try {
    const res = await peerRequest(url, 'api/peer/info');
    if (res.status !== 200 || res.body.nodeId !== nodeId) {
      return { error: 'Node not reachable or nodeId mismatch' };
    }
  } catch {
    return { error: 'Node not reachable' };
  }

  addOrUpdatePeer({ nodeId, url, publicKey, isBootstrap: false, reputation: 0.1 });
  return { ok: true, nodeId };
}

module.exports = {
  init, bootstrap, registerWithBootstrap, registerWithAllBootstraps,
  getPublicPeerList, handleRegistration,
  DEFAULT_BOOTSTRAPS,
};
