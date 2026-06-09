/**
 * network/routes.js
 * Express routes for peer-to-peer network API
 * All /api/peer/* and /statusmon/* endpoints
 */

const { getNodeId, getPublicKeyB64, verifyMessage } = require('./crypto');
const { getAllPeers, getActivePeers, addOrUpdatePeer } = require('./peers');
const { getPublicPeerList, handleRegistration } = require('./bootstrap');
const { receiveHeartbeat } = require('./heartbeat');
const { checkUrlReachable, verifyWithNetwork } = require('./verify');

const APP_VERSION = '5.3.0';

// ─── Simple in-memory rate limiter for peer endpoints ────────────
// Keyed by IP: { count, resetAt }
const _peerRateLimits = {};
const PEER_RATE_WINDOW = 60 * 1000; // 1 min
const PEER_RATE_MAX    = 20;        // max requests per window

function peerRateLimit(req, res, next) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
  const now = Date.now();
  if (!_peerRateLimits[ip] || _peerRateLimits[ip].resetAt < now) {
    _peerRateLimits[ip] = { count: 0, resetAt: now + PEER_RATE_WINDOW };
  }
  _peerRateLimits[ip].count++;
  if (_peerRateLimits[ip].count > PEER_RATE_MAX) {
    return res.status(429).json({ error: 'Too many requests' });
  }
  next();
}

// ─── Hostname validation for trace (no shell injection) ──────────
const SAFE_HOSTNAME_RE = /^[a-zA-Z0-9.\-]{1,253}$/;

module.exports = function registerNetworkRoutes(app, configLoader, nodeUrl) {

  // ─── Public peer info ──────────────────────────────────────────
  app.get('/api/peer/info', (req, res) => {
    const cfg = configLoader();
    if (!cfg.network?.enabled) return res.status(503).json({ error: 'Network not enabled' });
    res.json({
      nodeId: getNodeId(),
      publicKey: getPublicKeyB64(),
      url: nodeUrl,
      version: APP_VERSION,
      isBootstrap: cfg.network?.isBootstrap || false,
      passive: !nodeUrl, // passive if no public URL
      uptime: process.uptime(),
    });
  });

  // ─── Peer list (gossip) ────────────────────────────────────────
  app.get('/api/peer/peers', (req, res) => {
    const cfg = configLoader();
    if (!cfg.network?.enabled) return res.status(503).json({ error: 'Network not enabled' });
    const peers = getActivePeers().map(p => ({
      nodeId: p.nodeId,
      url: p.url,
      publicKey: p.publicKey,
      isBootstrap: p.isBootstrap || false,
      version: p.version,
      reputation: Math.round((p.reputation || 0) * 100) / 100,
    }));
    res.json(peers);
  });

  // ─── Verify URL ────────────────────────────────────────────────
  app.get('/api/peer/verify', peerRateLimit, async (req, res) => {
    const cfg = configLoader();
    if (!cfg.network?.enabled) return res.status(503).json({ error: 'Network not enabled' });
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: 'url required' });
    // checkUrlReachable has its own SSRF guard (isSafeVerifyUrl)
    const result = await checkUrlReachable(url);
    res.json(result);
  });

  // ─── Traceroute ────────────────────────────────────────────────
  app.post('/api/peer/trace', peerRateLimit, async (req, res) => {
    const cfg = configLoader();
    if (!cfg.network?.enabled) return res.status(503).json({ error: 'Network not enabled' });
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'url required' });
    let hostname;
    try { hostname = new URL(url).hostname; } catch { return res.status(400).json({ error: 'Invalid URL' }); }
    // Validate hostname against allowlist pattern to prevent shell injection
    if (!SAFE_HOSTNAME_RE.test(hostname)) {
      return res.status(400).json({ error: 'Invalid hostname' });
    }
    try {
      const { execSync } = require('child_process');
      const cmd = (() => {
        try { execSync('which tracepath 2>/dev/null', { timeout: 1000 }); return `tracepath -n -m 15 ${hostname}`; } catch {}
        try { execSync('which traceroute 2>/dev/null', { timeout: 1000 }); return `traceroute -n -m 15 -w 2 ${hostname}`; } catch {}
        return null;
      })();
      if (!cmd) return res.json({ nodeId: getNodeId(), error: 'tracepath/traceroute not available', hops: [] });
      const out = execSync(cmd, { timeout: 20000, encoding: 'utf8' });
      const hops = out.split('\n').slice(1).filter(Boolean).map(line => {
        const m = line.match(/^\s*(\d+).*?([\d.]+)\s+([\d.]+)\s*ms/);
        return m ? { hop: parseInt(m[1]), ip: m[2], ms: parseFloat(m[3]) } : null;
      }).filter(Boolean);
      res.json({ nodeId: getNodeId(), hops, hostname });
    } catch(e) {
      res.json({ nodeId: getNodeId(), error: e.message.slice(0, 200), hops: [] });
    }
  });

  // ─── Heartbeat receive ─────────────────────────────────────────
  app.post('/api/peer/heartbeat', (req, res) => {
    const cfg = configLoader();
    if (!cfg.network?.enabled) return res.status(503).json({ error: 'Network not enabled' });
    const payload = req.body;
    if (!payload?.nodeId) return res.status(400).json({ error: 'Invalid payload' });
    // Verify signature if we know this peer's public key
    const ok = receiveHeartbeat(payload);
    res.json({ ok, nodeId: getNodeId() });
  });

  // ─── Network-level verification (used by dashboard) ───────────
  app.post('/api/network/verify/:siteId', async (req, res) => {
    const cfg = configLoader();
    if (!cfg.network?.enabled) return res.status(503).json({ error: 'Network not enabled' });
    const url = req.body.url;
    if (!url) return res.status(400).json({ error: 'url required' });
    const result = await verifyWithNetwork(url);
    res.json(result);
  });

  // ─── Network status (for settings panel) ──────────────────────
  app.get('/api/network/status', (req, res) => {
    const cfg = configLoader();
    const active = getActivePeers();
    res.json({
      enabled: cfg.network?.enabled || false,
      isBootstrap: cfg.network?.isBootstrap || false,
      nodeId: getNodeId(),
      publicKey: getPublicKeyB64(),
      nodeUrl: cfg.network?.nodeUrl || null,
      activePeers: active.length,
      totalPeers: getAllPeers().length,
      peers: active.slice(0, 10).map(p => ({
        nodeId: p.nodeId,
        url: p.url,
        reputation: Math.round((p.reputation || 0) * 100),
        lastSeen: p.lastSeen,
        version: p.version,
        isBootstrap: p.isBootstrap || false,
      })),
    });
  });

  // ─── Bootstrap server endpoints (public, no auth) ─────────────
  app.get('/statusmon/peers', (req, res) => {
    const cfg = configLoader();
    if (!cfg.network?.isBootstrap) return res.status(404).json({ error: 'Not a bootstrap server' });
    res.json(getPublicPeerList());
  });

  app.post('/statusmon/peers/register', async (req, res) => {
    const cfg = configLoader();
    if (!cfg.network?.isBootstrap) return res.status(404).json({ error: 'Not a bootstrap server' });
    const result = await handleRegistration(req.body);
    if (result.error) return res.status(400).json(result);
    res.json(result);
  });

  app.get('/statusmon/peers/health', (req, res) => {
    const cfg = configLoader();
    if (!cfg.network?.isBootstrap) return res.status(404).json({ error: 'Not a bootstrap server' });
    res.json({
      status: 'ok',
      nodeId: getNodeId(),
      activePeers: getPublicPeerList().length,
      uptime: process.uptime(),
      version: APP_VERSION,
    });
  });
};
