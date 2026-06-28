const express = require('express');
const https = require('https');
const http = require('http');
const net = require('net');
const tls = require('tls');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const crypto = require('crypto');
const zlib = require('zlib');

// ─── Pure-Node ZIP writer (no external `zip` binary needed) ───────
const _CRC32_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c;
  }
  return t;
})();
function _crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) crc = _CRC32_TABLE[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}
function buildZipBuffer(entries) {
  // entries: [{name: string, data: Buffer}]
  const local = [];
  const cd = [];
  let offset = 0;
  const now = new Date();
  const dosDate = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xFFFF;
  const dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xFFFF;
  for (const { name, data } of entries) {
    const nb = Buffer.from(name, 'utf8');
    const comp = zlib.deflateRawSync(data, { level: 6 });
    const crc  = _crc32(data);
    // Local file header
    const lh = Buffer.alloc(30 + nb.length);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0, 6);
    lh.writeUInt16LE(8, 8); lh.writeUInt16LE(dosTime, 10); lh.writeUInt16LE(dosDate, 12);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nb.length, 26); lh.writeUInt16LE(0, 28); nb.copy(lh, 30);
    // Central directory entry
    const ce = Buffer.alloc(46 + nb.length);
    ce.writeUInt32LE(0x02014b50, 0); ce.writeUInt16LE(20, 4); ce.writeUInt16LE(20, 6);
    ce.writeUInt16LE(0, 8); ce.writeUInt16LE(8, 10); ce.writeUInt16LE(dosTime, 12);
    ce.writeUInt16LE(dosDate, 14); ce.writeUInt32LE(crc, 16); ce.writeUInt32LE(comp.length, 20);
    ce.writeUInt32LE(data.length, 24); ce.writeUInt16LE(nb.length, 28); ce.writeUInt16LE(0, 30);
    ce.writeUInt16LE(0, 32); ce.writeUInt16LE(0, 34); ce.writeUInt16LE(0, 36);
    ce.writeUInt32LE(0, 38); ce.writeUInt32LE(offset, 42); nb.copy(ce, 46);
    local.push(lh, comp);
    cd.push(ce);
    offset += lh.length + comp.length;
  }
  const cdBuf = Buffer.concat(cd);
  const eocd  = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(0, 4); eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12); eocd.writeUInt32LE(offset, 16); eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...local, cdBuf, eocd]);
}
// ──────────────────────────────────────────────────────────────────
const nodemailer = require('nodemailer');

const APP_VERSION = '5.8.0';
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const netCrypto = require('./network/crypto');
const netPeers = require('./network/peers');
const netBootstrap = require('./network/bootstrap');
const netHeartbeat = require('./network/heartbeat');
const netVerify = require('./network/verify');
const registerNetworkRoutes = require('./network/routes');
let push = null;
try { push = require('./push'); } catch(e) { console.warn('Push module unavailable:', e.message); }
const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || '/data';
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const SITES_FILE = path.join(DATA_DIR, 'sites.json');
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');
const METRICS_FILE = path.join(DATA_DIR, 'metrics.json');
// BACKUPS_DIR defaults INSIDE /data for backwards compat, but should point to a
// SEPARATE host volume so a loss/corruption of /data doesn't take backups with it.
// Override with BACKUPS_DIR env (e.g. a second bind-mount like /opt/statusmon/backups).
const BACKUPS_DIR   = process.env.BACKUPS_DIR || path.join(DATA_DIR, 'backups');
const FAVICONS_DIR  = path.join(DATA_DIR, 'favicons');
const RELEASES_DIR  = path.join(DATA_DIR, 'releases');

// ─── Crash-safe writes ────────────────────────────────────────────
// fs.writeFileSync truncates-in-place with no fsync: on a power loss the
// journaling FS commonly leaves the target at 0 bytes. Write to a temp file,
// fsync it, then atomically rename over the target so a crash never leaves a
// half-written or empty file in place.
function atomicWriteFileSync(file, data) {
  const tmp = `${file}.tmp-${process.pid}`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, data);
    fs.fsyncSync(fd);          // flush file contents to disk
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);    // atomic on the same filesystem
  // fsync the directory so the rename itself is durable
  try {
    const dfd = fs.openSync(path.dirname(file), 'r');
    try { fs.fsyncSync(dfd); } finally { fs.closeSync(dfd); }
  } catch { /* some platforms disallow dir fsync; rename is still atomic */ }
}

// Try to recover a data file (by basename, e.g. 'sites.json') from the most
// recent backup that contains a valid, non-empty copy. Returns the parsed
// object or null. Used when the live file is found corrupt/empty after a crash.
function recoverFromBackup(basename) {
  try {
    if (!fs.existsSync(BACKUPS_DIR)) return null;
    const dirs = fs.readdirSync(BACKUPS_DIR)
      .filter(d => { try { return fs.statSync(path.join(BACKUPS_DIR, d)).isDirectory(); } catch { return false; } })
      .sort().reverse();   // newest first (timestamped names sort lexicographically)
    for (const d of dirs) {
      const f = path.join(BACKUPS_DIR, d, basename);
      try {
        const raw = fs.readFileSync(f, 'utf8');
        if (!raw.trim()) continue;
        return { data: JSON.parse(raw), from: d };
      } catch { continue; }
    }
  } catch { /* fall through */ }
  return null;
}

// Move a corrupt file aside (once) so it's preserved for inspection and never
// silently overwritten with defaults.
function preserveCorrupt(file) {
  try {
    if (fs.existsSync(file)) {
      const aside = `${file}.corrupt-${Date.now()}`;
      fs.copyFileSync(file, aside);
      console.error(`[data] preserved corrupt file → ${aside}`);
    }
  } catch { /* best effort */ }
}

app.use(express.json());
app.use(express.static(path.join(__dirname, '../public'), { index: false }));

// Auth middleware for all /api/* except public endpoints
app.use('/api', (req, res, next) => {
  const PUBLIC = ['/api/auth/login', '/api/auth/status', '/api/auth/password', '/api/version', '/api/health', '/api/time', '/api/detect-url', '/api/status/public', '/api/peer/', '/statusmon/', '/badge/', '/api/releases', '/api/about', '/api/network/stats', '/api/network/map', '/api/status-theme', '/api/push/vapid-key', '/api/heartbeat/'];
  const isCSV = req.path.endsWith('/csv');
  const isFavicon = /^\/sites\/[^/]+\/favicon$/.test(req.path);
  if (PUBLIC.some(p => req.path.startsWith(p.replace('/api',''))) || isCSV || isFavicon) return next();
  return requireAuth(req, res, next);
});

// ─── Ensure data dir ──────────────────────────────────────────────
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(RELEASES_DIR, { recursive: true });

// ─── Migrate ZIPs from old public/releases/ → RELEASES_DIR (one-time) ──────
(function migrateOldReleases() {
  const oldDir = path.join(__dirname, '../public/releases');
  if (!fs.existsSync(oldDir)) return;
  try {
    fs.readdirSync(oldDir)
      .filter(f => f.endsWith('.zip') && f.startsWith('statusmon-'))
      .forEach(f => {
        const dest = path.join(RELEASES_DIR, f);
        if (!fs.existsSync(dest)) {
          fs.copyFileSync(path.join(oldDir, f), dest);
          console.log(`[releases] Migrado desde public/releases/: ${f}`);
        }
      });
  } catch(e) { console.warn('[releases] Migración old releases fallida:', e.message); }
})();



// ─── Continent detection via ipwho.is (free, no key needed) ─────
const CONTINENT_CODES = {
  'Europe':'EU','Asia':'AS','North America':'NA',
  'South America':'SA','Africa':'AF','Oceania':'OC',
};

async function detectContinentFromIP(ip) {
  if (!ip || ip === '127.0.0.1' || ip.startsWith('192.168.') || ip.startsWith('10.') || ip.startsWith('172.')) return null;
  try {
    const https = require('https');
    const data = await new Promise((resolve, reject) => {
      const req = https.get(`https://ipwho.is/${ip}`, { timeout: 5000 }, res => {
        let body = '';
        res.on('data', c => body += c);
        res.on('end', () => { try { resolve(JSON.parse(body)); } catch { reject(new Error('parse')); } });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    });
    if (data.success && data.continent) {
      return CONTINENT_CODES[data.continent] || 'EU';
    }
  } catch {}
  return null;
}

// Auto-detect continent at startup and save to config if not set
async function autoDetectContinent() {
  const cfg = loadConfig();
  if (cfg.network?.continent) return; // already configured manually
  // Get our own public IP from proxy headers — not available at startup, try external
  try {
    const https = require('https');
    const ipData = await new Promise((resolve, reject) => {
      const req = https.get('https://ipwho.is/', { timeout: 5000 }, res => {
        let body = '';
        res.on('data', c => body += c);
        res.on('end', () => { try { resolve(JSON.parse(body)); } catch { reject(); } });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(); });
    });
    if (ipData.success && ipData.continent) {
      const continent = CONTINENT_CODES[ipData.continent] || 'EU';
      const updated = { ...cfg, network: { ...(cfg.network||{}), continent } };
      saveConfig(updated);
      console.log(`Continent auto-detected: ${ipData.continent} (${continent}) from ${ipData.ip}`);
    }
  } catch {
    console.log('Continent auto-detection failed — defaulting to EU');
  }
}

// ─── Network init (runs after DATA_DIR is ready) ──────────────────
function initNetwork() {
  const cfg = loadConfig();
  if (!cfg.network?.enabled) return;
  netCrypto.loadOrCreateKeypair(DATA_DIR);
  netPeers.init(DATA_DIR, loadConfig);
  const nodeUrl = cfg.network?.nodeUrl || '';
  netBootstrap.init(loadConfig, nodeUrl);
  netHeartbeat.init(loadConfig, nodeUrl);
  // Bootstrap discovery
  netBootstrap.bootstrap().then(n => {
    if (n > 0) console.log(`Network: discovered ${n} peers`);
    if (nodeUrl) netBootstrap.registerWithAllBootstraps();
  });
  // Start heartbeat
  netHeartbeat.start();
  console.log(`Network node ID: ${netCrypto.getNodeId()}`);
}

// ─── Encryption (AES-256-GCM) ─────────────────────────────────────
const SECRET_FILE = path.join(DATA_DIR, '.secret');

function getEncryptionKey() {
  if (!fs.existsSync(SECRET_FILE)) {
    // Nuevo formato: "secret:salt" — ambos aleatorios
    const secret = crypto.randomBytes(32).toString('hex');
    const salt   = crypto.randomBytes(16).toString('hex');
    fs.writeFileSync(SECRET_FILE, `${secret}:${salt}`, { mode: 0o600 });
  }
  const raw = fs.readFileSync(SECRET_FILE, 'utf8').trim();
  const [secret, salt] = raw.includes(':') ? raw.split(':') : [raw, 'statusmon-salt'];
  return crypto.scryptSync(secret, salt, 32);
}

function encrypt(text) {
  if (!text) return '';
  try {
    const key = getEncryptionKey();
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, encrypted]).toString('base64');
  } catch { return ''; }
}

function decrypt(enc) {
  if (!enc) return '';
  try {
    const key = getEncryptionKey();
    const buf = Buffer.from(enc, 'base64');
    const iv = buf.slice(0, 16);
    const tag = buf.slice(16, 32);
    const encrypted = buf.slice(32);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return decipher.update(encrypted) + decipher.final('utf8');
  } catch { return ''; }
}

const PASS_PLACEHOLDER = '••••••••';

// ─── Auth system ──────────────────────────────────────────────────
const JWT_SECRET_FILE = path.join(DATA_DIR, '.jwtsecret');
function getJwtSecret() {
  if (!fs.existsSync(JWT_SECRET_FILE)) {
    const s = crypto.randomBytes(64).toString('hex');
    fs.writeFileSync(JWT_SECRET_FILE, s, { mode: 0o600 });
  }
  return fs.readFileSync(JWT_SECRET_FILE, 'utf8').trim();
}

// Brute force protection
const loginAttempts = {}; // { ip: { count, lockedUntil } }
const MAX_ATTEMPTS = 5;
const LOCK_DURATION = 15 * 60 * 1000; // 15 min

function checkBruteForce(ip) {
  const now = Date.now();
  if (!loginAttempts[ip]) loginAttempts[ip] = { count: 0, lockedUntil: 0 };
  const a = loginAttempts[ip];
  if (a.lockedUntil > now) {
    return { locked: true, remaining: Math.ceil((a.lockedUntil - now) / 1000) };
  }
  if (a.lockedUntil && a.lockedUntil < now) {
    a.count = 0; a.lockedUntil = 0;
  }
  return { locked: false, count: a.count };
}

function recordFailedAttempt(ip) {
  if (!loginAttempts[ip]) loginAttempts[ip] = { count: 0, lockedUntil: 0 };
  loginAttempts[ip].count++;
  if (loginAttempts[ip].count >= MAX_ATTEMPTS) {
    loginAttempts[ip].lockedUntil = Date.now() + LOCK_DURATION;
  }
}

function resetAttempts(ip) {
  delete loginAttempts[ip];
}

// Auth middleware — skips if auth not configured
function requireAuth(req, res, next) {
  const cfg = loadConfig();
  if (!cfg.auth?.enabled || !cfg.auth?.passwordHash) return next();
  const token = req.headers.authorization?.replace('Bearer ', '') || req.cookies?.token;
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    jwt.verify(token, getJwtSecret());
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// Simple cookie parser (no dep)
app.use((req, res, next) => {
  req.cookies = {};
  const c = req.headers.cookie;
  if (c) c.split(';').forEach(p => {
    const [k, v] = p.trim().split('=');
    req.cookies[k] = decodeURIComponent(v || '');
  });
  next();
});

// ─── Config (dynamic, no restart needed) ─────────────────────────
const DEFAULT_CONFIG = {
  checkInterval: 60,       // seconds
  maxHistory: 10080,  // 7 días a 1 check/min
  defaultTimeout: 10000,   // ms — timeout por defecto de cada check
  maintenanceMode: false,  // silences all alerts globally
  alertAfterChecks: 2,     // notify after X consecutive failed checks
  nasRefreshInterval: 30,  // seconds between NAS stats cache refresh
  historyFlushMode: 'shutdown', // 'shutdown' | '5min' | '30min' | 'everycheck'
  peersMemoryOnly: true,        // peers.json only written on shutdown
  auth: {
    enabled: false,
    passwordHash: '',
    jwtExpiry: '24h',
  },
  network: {
    enabled: false,          // opt-in
    nodeUrl: '',             // public URL of this node (e.g. https://status.tudominio.com)
    isBootstrap: false,      // serve as bootstrap server
    emergencyWebhook: '',    // ntfy/discord/etc URL for offline alerts (stored encrypted)
    extraBootstraps: [],     // additional bootstrap servers
    maintenanceMode: false,  // announce to peers that we're in maintenance
  },
  sslWarnDays: 30,      // alert when SSL cert expires in ≤ N days
  sslCriticalDays: 7,  // critical alert when ≤ N days
  metricsInterval: 60,      // seconds between host metrics samples
  metricsMaxHistory: 1440,  // max entries in memory (1440 × 60s = 24h)
  dockerCleanupInterval: 0, // days between auto Docker cleanup (0 = disabled)
  lastDockerCleanup: null,
  autoBackupInterval: 7,   // days between automatic backups (0 = disabled) — semanal
  safetyFlushHours: 24,    // force-write history+metrics to disk every N hours (0 = disabled)
  smtp: {
    enabled: false,
    method: 'smtp',          // smtp | direct | gmail | outlook | yahoo | icloud
    host: '', port: 587, secure: false,
    user: '', pass: '',
    from: '', to: ''
  },
  webhook: {
    enabled: false,
    url: '',               // global webhook URL
    type: 'discord',       // discord | slack | telegram | generic
    telegramChatId: ''
  }
};

let _configRecoveryDone = false;
function loadConfig() {
  if (!fs.existsSync(CONFIG_FILE)) {
    atomicWriteFileSync(CONFIG_FILE, JSON.stringify(DEFAULT_CONFIG, null, 2));
    return { ...DEFAULT_CONFIG };
  }
  let source = null;
  try {
    const txt = fs.readFileSync(CONFIG_FILE, 'utf8');
    if (!txt.trim()) throw new Error('config.json is empty');
    source = JSON.parse(txt);
  } catch (e) {
    // File exists but is unreadable (e.g. truncated to 0 bytes by a power loss).
    // Try to recover from a backup before falling back to defaults, and never
    // overwrite the corrupt file with defaults — preserve it for inspection.
    if (!_configRecoveryDone) {
      _configRecoveryDone = true;
      console.error(`[data] config.json unreadable (${e.message}); attempting recovery`);
      preserveCorrupt(CONFIG_FILE);
      const rec = recoverFromBackup('config.json');
      if (rec) {
        console.error(`[data] recovered config.json from backup ${rec.from}`);
        try { atomicWriteFileSync(CONFIG_FILE, JSON.stringify(rec.data, null, 2)); } catch {}
        source = rec.data;
      } else {
        console.error('[data] no backup for config.json; using defaults (NOT overwriting corrupt file)');
      }
    }
    if (!source) return { ...DEFAULT_CONFIG };
  }
  const raw = { ...DEFAULT_CONFIG, ...source };
  // Decrypt password in memory — never expose encrypted blob outside server
  if (raw.smtp && raw.smtp.pass && raw.smtp.pass !== '') {
    try { raw.smtp.pass = decrypt(raw.smtp.pass); } catch {}
  }
  return raw;
}
function saveConfig(c) {
  const toSave = { ...c };
  if (toSave.smtp && toSave.smtp.pass) {
    toSave.smtp = { ...toSave.smtp, pass: encrypt(toSave.smtp.pass) };
  }
  atomicWriteFileSync(CONFIG_FILE, JSON.stringify(toSave, null, 2));
}

// ─── Sites ────────────────────────────────────────────────────────
let _lastGoodSites = null;       // last successfully parsed sites (in-memory safety net)
let _sitesRecoveryDone = false;
function loadSites() {
  if (!fs.existsSync(SITES_FILE)) {
    const defaults = { sites: [{ id: '1', name: 'Example', url: 'https://example.com', timeout: 10000, tags: [], paused: false }] };
    atomicWriteFileSync(SITES_FILE, JSON.stringify(defaults, null, 2));
    _lastGoodSites = defaults;
    return defaults;
  }
  try {
    const txt = fs.readFileSync(SITES_FILE, 'utf8');
    if (!txt.trim()) throw new Error('sites.json is empty');
    const parsed = JSON.parse(txt);
    if (!parsed || !Array.isArray(parsed.sites)) throw new Error('sites.json malformed');
    _lastGoodSites = parsed;
    return parsed;
  } catch (e) {
    // Corrupt/empty after a crash. Recover from backup if possible; otherwise
    // fall back to last-good (or empty) WITHOUT overwriting the corrupt file,
    // so manual recovery stays possible. Only run recovery once to avoid spam.
    if (!_sitesRecoveryDone) {
      _sitesRecoveryDone = true;
      console.error(`[data] sites.json unreadable (${e.message}); attempting recovery`);
      preserveCorrupt(SITES_FILE);
      const rec = recoverFromBackup('sites.json');
      if (rec && rec.data && Array.isArray(rec.data.sites)) {
        console.error(`[data] recovered sites.json from backup ${rec.from} (${rec.data.sites.length} sites)`);
        try { atomicWriteFileSync(SITES_FILE, JSON.stringify(rec.data, null, 2)); } catch {}
        _lastGoodSites = rec.data;
        return rec.data;
      }
      console.error('[data] no backup for sites.json; serving empty list (NOT overwriting corrupt file)');
    }
    return _lastGoodSites || { sites: [] };
  }
}
function saveSites(s) { atomicWriteFileSync(SITES_FILE, JSON.stringify(s, null, 2)); }

// Normaliza la URL introducida por el usuario antes de guardarla, para que un
// hostname suelto (p.ej. "www.uverse.es") no quede como URL inválida y pueda
// llegar a tumbar la app al arrancar. Añade esquema si falta y valida.
// Devuelve la URL normalizada, o null si es irrecuperablemente inválida.
function normalizeUrl(raw) {
  if (typeof raw !== 'string') return null;
  const u = raw.trim();
  if (!u) return null;
  // Esquemas especiales de la app (tcp/ssl/dns/heartbeat): preservar tal cual,
  // cada uno se valida en su propio tipo de check.
  if (/^(tcp|ssl|dns|heartbeat):/i.test(u)) return u;
  // http/https explícito: validar que tenga host.
  if (/^https?:\/\//i.test(u)) {
    try { return new URL(u).hostname ? u : null; } catch { return null; }
  }
  // Sin esquema reconocido → asumir https:// (cubre "www.uverse.es",
  // "localhost:3000", "1.2.3.4:8080", etc.).
  try { return new URL('https://' + u).hostname ? 'https://' + u : null; } catch { return null; }
}

// ─── History ──────────────────────────────────────────────────────
function loadHistory() {
  if (!fs.existsSync(HISTORY_FILE)) return {};
  try {
    const txt = fs.readFileSync(HISTORY_FILE, 'utf8');
    if (!txt.trim()) throw new Error('history.json is empty');
    return JSON.parse(txt);
  } catch (e) {
    console.error(`[data] history.json unreadable (${e.message}); attempting recovery`);
    preserveCorrupt(HISTORY_FILE);
    const rec = recoverFromBackup('history.json');
    if (rec && rec.data && typeof rec.data === 'object') {
      console.error(`[data] recovered history.json from backup ${rec.from}`);
      return rec.data;
    }
    return {};
  }
}
// ─── Smart history writes ─────────────────────────────────────────
let _historyDirty = false;
let _historyFlushTimer = null;
const _lastEntryKey = {}; // { siteId: { up, responseTime } }

function shouldRecordEntry(siteId, entry) {
  const last = _lastEntryKey[siteId];
  if (!last) return true;                          // first entry always
  if (entry.up !== last.up) return true;           // state change always
  if (!entry.up) return true;                      // down state always
  if (!last.responseTime || !entry.responseTime) return true;
  const change = Math.abs(entry.responseTime - last.responseTime) / last.responseTime;
  return change > 0.10;                            // >10% variation
}

function saveHistory(h) { atomicWriteFileSync(HISTORY_FILE, JSON.stringify(h)); }

function markHistoryDirty() {
  _historyDirty = true;
  const mode = loadConfig().historyFlushMode || 'shutdown';
  if (mode === 'everycheck') {
    flushHistoryNow();
    return;
  }
  if (mode === 'shutdown') return; // only flush on exit
  const ms = mode === '5min' ? 5 * 60 * 1000 : 30 * 60 * 1000;
  if (!_historyFlushTimer) {
    _historyFlushTimer = setTimeout(() => {
      if (_historyDirty) { saveHistory(history); _historyDirty = false; }
      _historyFlushTimer = null;
    }, ms);
  }
}

function flushHistoryNow() {
  if (_historyFlushTimer) { clearTimeout(_historyFlushTimer); _historyFlushTimer = null; }
  saveHistory(history); _historyDirty = false;
}

// ─── SSL ──────────────────────────────────────────────────────────
function getSSLExpiry(hostname, port) {
  return new Promise((resolve) => {
    try {
      const socket = tls.connect({ host: hostname, port: port || 443, servername: hostname, rejectUnauthorized: false, timeout: 5000 }, () => {
        try {
          const cert = socket.getPeerCertificate();
          socket.destroy();
          if (!cert || !cert.valid_to) return resolve(null);
          const expiry = new Date(cert.valid_to).getTime();
          resolve({ expiry, daysLeft: Math.round((expiry - Date.now()) / 86400000), subject: cert.subject?.CN || null, issuer: cert.issuer?.O || null });
        } catch { resolve(null); }
      });
      socket.on('error', () => resolve(null));
      socket.setTimeout(5000, () => { socket.destroy(); resolve(null); });
    } catch { resolve(null); }
  });
}

// ─── Stack detection ──────────────────────────────────────────────
function detectStack(headers) {
  const h = Object.fromEntries(Object.entries(headers).map(([k,v])=>[k.toLowerCase(),v]));
  const server = h['server'] || '', powered = h['x-powered-by'] || '', via = h['via'] || '';
  const clues = [];
  if (/nginx/i.test(server)) clues.push('nginx');
  else if (/apache/i.test(server)) clues.push('Apache');
  else if (/caddy/i.test(server)) clues.push('Caddy');
  else if (/iis/i.test(server)) clues.push('IIS');
  else if (/lighttpd/i.test(server)) clues.push('lighttpd');
  else if (/openresty/i.test(server)) clues.push('OpenResty');
  else if (server) clues.push(server.split('/')[0]);
  if (/php/i.test(powered)) clues.push(`PHP${powered.match(/php\/([\d.]+)/i)?.[1]?' '+powered.match(/php\/([\d.]+)/i)[1]:''}`);
  if (/express/i.test(powered)) clues.push('Express');
  if (/next\.js/i.test(powered)) clues.push('Next.js');
  if (/asp\.net/i.test(powered)) clues.push('ASP.NET');
  if (/java/i.test(powered)||/tomcat/i.test(server)||/jetty/i.test(server)) clues.push('Java');
  if (/python/i.test(powered)||/gunicorn/i.test(server)||/uvicorn/i.test(server)) clues.push('Python');
  if (/ruby/i.test(powered)||/passenger/i.test(server)) clues.push('Ruby');
  if (h['x-pingback']||h['x-wp-total']) clues.push('WordPress');
  if (h['cf-ray']) clues.push('Cloudflare');
  if (h['x-vercel-id']) clues.push('Vercel');
  if (h['x-amz-cf-id']||h['x-amz-request-id']) clues.push('AWS');
  if (/varnish/i.test(h['x-cache']||'')||/varnish/i.test(via)) clues.push('Varnish');
  const enc = h['content-encoding']||'';
  if (/br/.test(enc)) clues.push('Brotli');
  else if (/gzip/.test(enc)) clues.push('gzip');
  const cc = h['cache-control']||'';
  const cacheInfo = [];
  if (/no-store/.test(cc)) cacheInfo.push('no-store');
  else if (/no-cache/.test(cc)) cacheInfo.push('no-cache');
  else if (/max-age=(\d+)/.test(cc)) {
    const s = parseInt(cc.match(/max-age=(\d+)/)[1]);
    cacheInfo.push(`max-age ${s>=86400?Math.round(s/86400)+'d':s>=3600?Math.round(s/3600)+'h':s+'s'}`);
  }
  return {
    clues: [...new Set(clues)], server: server||null, poweredBy: powered||null,
    contentType: (h['content-type']||'').split(';')[0].trim()||null,
    encoding: enc||null, cacheControl: cc||null, cacheInfo,
    contentLength: headers['content-length']?parseInt(headers['content-length']):null,
    xCache: h['x-cache']||null,
    xCacheStatus: h['x-cache-status']||null,
    cfRay: h['cf-ray']||null,
    age: h['age']!=null?parseInt(h['age']):null,
    via: h['via']||null,
    strictTransport: !!h['strict-transport-security'],
    xFrameOptions: h['x-frame-options']||null,
    xContentTypeOptions: h['x-content-type-options']||null,
    contentSecurityPolicy: !!h['content-security-policy'],
    referrerPolicy: !!h['referrer-policy'],
    securityScore: [!!h['strict-transport-security'],!!h['x-frame-options'],!!h['x-content-type-options'],!!h['content-security-policy'],!!h['referrer-policy']].filter(Boolean).length,
  };
}

// ─── TCP check ────────────────────────────────────────────────────
function checkTcp(site) {
  return new Promise((resolve) => {
    const url = new URL(site.url); // tcp://hostname:port
    const host = url.hostname;
    const port = parseInt(url.port) || 80;
    const timeout = site.timeout || loadConfig().defaultTimeout || 10000;
    const start = Date.now();
    const socket = new net.Socket();
    socket.setTimeout(timeout);
    socket.connect(port, host, () => {
      const responseTime = Date.now() - start;
      socket.destroy();
      resolve({ up: true, responseTime, ttfb: responseTime, statusCode: null, error: null, bodySize: null, stack: null, ssl: null, checkType: 'tcp' });
    });
    socket.on('timeout', () => {
      socket.destroy();
      resolve({ up: false, responseTime: timeout, ttfb: null, statusCode: null, error: 'Timeout', bodySize: null, stack: null, ssl: null, checkType: 'tcp' });
    });
    socket.on('error', (e) => {
      resolve({ up: false, responseTime: Date.now() - start, ttfb: null, statusCode: null, error: e.message, bodySize: null, stack: null, ssl: null, checkType: 'tcp' });
    });
  });
}

// ─── SSL independent check ────────────────────────────────────────
function checkSslSite(site) {
  return new Promise((resolve) => {
    const url = new URL(site.url); // ssl://hostname or ssl://hostname:port
    const host = url.hostname;
    const port = parseInt(url.port) || 443;
    const timeout = site.timeout || loadConfig().defaultTimeout || 10000;
    const start = Date.now();
    try {
      const socket = tls.connect({ host, port, servername: host, rejectUnauthorized: false, timeout }, () => {
        try {
          const cert = socket.getPeerCertificate();
          const responseTime = Date.now() - start;
          socket.destroy();
          if (!cert || !cert.valid_to) {
            return resolve({ up: false, responseTime, ttfb: null, statusCode: null, error: 'No certificate returned', bodySize: null, stack: null, ssl: null, checkType: 'ssl' });
          }
          const expiry = new Date(cert.valid_to).getTime();
          const daysLeft = Math.round((expiry - Date.now()) / 86400000);
          const ssl = { expiry, daysLeft, subject: cert.subject?.CN || null, issuer: cert.issuer?.O || null };
          const up = daysLeft > 0;
          resolve({ up, responseTime, ttfb: responseTime, statusCode: null, error: up ? null : 'Certificate expired', bodySize: null, stack: null, ssl, checkType: 'ssl' });
        } catch(e) {
          socket.destroy();
          resolve({ up: false, responseTime: Date.now() - start, ttfb: null, statusCode: null, error: e.message, bodySize: null, stack: null, ssl: null, checkType: 'ssl' });
        }
      });
      socket.on('error', (e) => {
        resolve({ up: false, responseTime: Date.now() - start, ttfb: null, statusCode: null, error: e.message, bodySize: null, stack: null, ssl: null, checkType: 'ssl' });
      });
      socket.setTimeout(timeout, () => {
        socket.destroy();
        resolve({ up: false, responseTime: timeout, ttfb: null, statusCode: null, error: 'Timeout', bodySize: null, stack: null, ssl: null, checkType: 'ssl' });
      });
    } catch(e) {
      resolve({ up: false, responseTime: Date.now() - start, ttfb: null, statusCode: null, error: e.message, bodySize: null, stack: null, ssl: null, checkType: 'ssl' });
    }
  });
}

// ─── DNS check ────────────────────────────────────────────────────
function checkDns(site) {
  return new Promise(async (resolve) => {
    const start = Date.now();
    let hostname;
    try { hostname = new URL(site.url).hostname; } catch { hostname = site.url.replace(/^dns:\/\//, ''); }
    try {
      const addrs = await dns.resolve(hostname, 'A');
      const responseTime = Date.now() - start;
      const expectedIp = site.expectedIp || null;
      let up = addrs.length > 0;
      let error = null;
      if (expectedIp && up) {
        up = addrs.includes(expectedIp);
        if (!up) error = `Resolved ${addrs[0]} (expected ${expectedIp})`;
      }
      resolve({ up, responseTime, ttfb: responseTime, statusCode: null, error, addresses: addrs, bodySize: null, stack: null, ssl: null, checkType: 'dns' });
    } catch(e) {
      resolve({ up: false, responseTime: Date.now() - start, ttfb: null, statusCode: null, error: e.message, addresses: [], bodySize: null, stack: null, ssl: null, checkType: 'dns' });
    }
  });
}

// ─── Heartbeat check (passive — checks last ping time) ────────────
const _lastHeartbeatPing = {}; // { siteId: timestamp }

function checkHeartbeat(site) {
  const lastPing = _lastHeartbeatPing[site.id] || null;
  const expectedMs = (site.checkInterval || 300) * 1000;
  if (!lastPing) {
    return { up: false, responseTime: null, ttfb: null, statusCode: null, error: 'Waiting for first ping', bodySize: null, stack: null, ssl: null, checkType: 'heartbeat' };
  }
  const elapsed = Date.now() - lastPing;
  const up = elapsed <= expectedMs * 1.5; // 50% grace period
  return {
    up,
    responseTime: Math.round(elapsed / 1000),
    ttfb: null, statusCode: null,
    error: up ? null : `No ping for ${Math.round(elapsed / 60000)}m (expected every ${Math.round(expectedMs / 60000)}m)`,
    bodySize: null, stack: null, ssl: null, checkType: 'heartbeat',
  };
}

// ─── HTTP/HTTPS check ─────────────────────────────────────────────
function checkHttp(site) {
  return new Promise(async (resolve) => {
    const start = Date.now();
    const timeout = site.timeout || loadConfig().defaultTimeout || 10000;
    let firstUrl;
    try { firstUrl = new URL(site.url); } catch(e) { return resolve({ up: false, responseTime: 0, ttfb: null, statusCode: null, error: 'URL inválida', bodySize: null, stack: null, ssl: null, checkType: 'http', redirects: null }); }
    const sslPromise = firstUrl.protocol === 'https:' ? getSSLExpiry(firstUrl.hostname, firstUrl.port || 443) : Promise.resolve(null);

    // Follow redirects manually to capture chain
    const redirectChain = [];
    let ttfb = null;
    const needsBody = !!(site.contentCheck?.enabled && site.contentCheck?.text);

    const doHop = (url, depth) => new Promise((ok, fail) => {
      if (depth > 10) return fail(new Error('Demasiadas redirecciones'));
      let u;
      try { u = new URL(url); } catch(e) { return fail(new Error('URL inválida: ' + url)); }
      const isHttps = u.protocol === 'https:';
      const lib2 = isHttps ? https : http;
      const hopStart = Date.now();
      const req = lib2.request({
        hostname: u.hostname, port: u.port || (isHttps ? 443 : 80),
        path: u.pathname + u.search || '/', method: 'GET', timeout,
        headers: { 'User-Agent': 'StatusMon/1.0', 'Accept': '*/*', 'Accept-Encoding': 'identity' },
        rejectUnauthorized: false,
      }, (res) => {
        if (depth === 0) ttfb = Date.now() - start;
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          redirectChain.push({ url, status: res.statusCode, ms: Date.now() - hopStart });
          res.resume();
          let next = res.headers.location;
          if (!next.startsWith('http')) next = new URL(next, url).href;
          doHop(next, depth + 1).then(ok).catch(fail);
        } else {
          ok({ res, url, hopStart });
        }
      });
      req.on('timeout', () => { req.destroy(); fail(new Error('Timeout')); });
      req.on('error', fail);
      req.end();
    });

    try {
      const { res, url: finalUrl, hopStart } = await doHop(site.url, 0);
      let bodyLen = 0, bodyText = '';
      if (needsBody) {
        await new Promise(done => {
          res.on('data', chunk => {
            bodyLen += chunk.length;
            if (bodyText.length < 200000) bodyText += chunk.toString('utf8', 0, Math.min(chunk.length, 200000 - bodyText.length));
          });
          res.on('end', done);
          res.on('error', done);
        });
      } else {
        // Uptime check: el status code de las cabeceras basta — no descargamos
        // el cuerpo (evita transferir MB inútiles y atascos a mitad de stream).
        res.destroy();
      }
      const totalTime = Date.now() - start;
      const httpOk = res.statusCode < 400;
      let up = httpOk, error = null;
      if (up && needsBody) {
        const found = bodyText.includes(site.contentCheck.text);
        if (!found) { up = false; error = `Contenido no encontrado: "${site.contentCheck.text.slice(0, 60)}"`; }
      }
      if (redirectChain.length > 0) redirectChain.push({ url: finalUrl, status: res.statusCode, ms: Date.now() - hopStart });
      const stack = detectStack(res.headers);
      const ssl = await sslPromise;
      resolve({
        up, responseTime: totalTime, ttfb, statusCode: res.statusCode, error,
        bodySize: stack.contentLength || bodyLen, stack, ssl, checkType: 'http',
        redirects: redirectChain.length > 0 ? redirectChain : null,
        contentCheck: needsBody ? { ok: !error } : null,
      });
    } catch(e) {
      const ssl = await sslPromise.catch(() => null);
      resolve({ up: false, responseTime: Date.now() - start, ttfb: null, statusCode: null, error: e.message, bodySize: null, stack: null, ssl, checkType: 'http', redirects: redirectChain.length > 0 ? redirectChain : null });
    }
  });
}

// ─── Dispatcher ───────────────────────────────────────────────────
function checkSite(site) {
  if (site.type === 'heartbeat') return Promise.resolve(checkHeartbeat(site));
  try {
    const proto = new URL(site.url).protocol;
    if (proto === 'tcp:')       return checkTcp(site);
    if (proto === 'ssl:')       return checkSslSite(site);
    if (proto === 'dns:')       return checkDns(site);
    if (proto === 'heartbeat:') return Promise.resolve(checkHeartbeat(site));
  } catch {}
  return checkHttp(site);
}

// Check + reintento ante microcorte + fallback de protocolo (http<->https).
// Compartido por el scheduler y la comprobación manual para un veredicto único.
async function checkSiteResilient(site) {
  let result = await checkSite(site);
  // Reintento inmediato ante fallo para descartar microcortes
  if (!result.up && site.type !== 'heartbeat') {
    await new Promise(r => setTimeout(r, 2000));
    result = await checkSite(site);
  }
  // Fallback de protocolo: si sigue caído en una URL http/https, prueba el
  // esquema opuesto. Si el otro responde, lo consideramos "arriba" pero
  // avisamos de que la URL configurada usa el protocolo erróneo.
  if (!result.up && (site.type === 'http' || !site.type)) {
    const m = /^(https?):\/\/(.*)$/i.exec(site.url || '');
    if (m) {
      const curScheme = m[1].toLowerCase();
      const altScheme = curScheme === 'https' ? 'http' : 'https';
      const alt = await checkHttp({ ...site, url: `${altScheme}://${m[2]}` });
      if (alt.up) {
        result = { ...alt, protocolWarning: `Responde en ${altScheme.toUpperCase()} pero no en ${curScheme.toUpperCase()} (${result.statusCode ? 'HTTP '+result.statusCode : result.error || 'sin respuesta'}). Cambia la URL a ${altScheme}://` };
      }
    }
  }
  return result;
}

// ─── Notifications ────────────────────────────────────────────────
async function sendWebhook(cfg, site, result, type) {
  const webhookUrl = site.webhook?.url || cfg.webhook.url;
  if (!webhookUrl) return;
  const webhookType = site.webhook?.type || cfg.webhook.type;
  let emoji, status;
  if (type === 'down')          { emoji = '🔴'; status = 'CAÍDO'; }
  else if (type === 'up')       { emoji = '🟢'; status = 'RECUPERADO'; }
  else if (type === 'ssl_warn') { emoji = '🟡'; status = 'AVISO SSL'; }
  else if (type === 'ssl_critical') { emoji = '🔴'; status = 'SSL CRÍTICO'; }
  else                          { emoji = '⚪'; status = type.toUpperCase(); }
  const detail = result.error ? `Error: ${result.error}` : result.statusCode ? `HTTP ${result.statusCode} · ${result.responseTime}ms` : `${result.responseTime}ms`;
  const msg = `${emoji} **${site.name}** ${status}\n${site.url}\n${detail}`;

  let body;
  if (webhookType === 'discord') {
    body = JSON.stringify({ content: msg });
  } else if (webhookType === 'slack') {
    body = JSON.stringify({ text: msg });
  } else if (webhookType === 'telegram') {
    const chatId = site.webhook?.telegramChatId || cfg.webhook.telegramChatId;
    body = JSON.stringify({ chat_id: chatId, text: msg.replace(/\*\*/g, '*'), parse_mode: 'Markdown' });
  } else {
    body = JSON.stringify({ site: site.name, url: site.url, status: type, result });
  }

  try {
    const u = new URL(webhookType === 'telegram' ? `https://api.telegram.org/bot${webhookUrl}/sendMessage` : webhookUrl);
    const lib = u.protocol === 'https:' ? https : http;
    await new Promise((res, rej) => {
      const req = lib.request({ hostname: u.hostname, port: u.port||(u.protocol==='https:'?443:80), path: u.pathname+u.search, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, r => { r.resume(); res(); });
      req.on('error', rej);
      req.write(body); req.end();
    });
  } catch(e) { console.warn('Webhook error:', e.message); }
}

// Presets SMTP para proveedores conocidos
const MAIL_PRESETS = {
  gmail:   { host: 'smtp.gmail.com',           port: 587, secure: false },
  outlook: { host: 'smtp-mail.outlook.com',    port: 587, secure: false },
  yahoo:   { host: 'smtp.mail.yahoo.com',      port: 587, secure: false },
  icloud:  { host: 'smtp.mail.me.com',         port: 587, secure: false },
};

async function sendEmail(cfg, site, result, type) {
  const smtp = cfg.smtp;
  if (!smtp.enabled || !smtp.to) return;
  const method = smtp.method || 'smtp';

  let status;
  if (type === 'down')             status = 'CAÍDO';
  else if (type === 'up')          status = 'RECUPERADO';
  else if (type === 'ssl_warn')    status = 'AVISO SSL';
  else if (type === 'ssl_critical') status = 'SSL CRÍTICO';
  else                             status = type.toUpperCase();

  const subject = `[StatusMon] ${site.name} — ${status}`;
  const detail  = result.error ? `Error: ${result.error}` : result.statusCode ? `HTTP ${result.statusCode} · Tiempo: ${result.responseTime}ms` : `Tiempo: ${result.responseTime}ms`;
  const body    = `${site.name} (${site.url}) — ${status}.\n\n${detail}\n\nFecha: ${new Date().toLocaleString('es')}\n-- StatusMon`;

  try {
    if (method === 'direct') {
      // Modo directo: nodemailer resuelve MX y entrega sin relay
      const from = smtp.from || `statusmon@${require('os').hostname()}`;
      const transporter = nodemailer.createTransport({ direct: true, name: require('os').hostname() });
      await transporter.sendMail({ from: `StatusMon <${from}>`, to: smtp.to, subject, text: body });

    } else if (MAIL_PRESETS[method]) {
      // Preset (Gmail, Outlook, Yahoo, iCloud) — STARTTLS vía nodemailer
      const preset = MAIL_PRESETS[method];
      const from   = smtp.from || smtp.user;
      const transporter = nodemailer.createTransport({
        host: preset.host, port: preset.port, secure: preset.secure,
        auth: { user: smtp.user, pass: smtp.pass },
      });
      await transporter.sendMail({ from: `StatusMon <${from}>`, to: smtp.to, subject, text: body });

    } else {
      // Manual SMTP — raw TCP (sin deps extra, compatibilidad total)
      if (!smtp.host) return;
      const net = require('net');
      const tls = require('tls');
      await new Promise((resolve, reject) => {
        const from = smtp.from || smtp.user;
        const cmds = [
          `EHLO statusmon\r\n`,
          `AUTH LOGIN\r\n`,
          Buffer.from(smtp.user).toString('base64') + '\r\n',
          Buffer.from(smtp.pass).toString('base64') + '\r\n',
          `MAIL FROM:<${from}>\r\n`,
          `RCPT TO:<${smtp.to}>\r\n`,
          `DATA\r\n`,
          `From: StatusMon <${from}>\r\nTo: ${smtp.to}\r\nSubject: ${subject}\r\n\r\n${body}\r\n.\r\n`,
          `QUIT\r\n`,
        ];
        let idx = 0;
        const socket = smtp.secure
          ? tls.connect({ host: smtp.host, port: smtp.port||465 })
          : net.connect({ host: smtp.host, port: smtp.port||587 });
        socket.on('data', d => {
          const r = d.toString();
          if (/^[23]/.test(r.trim().split('\n').pop())) {
            if (idx < cmds.length) socket.write(cmds[idx++]);
            else { socket.destroy(); resolve(); }
          } else if (/^[45]/.test(r.trim())) { socket.destroy(); reject(new Error(r.trim())); }
        });
        socket.on('error', reject);
        socket.setTimeout(10000, () => { socket.destroy(); reject(new Error('SMTP timeout')); });
      });
    }
  } catch(e) { console.warn(`Mail error [${method}]:`, e.message); throw e; }
}

// ─── Alert state ──────────────────────────────────────────────────
const alertState = {}; // { siteId: { consecutive: 0, notified: false, wasDown: false } }

async function handleAlerts(site, result) {
  const cfg = loadConfig();
  if (cfg.maintenanceMode) return;
  if (site.maintenance) return;          // mantenimiento general del sitio (indefinido)
  if (inMaintenanceWindow(site)) return; // per-site maintenance window
  if (!alertState[site.id]) alertState[site.id] = { consecutive: 0, notified: false, wasDown: false, sslWarnSent: false, sslCriticalSent: false };
  const a = alertState[site.id];
  const webhookEnabled = cfg.webhook.enabled || site.webhook?.enabled;
  const smtpEnabled    = cfg.smtp.enabled;

  if (!result.up) {
    a.consecutive++;
    if (a.consecutive >= (cfg.alertAfterChecks||2) && !a.notified) {
      a.notified = true; a.wasDown = true;
      if (webhookEnabled) await sendWebhook(cfg, site, result, 'down');
      if (smtpEnabled)    await sendEmail(cfg, site, result, 'down');
      if (push) push.notifyAll({ title: `🔴 ${site.name} caído`, body: result.error || `HTTP ${result.statusCode}`, url: '/admin' }).catch(()=>{});
    }
  } else {
    if (a.wasDown && a.notified) {
      if (webhookEnabled) await sendWebhook(cfg, site, result, 'up');
      if (smtpEnabled)    await sendEmail(cfg, site, result, 'up');
      if (push) push.notifyAll({ title: `🟢 ${site.name} recuperado`, body: `Respuesta: ${result.responseTime}ms`, url: '/admin' }).catch(()=>{});
    }
    a.consecutive = 0; a.notified = false; a.wasDown = false;
  }

  // ─── SSL expiry alerts (for http/https and ssl check types) ──────
  const ssl = result.ssl;
  if (ssl && typeof ssl.daysLeft === 'number') {
    const warnDays = cfg.sslWarnDays ?? 30;
    const critDays = cfg.sslCriticalDays ?? 7;
    if (ssl.daysLeft <= critDays && !a.sslCriticalSent) {
      a.sslCriticalSent = true; a.sslWarnSent = true;
      const sslResult = { ...result, error: `SSL expira en ${ssl.daysLeft} día(s) — CRÍTICO` };
      if (webhookEnabled) await sendWebhook(cfg, site, sslResult, 'ssl_critical');
      if (smtpEnabled)    await sendEmail(cfg, site, sslResult, 'ssl_critical');
    } else if (ssl.daysLeft <= warnDays && !a.sslWarnSent) {
      a.sslWarnSent = true;
      const sslResult = { ...result, error: `SSL expira en ${ssl.daysLeft} días` };
      if (webhookEnabled) await sendWebhook(cfg, site, sslResult, 'ssl_warn');
      if (smtpEnabled)    await sendEmail(cfg, site, sslResult, 'ssl_warn');
    } else if (ssl.daysLeft > warnDays) {
      // Reset alert flags when cert is renewed
      a.sslWarnSent = false; a.sslCriticalSent = false;
    }
  }
}

// ─── Stats ────────────────────────────────────────────────────────
function computeStats(entries) {
  if (!entries || !entries.length) return null;
  const upE = entries.filter(e=>e.up), downE = entries.filter(e=>!e.up);
  const times = upE.map(e=>e.responseTime).sort((a,b)=>a-b);
  const ttfbs = upE.filter(e=>e.ttfb).map(e=>e.ttfb).sort((a,b)=>a-b);
  function pct(arr,p){if(!arr.length)return null;return arr[Math.max(0,Math.ceil(p/100*arr.length)-1)];}
  const mean = times.length?times.reduce((a,b)=>a+b,0)/times.length:null;
  const stddev = times.length>1?Math.sqrt(times.map(t=>(t-mean)**2).reduce((a,b)=>a+b,0)/times.length):0;
  const meanTtfb = ttfbs.length?Math.round(ttfbs.reduce((a,b)=>a+b,0)/ttfbs.length):null;
  const recentT = entries.slice(-10).filter(e=>e.up).map(e=>e.responseTime);
  const prevT = entries.slice(-20,-10).filter(e=>e.up).map(e=>e.responseTime);
  const recentAvg = recentT.length?recentT.reduce((a,b)=>a+b,0)/recentT.length:null;
  const prevAvg = prevT.length?prevT.reduce((a,b)=>a+b,0)/prevT.length:null;
  let trend='stable';
  if(recentAvg&&prevAvg){const d=recentAvg-prevAvg;if(d>prevAvg*.1)trend='degrading';else if(d<-prevAvg*.1)trend='improving';}
  let outageCount=0,longestOutage=0,tempStreak=0,currentStreak=0,totalDownChecks=0;
  for(const e of entries){if(!e.up){tempStreak++;totalDownChecks++;if(tempStreak>longestOutage)longestOutage=tempStreak;}else{if(tempStreak>0)outageCount++;tempStreak=0;}}
  if(tempStreak>0)outageCount++;
  for(let i=entries.length-1;i>=0;i--){if(!entries[i].up)currentStreak++;else break;}
  const spanMs=entries.length>1?entries[entries.length-1].ts-entries[0].ts:0;
  const mtbf=outageCount>0?Math.round(spanMs/outageCount/60000):null;
  const now=Date.now();
  const last24h=entries.filter(e=>e.ts>now-86400000);
  const last7d=entries.filter(e=>e.ts>now-7*86400000);
  const codeDist={};entries.forEach(e=>{const c=String(e.statusCode||'ERR');codeDist[c]=(codeDist[c]||0)+1;});
  const errorTypes={};downE.forEach(e=>{const k=e.error||`HTTP ${e.statusCode}`;errorTypes[k]=(errorTypes[k]||0)+1;});
  const sizes=upE.filter(e=>e.bodySize).map(e=>e.bodySize);
  const avgSize=sizes.length?Math.round(sizes.reduce((a,b)=>a+b,0)/sizes.length):null;
  const lastGood=[...entries].reverse().find(e=>e.up&&e.stack);
  const lastSsl=[...entries].reverse().find(e=>e.ssl)?.ssl||null;
  return {
    total:entries.length,upCount:upE.length,downCount:downE.length,
    uptimePct:+(upE.length/entries.length*100).toFixed(3),
    uptime24h:last24h.length?+(last24h.filter(e=>e.up).length/last24h.length*100).toFixed(3):null,
    uptime7d:last7d.length?+(last7d.filter(e=>e.up).length/last7d.length*100).toFixed(3):null,
    mean:mean!==null?Math.round(mean):null,stddev:Math.round(stddev),meanTtfb,
    p50:pct(times,50),p75:pct(times,75),p95:pct(times,95),p99:pct(times,99),
    p50ttfb:pct(ttfbs,50),p95ttfb:pct(ttfbs,95),
    fastest:times[0]||null,slowest:times[times.length-1]||null,
    trend,recentAvg:recentAvg?Math.round(recentAvg):null,prevAvg:prevAvg?Math.round(prevAvg):null,
    currentOutageStreak:currentStreak,longestOutageStreak:longestOutage,
    outageCount,mtbf,totalDowntime:Math.round(totalDownChecks*loadConfig().checkInterval/60),
    codeDist,errorTypes,avgSize,
    lastStack:lastGood?.stack||null,lastSsl,
    firstCheck:entries[0].ts,lastCheck:entries[entries.length-1].ts,
  };
}

// ─── NAS stats ────────────────────────────────────────────────────

// ─── NAS stats — async with cache ────────────────────────────────
let nasCache = { data: {}, ts: 0 };
let nasRefreshTimer = null;

function readCpuTick() {
  try {
    const line = fs.readFileSync('/proc/stat', 'utf8').split('\n')[0];
    const parts = line.split(/\s+/).slice(1).map(Number);
    return { idle: parts[3] + (parts[4] || 0), total: parts.reduce((a,b) => a+b, 0) };
  } catch { return null; }
}

async function refreshNasStats() {
  const stats = {};
  // RAM
  try {
    const mem = fs.readFileSync('/proc/meminfo', 'utf8');
    const get = k => { const m = mem.match(new RegExp(k + ':\\s+(\\d+)')); return m ? parseInt(m[1]) * 1024 : 0; };
    const total = get('MemTotal'), available = get('MemAvailable') || get('MemFree'), used = total - available;
    stats.ram = { total, used, free: available, usedPct: +(used / total * 100).toFixed(1) };
  } catch {}
  // CPU — async two-sample, no blocking loop
  try {
    const c1 = readCpuTick();
    if (c1) {
      await new Promise(r => setTimeout(r, 500)); // async wait, doesn't block event loop
      const c2 = readCpuTick();
      if (c2) {
        const dT = c2.total - c1.total, dI = c2.idle - c1.idle;
        stats.cpu = { usedPct: dT > 0 ? +((1 - dI / dT) * 100).toFixed(1) : 0 };
      }
    }
  } catch {}
  // Load avg + cores
  try {
    const la = fs.readFileSync('/proc/loadavg', 'utf8').split(' ');
    const cpuinfo = fs.readFileSync('/proc/cpuinfo', 'utf8');
    stats.load = { avg1: parseFloat(la[0]), avg5: parseFloat(la[1]), avg15: parseFloat(la[2]), cores: (cpuinfo.match(/^processor/gm) || []).length };
  } catch {}
  // Disk
  try {
    const df = execSync('df -B1 / 2>/dev/null || df -k /', { timeout: 2000 }).toString();
    stats.disks = df.trim().split('\n').slice(1).map(l => {
      const p = l.trim().split(/\s+/);
      if (p.length < 6) return null;
      const f = p[1] < 1e9 ? 1024 : 1;
      return { mount: p[5], total: p[1]*f, used: p[2]*f, free: p[3]*f, usedPct: +(p[2]/(p[1]||1)*100).toFixed(1) };
    }).filter(Boolean);
  } catch {}
  // Temperature
  try {
    const base = '/sys/class/thermal'; const temps = [];
    if (fs.existsSync(base)) {
      for (const z of fs.readdirSync(base).filter(d => d.startsWith('thermal_zone')).slice(0, 4)) {
        try {
          const t = parseInt(fs.readFileSync(`${base}/${z}/temp`, 'utf8').trim());
          const type = fs.readFileSync(`${base}/${z}/type`, 'utf8').trim();
          if (t > 0) temps.push({ label: type, celsius: +(t / 1000).toFixed(1) });
        } catch {}
      }
    }
    if (temps.length) stats.temps = temps;
  } catch {}
  stats.ts = Date.now();
  nasCache = { data: stats, ts: Date.now() };
  return stats;
}

function getNasStats() {
  return nasCache.data;
}

function scheduleNasRefresh() {
  if (nasRefreshTimer) clearInterval(nasRefreshTimer);
  const cfg = loadConfig();
  const sec = cfg.nasRefreshInterval || 30;
  if (sec <= 0) return;
  refreshNasStats(); // immediate first refresh
  nasRefreshTimer = setInterval(refreshNasStats, sec * 1000);
  console.log(`NAS refresh interval: ${sec}s`);
}


// ─── Host Metrics ─────────────────────────────────────────────────
let metricsReader = null;
try { metricsReader = require('./metrics/reader'); } catch {}

function loadMetricsHistory() {
  if (!fs.existsSync(METRICS_FILE)) return [];
  try {
    const txt = fs.readFileSync(METRICS_FILE, 'utf8');
    if (!txt.trim()) throw new Error('metrics.json is empty');
    return JSON.parse(txt);
  } catch (e) {
    console.error(`[data] metrics.json unreadable (${e.message}); attempting recovery`);
    preserveCorrupt(METRICS_FILE);
    const rec = recoverFromBackup('metrics.json');
    if (rec && Array.isArray(rec.data)) {
      console.error(`[data] recovered metrics.json from backup ${rec.from}`);
      return rec.data;
    }
    return [];
  }
}

let metricsHistory = loadMetricsHistory();
let metricsCurrent = metricsHistory.length ? metricsHistory[metricsHistory.length - 1] : null;
let _prevMetricsSnapshot = null;
let _metricsTimer = null;

async function collectMetrics() {
  if (!metricsReader) return;
  try {
    const snap = metricsReader.takeSnapshot();
    if (_prevMetricsSnapshot) {
      const m = metricsReader.computeMetrics(_prevMetricsSnapshot, snap);
      if (m) {
        metricsCurrent = m;
        metricsHistory.push(m);
        const maxM = loadConfig().metricsMaxHistory || 1440;
        if (metricsHistory.length > maxM) metricsHistory = metricsHistory.slice(-maxM);
      }
    }
    _prevMetricsSnapshot = snap;
  } catch { /* /host/proc not mounted — silent fail */ }
}

function scheduleMetrics() {
  if (_metricsTimer) clearInterval(_metricsTimer);
  if (!metricsReader) return;
  const cfg = loadConfig();
  const sec = cfg.metricsInterval || 60;
  if (sec <= 0) return;
  collectMetrics(); // prime the snapshot; no rates on first call
  _metricsTimer = setInterval(collectMetrics, sec * 1000);
  console.log(`Metrics interval: ${sec}s`);
}

// ─── Auto backup scheduler ────────────────────────────────────────
let _autoBackupTimer = null;
function scheduleAutoBackup() {
  if (_autoBackupTimer) { clearInterval(_autoBackupTimer); _autoBackupTimer = null; }
  const cfg = loadConfig();
  const days = cfg.autoBackupInterval || 0;
  if (days <= 0) return;
  const ms = days * 86400 * 1000;
  _autoBackupTimer = setInterval(() => {
    try {
      const b = createBackup('auto');
      console.log(`Auto backup: ${b.name} (${b.files} files)`);
    } catch(e) { console.warn('Auto backup failed:', e.message); }
  }, ms);
  console.log(`Auto backup interval: ${days}d`);
}

// ─── Safety flush scheduler ───────────────────────────────────────
// History/metrics live in memory and (depending on historyFlushMode) may only
// be persisted on graceful shutdown. A power loss never reaches that path, so
// this periodically force-writes them to disk to bound how much can be lost.
let _safetyFlushTimer = null;
function scheduleSafetyFlush() {
  if (_safetyFlushTimer) { clearInterval(_safetyFlushTimer); _safetyFlushTimer = null; }
  const cfg = loadConfig();
  const hours = cfg.safetyFlushHours || 0;
  if (hours <= 0) return;
  const ms = hours * 3600 * 1000;
  _safetyFlushTimer = setInterval(() => {
    try {
      flushHistoryNow();
      if (metricsHistory.length > 0) atomicWriteFileSync(METRICS_FILE, JSON.stringify(metricsHistory));
      console.log(`Safety flush: history + ${metricsHistory.length} metrics written to disk`);
    } catch(e) { console.warn('Safety flush failed:', e.message); }
  }, ms);
  console.log(`Safety flush interval: ${hours}h`);
}

// ─── State ────────────────────────────────────────────────────────
let status = {};
let history = loadHistory();
let checkTimer = null;

function scheduleChecks() {
  if (checkTimer) clearInterval(checkTimer);
  // Tick every 5 s; per-site intervals decide when each site is actually checked
  checkTimer = setInterval(runChecks, 5000);
  console.log(`Check scheduler active (5 s tick, global interval ${loadConfig().checkInterval}s)`);
}

// Per-site last-checked timestamps (in-memory)
const _lastCheckedAt = {};

// ─── Anomaly detection ────────────────────────────────────────────
function detectAnomaly(hist) {
  // Need at least 30 successful checks to establish baseline
  const recent = (hist || []).slice(-288).filter(e => e.up && e.responseTime > 0);
  if (recent.length < 30) return null;
  const times = recent.map(e => e.responseTime);
  const mean = times.reduce((a, b) => a + b, 0) / times.length;
  const variance = times.reduce((a, b) => a + (b - mean) ** 2, 0) / times.length;
  const stddev = Math.sqrt(variance);
  // Only flag if stddev is meaningful (not all identical values)
  if (stddev < 10) return null;
  const latest = times[times.length - 1];
  const zScore = (latest - mean) / stddev;
  if (zScore > 2.5) {
    return { mean: Math.round(mean), stddev: Math.round(stddev), current: latest, zScore: zScore.toFixed(1) };
  }
  return null;
}

// ─── Maintenance windows helper ────────────────────────────────────
function inMaintenanceWindow(site) {
  if (!site.maintenanceWindows?.length) return false;
  const now  = new Date();
  const day  = now.getDay();           // 0 Sun … 6 Sat
  const mins = now.getHours() * 60 + now.getMinutes();
  return site.maintenanceWindows.some(w => {
    if (!w.days?.includes(day)) return false;
    const [sh, sm] = (w.start || '00:00').split(':').map(Number);
    const [eh, em] = (w.end   || '00:00').split(':').map(Number);
    return mins >= sh * 60 + sm && mins < eh * 60 + em;
  });
}

async function runChecks() {
  const cfg = loadConfig();
  const { sites } = loadSites();
  const now = Date.now();
  for (const site of sites) {
    if (site.paused) continue;
    const siteMs = ((site.checkInterval || cfg.checkInterval || 60)) * 1000;
    if (now - (_lastCheckedAt[site.id] || 0) < siteMs) continue;
    _lastCheckedAt[site.id] = now;
    try {
    let result = await checkSiteResilient(site);
    const ts = Date.now();
    if (!history[site.id]) history[site.id] = [];
    const entry = { ts, up: result.up, responseTime: result.responseTime, ttfb: result.ttfb, statusCode: result.statusCode, error: result.error, bodySize: result.bodySize, stack: result.stack, ssl: result.ssl, redirects: result.redirects || null };
    if (shouldRecordEntry(site.id, entry)) {
      history[site.id].push(entry);
      _lastEntryKey[site.id] = { up: result.up, responseTime: result.responseTime };
      const maxH = cfg.maxHistory || 500;
      if (history[site.id].length > maxH) history[site.id] = history[site.id].slice(-maxH);
      markHistoryDirty();
    }
    const anomaly = detectAnomaly(history[site.id]);
    status[site.id] = { ...result, lastCheck: ts, name: site.name, url: site.url, id: site.id, paused: false, maintenance: !!site.maintenance, degraded: !!anomaly, anomaly };
    await handleAlerts(site, result);
    // Auto-diagnose on first down detection
    if (!result.up && (!diagCache[site.id] || diagCache[site.id].ts < Date.now() - 300000)) {
      runDiagnostic(site.url).then(d => { diagCache[site.id] = d; }).catch(() => {});
    }
    // Network cross-verification on down
    const netCfg = loadConfig();
    if (!result.up && netCfg.network?.enabled) {
      netVerify.verifyWithNetwork(site.url).then(v => {
        if (v.consensus) {
          if (!diagCache[site.id]) diagCache[site.id] = {};
          diagCache[site.id].networkVerification = v;
        }
      }).catch(() => {});
    }
    } catch (e) {
      // Un sitio problemático nunca debe abortar el resto del ciclo de checks
      console.error(`[runChecks] error en "${site?.name || site?.id}" (${site?.url}):`, (e && e.message) || e);
    }
  }
  // History saved lazily via markHistoryDirty — only when changed
}

// ─── API ──────────────────────────────────────────────────────────

// Config
app.get('/api/config', (req, res) => {
  const cfg = loadConfig();
  const safe = { ...cfg, smtp: { ...cfg.smtp, pass: cfg.smtp?.pass ? PASS_PLACEHOLDER : '' } };
  res.json(safe);
});
app.put('/api/config', (req, res) => {
  const current = loadConfig();
  const updated = { ...current, ...req.body };
  // Preserve existing password if frontend sends placeholder
  if (updated.smtp?.pass === PASS_PLACEHOLDER) {
    updated.smtp.pass = current.smtp?.pass || '';
  }
  saveConfig(updated);
  // Reschedule if interval changed
  if (req.body.checkInterval && req.body.checkInterval !== current.checkInterval) scheduleChecks();
  if (req.body.nasRefreshInterval !== undefined && req.body.nasRefreshInterval !== current.nasRefreshInterval) scheduleNasRefresh();
  if (req.body.metricsInterval !== undefined && req.body.metricsInterval !== current.metricsInterval) scheduleMetrics();
  if (req.body.autoBackupInterval !== undefined && req.body.autoBackupInterval !== current.autoBackupInterval) scheduleAutoBackup();
  if (req.body.safetyFlushHours !== undefined && req.body.safetyFlushHours !== current.safetyFlushHours) scheduleSafetyFlush();
  // Re-init network if network config changed
  if (req.body.network !== undefined) {
    const wasEnabled = current.network?.enabled;
    const nowEnabled = updated.network?.enabled;
    if (nowEnabled && !wasEnabled) initNetwork();
    else if (!nowEnabled && wasEnabled) netHeartbeat.stop();
  }
  res.json({ ok: true, config: updated });
});

// Status
app.get('/api/status', (req, res) => {
  const cfg = loadConfig();
  res.json({ status, checkedAt: Date.now(), interval: cfg.checkInterval * 1000, maintenanceMode: cfg.maintenanceMode });
});

// Public status (no sensitive data)
app.get('/api/status/public', (req, res) => {
  const tag = req.query.tag || null;
  const { sites } = loadSites();
  const pub = {};
  Object.entries(status).forEach(([id, s]) => {
    const site = sites.find(si => si.id === id);
    if (!site) return;
    if (site.public === false) return; // private site: never shown publicly
    if (tag && tag !== 'all' && !(site.tags || []).some(t => t.toLowerCase() === tag.toLowerCase())) return;
    const st = computeStats(history[id] || []);
    pub[id] = {
      up: s.up, name: s.name, url: s.url, lastCheck: s.lastCheck,
      statusCode: s.statusCode, tags: site.tags || [],
      maintenance: !!site.maintenance,
      uptimePct: st?.uptime24h ?? st?.uptimePct ?? null,
      meanResponseTime: st?.mean ?? null,
      lastOutage: st?.currentOutageStreak > 0 ? s.lastCheck : null,
      // Last 40 checks for sparkline (up/down only, no sensitive data)
      recentChecks: (history[id] || []).slice(-40).map(e => ({ up: e.up, ts: e.ts })),
    };
  });
  const cfg = loadConfig();
  // Available tags for filter UI
  const allTags = [...new Set(sites.flatMap(s => s.tags || []))];
  res.json({ status: pub, checkedAt: Date.now(), maintenanceMode: cfg.maintenanceMode, allTags });
});

// Sites
app.get('/api/sites', (req, res) => res.json(loadSites()));
app.post('/api/sites', (req, res) => {
  const data = loadSites();
  const { name, timeout, tags, webhook } = req.body;
  const url = normalizeUrl(req.body.url);
  if (!name || !url) return res.status(400).json({ error: 'Nombre y URL válida obligatorios' });
  const id = String(Date.now());
  const isPublic = req.body.public !== false; // default true
  data.sites.push({ id, name, url, timeout: timeout || loadConfig().defaultTimeout || 10000, tags: tags || [], paused: false, public: isPublic, webhook: webhook || null });
  saveSites(data);
  res.json({ ok: true, id });
});
app.put('/api/sites/:id', (req, res) => {
  const data = loadSites();
  const idx = data.sites.findIndex(s => s.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  if (req.body.url !== undefined) {
    const nu = normalizeUrl(req.body.url);
    if (!nu) return res.status(400).json({ error: 'URL inválida' });
    req.body.url = nu;
  }
  data.sites[idx] = { ...data.sites[idx], ...req.body };
  saveSites(data);
  res.json({ ok: true });
});
app.delete('/api/sites/:id', (req, res) => {
  const data = loadSites();
  data.sites = data.sites.filter(s => s.id !== req.params.id);
  saveSites(data);
  delete status[req.params.id]; delete history[req.params.id];
  saveHistory(history);
  res.json({ ok: true });
});

// Pause/resume
app.post('/api/sites/:id/pause', (req, res) => {
  const data = loadSites();
  const site = data.sites.find(s => s.id === req.params.id);
  if (!site) return res.status(404).json({ error: 'Not found' });
  site.paused = !site.paused;
  saveSites(data);
  if (status[site.id]) status[site.id].paused = site.paused;
  res.json({ ok: true, paused: site.paused });
});

// Mantenimiento general del sitio (silencia alertas indefinidamente, p.ej. un
// contenedor parado) sin dejar de comprobar el estado. Se desactiva manualmente.
app.post('/api/sites/:id/maintenance', (req, res) => {
  const data = loadSites();
  const site = data.sites.find(s => s.id === req.params.id);
  if (!site) return res.status(404).json({ error: 'Not found' });
  site.maintenance = !site.maintenance;
  saveSites(data);
  if (status[site.id]) status[site.id].maintenance = site.maintenance;
  // Al activar mantenimiento, resetea el estado de alerta para no disparar
  // "recuperado" al desactivarlo más tarde.
  if (site.maintenance && alertState[site.id]) {
    alertState[site.id].consecutive = 0;
    alertState[site.id].notified = false;
    alertState[site.id].wasDown = false;
  }
  res.json({ ok: true, maintenance: site.maintenance });
});

// History
app.get('/api/history/:id', (req, res) => {
  let h = history[req.params.id] || [];
  const since = req.query.since ? parseInt(req.query.since) : null;
  const until = req.query.until ? parseInt(req.query.until) : null;
  if (since) h = h.filter(e => e.ts >= since);
  if (until) h = h.filter(e => e.ts <= until);
  if (!since && !until) h = h.slice(-(parseInt(req.query.limit) || h.length));
  res.json(h);
});

// CSV export
app.get('/api/history/:id/csv', (req, res) => {
  const { sites } = loadSites();
  const site = sites.find(s => s.id === req.params.id);
  const h = history[req.params.id] || [];
  const name = site?.name || req.params.id;
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="statusmon-${name.replace(/[^a-z0-9]/gi,'_')}.csv"`);
  const rows = ['timestamp,datetime,up,responseTime_ms,ttfb_ms,statusCode,bodySize_bytes,error'];
  h.forEach(e => {
    rows.push([e.ts, new Date(e.ts).toISOString(), e.up?1:0, e.responseTime||'', e.ttfb||'', e.statusCode||'', e.bodySize||'', (e.error||'').replace(/,/g,';')].join(','));
  });
  res.send(rows.join('\n'));
});

// Stats — supports ?since=&until= for range-based stats
app.get('/api/stats/:id', (req, res) => {
  let h = history[req.params.id] || [];
  const since = req.query.since ? parseInt(req.query.since) : null;
  const until = req.query.until ? parseInt(req.query.until) : null;
  if (since) h = h.filter(e => e.ts >= since);
  if (until) h = h.filter(e => e.ts <= until);
  res.json(computeStats(h));
});

// Manual check
app.post('/api/check/:id', async (req, res) => {
  const { sites } = loadSites();
  const site = sites.find(s => s.id === req.params.id);
  if (!site) return res.status(404).json({ error: 'Not found' });
  const result = await checkSiteResilient(site);
  const ts = Date.now();
  status[site.id] = { ...result, lastCheck: ts, name: site.name, url: site.url, id: site.id, maintenance: !!site.maintenance };
  if (!history[site.id]) history[site.id] = [];
  history[site.id].push({ ts, up: result.up, responseTime: result.responseTime, ttfb: result.ttfb, statusCode: result.statusCode, error: result.error, bodySize: result.bodySize, stack: result.stack, ssl: result.ssl });
  const maxH = loadConfig().maxHistory || 500;
  if (history[site.id].length > maxH) history[site.id] = history[site.id].slice(-maxH);
  flushHistoryNow();
  res.json({ ...status[site.id], stats: computeStats(history[site.id]) });
});

// Force check all
app.post('/api/check', async (req, res) => {
  runChecks();
  res.json({ ok: true });
});

// NAS
app.get('/api/nas', async (req, res) => {
  const cfg = loadConfig();
  const maxAge = (cfg.nasRefreshInterval || 30) * 1000;
  if (!nasCache.ts || Date.now() - nasCache.ts > maxAge * 2) await refreshNasStats();
  res.json(getNasStats());
});

// ─── Host Metrics API ─────────────────────────────────────────────
// GET /api/metrics/current
app.get('/api/metrics/current', requireAuth, (req, res) => {
  res.json(metricsCurrent || null);
});

// GET /api/metrics/history?limit=N&from=ts&to=ts
app.get('/api/metrics/history', requireAuth, (req, res) => {
  let h = metricsHistory;
  const from = req.query.from ? parseInt(req.query.from) : 0;
  const to   = req.query.to   ? parseInt(req.query.to)   : Date.now();
  if (from) h = h.filter(m => m.ts >= from);
  if (req.query.to) h = h.filter(m => m.ts <= to);
  const limit = req.query.limit ? parseInt(req.query.limit) : h.length;
  res.json(h.slice(-limit));
});


// ─── Backup ───────────────────────────────────────────────────────
function createBackup(label) {
  fs.mkdirSync(BACKUPS_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const name = `backup-${label}-${ts}`;
  const backupDir = path.join(BACKUPS_DIR, name);
  fs.mkdirSync(backupDir, { recursive: true });
  // Copy all files in DATA_DIR (not subdirs, not .secret)
  const files = fs.readdirSync(DATA_DIR).filter(f => {
    const full = path.join(DATA_DIR, f);
    return fs.statSync(full).isFile() && f !== '.secret';
  });
  files.forEach(f => fs.copyFileSync(path.join(DATA_DIR, f), path.join(backupDir, f)));
  // Keep only last 10 backups
  const all = fs.readdirSync(BACKUPS_DIR)
    .filter(d => fs.statSync(path.join(BACKUPS_DIR, d)).isDirectory())
    .sort();
  if (all.length > 10) {
    all.slice(0, all.length - 10).forEach(d => {
      fs.rmSync(path.join(BACKUPS_DIR, d), { recursive: true, force: true });
    });
  }
  return { name, files: files.length, path: backupDir };
}

function listBackups() {
  if (!fs.existsSync(BACKUPS_DIR)) return [];
  return fs.readdirSync(BACKUPS_DIR)
    .filter(d => fs.statSync(path.join(BACKUPS_DIR, d)).isDirectory())
    .sort().reverse()
    .map(d => {
      const dir = path.join(BACKUPS_DIR, d);
      const files = fs.readdirSync(dir);
      const size = files.reduce((a, f) => {
        try { return a + fs.statSync(path.join(dir, f)).size; } catch { return a; }
      }, 0);
      return { name: d, files: files.length, size, ts: fs.statSync(dir).mtime.getTime() };
    });
}

// ─── Docker cleanup ───────────────────────────────────────────────
// dockerPrune removed — not accessible from inside container without socket mount

// scheduleDockerCleanup removed — use data/compact and backup cleanup instead

// ─── Update Manager ───────────────────────────────────────────────
const UPDATE_DIR = path.join(DATA_DIR, 'updates');
const UPDATE_ZIP = path.join(UPDATE_DIR, 'pending.zip');
const UPDATE_META = path.join(UPDATE_DIR, 'meta.json');
const APP_DIR = path.join(__dirname, '..');

function downloadToFile(url, dest, _redirects) {
  if ((_redirects || 0) > 5) return Promise.reject(new Error('Demasiadas redirecciones'));
  return new Promise((resolve, reject) => {
    try {
      const u = new URL(url);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return reject(new Error('Solo HTTP/HTTPS'));
      const lib = u.protocol === 'https:' ? https : http;
      const file = fs.createWriteStream(dest);
      lib.get(url, { timeout: 60000, headers: { 'User-Agent': 'StatusMon-Updater/1.0' } }, (res) => {
        // Seguir redirecciones (GitHub Releases usa 302 → S3/CDN)
        if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
          file.close(); try { fs.unlinkSync(dest); } catch {}
          return downloadToFile(res.headers.location, dest, (_redirects||0)+1).then(resolve).catch(reject);
        }
        if (res.statusCode !== 200) {
          file.close(); try { fs.unlinkSync(dest); } catch {}
          return reject(new Error(`HTTP ${res.statusCode}`));
        }
        res.pipe(file);
        file.on('finish', () => { file.close(); resolve(); });
        file.on('error', (e) => { file.close(); reject(e); });
      }).on('error', (e) => { file.close(); try { fs.unlinkSync(dest); } catch {}; reject(e); });
    } catch(e) { reject(e); }
  });
}

function inspectUpdateZip(zipPath) {
  try {
    const listing = execSync(`unzip -l "${zipPath}"`, { timeout: 10000, encoding: 'utf8' });
    const rootMatch = listing.match(/\s(statusmon-v[\d.+]+)\//);
    const rootDir = rootMatch ? rootMatch[1] : null;
    let version = rootDir ? rootDir.replace('statusmon-v', '') : 'desconocida';
    try {
      const pkgPath = rootDir ? `${rootDir}/package.json` : 'package.json';
      const pkgRaw = execSync(`unzip -p "${zipPath}" "${pkgPath}"`, { timeout: 5000, encoding: 'utf8' });
      const pkg = JSON.parse(pkgRaw);
      if (pkg.version) version = pkg.version;
    } catch {}
    const size = fs.statSync(zipPath).size;
    return { version, rootDir, size, ts: Date.now() };
  } catch(e) {
    throw new Error(`No se pudo leer el ZIP: ${e.message}`);
  }
}

// GET /api/update/pending
app.get('/api/update/pending', requireAuth, (req, res) => {
  if (!fs.existsSync(UPDATE_META)) return res.json({ pending: false });
  try {
    const meta = JSON.parse(fs.readFileSync(UPDATE_META, 'utf8'));
    res.json({ pending: true, ...meta });
  } catch { res.json({ pending: false }); }
});

// POST /api/update/fetch — descarga ZIP desde URL
app.post('/api/update/fetch', requireAuth, async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'url requerida' });
  try {
    fs.mkdirSync(UPDATE_DIR, { recursive: true });
    await downloadToFile(url, UPDATE_ZIP);
    const meta = { ...inspectUpdateZip(UPDATE_ZIP), source: url };
    fs.writeFileSync(UPDATE_META, JSON.stringify(meta));
    res.json({ ok: true, ...meta });
  } catch(e) {
    try { fs.rmSync(UPDATE_DIR, { recursive: true, force: true }); } catch {}
    res.status(500).json({ error: e.message });
  }
});

// POST /api/update/upload — sube ZIP desde el navegador
app.post('/api/update/upload', requireAuth,
  express.raw({ type: ['application/zip', 'application/octet-stream', 'application/x-zip-compressed'], limit: '100mb' }),
  async (req, res) => {
    if (!req.body || !req.body.length) return res.status(400).json({ error: 'Sin archivo' });
    try {
      fs.mkdirSync(UPDATE_DIR, { recursive: true });
      fs.writeFileSync(UPDATE_ZIP, req.body);
      const meta = { ...inspectUpdateZip(UPDATE_ZIP), source: 'upload' };
      fs.writeFileSync(UPDATE_META, JSON.stringify(meta));
      res.json({ ok: true, ...meta });
    } catch(e) {
      try { fs.rmSync(UPDATE_DIR, { recursive: true, force: true }); } catch {}
      res.status(500).json({ error: e.message });
    }
  }
);

// POST /api/update/apply — aplica actualización pendiente y reinicia
app.post('/api/update/apply', requireAuth, async (req, res) => {
  if (!fs.existsSync(UPDATE_ZIP)) return res.status(404).json({ error: 'Sin actualización pendiente' });
  try {
    let meta = {};
    try { meta = JSON.parse(fs.readFileSync(UPDATE_META, 'utf8')); } catch {}

    // 1. Backup automático de /data antes de aplicar
    const backup = createBackup('pre-update');

    // 2. Extraer ZIP en directorio temporal
    const extractDir = path.join(UPDATE_DIR, 'extracted');
    fs.rmSync(extractDir, { recursive: true, force: true });
    fs.mkdirSync(extractDir, { recursive: true });
    execSync(`unzip -o "${UPDATE_ZIP}" -d "${extractDir}"`, { timeout: 60000 });

    // 3. Determinar carpeta raíz dentro del ZIP
    // Filtramos __MACOSX, ficheros ocultos y entradas que no sean directorios
    // (macOS añade __MACOSX/ a los ZIPs comprimidos con Finder)
    const entries = fs.readdirSync(extractDir).filter(e => {
      if (e.startsWith('.') || e === '__MACOSX') return false;
      return fs.statSync(path.join(extractDir, e)).isDirectory();
    });
    const rootDir = (entries.length === 1)
      ? path.join(extractDir, entries[0])
      : extractDir;

    // 4. Copiar src/ y public/ al directorio de la app
    const srcSrc = path.join(rootDir, 'src');
    const pubSrc = path.join(rootDir, 'public');
    console.log(`[update] rootDir=${rootDir} srcExists=${fs.existsSync(srcSrc)} pubExists=${fs.existsSync(pubSrc)}`);
    if (!fs.existsSync(srcSrc) && !fs.existsSync(pubSrc)) {
      throw new Error(`ZIP no contiene src/ ni public/ bajo "${path.basename(rootDir)}". Comprueba la estructura del ZIP.`);
    }
    if (fs.existsSync(srcSrc)) {
      execSync(`cp -rf "${srcSrc}/." "${path.join(APP_DIR, 'src')}/"`, { timeout: 15000 });
      console.log(`[update] src/ copiado a ${path.join(APP_DIR, 'src')}`);
    }
    if (fs.existsSync(pubSrc)) {
      execSync(`cp -rf "${pubSrc}/." "${path.join(APP_DIR, 'public')}/"`, { timeout: 15000 });
      console.log(`[update] public/ copiado a ${path.join(APP_DIR, 'public')}`);
    }

    // 5. Guardar ZIP en RELEASES_DIR (bind-mounted) para que persista tras la actualización
    if (meta.version) {
      const zipDest = path.join(RELEASES_DIR, `statusmon-v${meta.version}.zip`);
      try {
        fs.copyFileSync(UPDATE_ZIP, zipDest);
        console.log(`[update] ZIP guardado en ${zipDest}`);
      } catch(e) {
        console.warn(`[update] No se pudo guardar ZIP en releases: ${e.message}`);
      }
    }

    // 6. Limpiar directorio de actualización
    fs.rmSync(UPDATE_DIR, { recursive: true, force: true });

    // 7. Responder y salir — Docker (restart: unless-stopped) relanza automáticamente
    res.json({ ok: true, backup: backup.name, version: meta.version, message: 'Reiniciando…' });
    setTimeout(() => process.exit(0), 600);

  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/update/pending — descarta actualización en espera
app.delete('/api/update/pending', requireAuth, (req, res) => {
  try {
    fs.rmSync(UPDATE_DIR, { recursive: true, force: true });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});




// ─── Network map data ─────────────────────────────────────────────
app.get('/api/network/map', (req, res) => {
  const cfg = loadConfig();
  const { getAllPeers, getActivePeers } = require('./network/peers');
  const { getNodeId, getPublicKeyB64 } = require('./network/crypto');

  const activePeers = getActivePeers();
  const allPeers = getAllPeers();

  // Build node list — only public info
  const nodes = activePeers
    .filter(p => p.url) // only nodes with public URL
    .map(p => ({
      nodeId: p.nodeId ? p.nodeId.slice(0, 8) : '?',
      url: p.url,
      version: p.version || '?',
      continent: p.continent || 'EU',
      sitesMonitored: p.sitesMonitored || 0,
      uptimePct: p.uptimePct || null,
      isBootstrap: p.isBootstrap || false,
      reputation: Math.round((p.reputation || 0) * 100),
      lastSeen: p.lastSeen,
    }));

  // Add self
  const selfSites = loadSites().sites || [];
  const selfUptime = selfSites.length > 0
    ? Math.round(Object.values(status).filter(s=>s.up).length / Math.max(selfSites.length,1) * 100)
    : null;

  const selfIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || '';
  nodes.unshift({
    nodeId: (getNodeId() || '').slice(0, 8),
    url: cfg.network?.nodeUrl || null,
    version: APP_VERSION,
    continent: cfg.network?.continent || 'EU',
    sitesMonitored: selfSites.length,
    uptimePct: selfUptime,
    isBootstrap: cfg.network?.isBootstrap || false,
    reputation: 100,
    lastSeen: Date.now(),
    isSelf: true,
  });

  // Continent counts
  const continents = {};
  nodes.forEach(n => {
    continents[n.continent] = (continents[n.continent] || 0) + 1;
  });

  // Global stats
  const totalSites = nodes.reduce((a, n) => a + (n.sitesMonitored || 0), 0);
  const uptimes = nodes.map(n => n.uptimePct).filter(v => v !== null);
  const avgUptime = uptimes.length ? Math.round(uptimes.reduce((a,b)=>a+b,0)/uptimes.length) : null;

  res.json({
    nodes,
    totalNodes: nodes.length,
    totalPeers: allPeers.length,
    continents,
    totalSites,
    avgUptime,
    lastUpdate: Date.now(),
  });
});

// ─── Network stats (public summary for /about page) ──────────────
app.get('/api/network/stats', (req, res) => {
  const { getAllPeers, getActivePeers } = require('./network/peers');
  const { getNodeId } = require('./network/crypto');
  const cfg = loadConfig();
  const active = getActivePeers();
  const all = getAllPeers();
  const bootstraps = all.filter(p => p.isBootstrap);
  res.json({
    nodeId: getNodeId(),
    networkEnabled: cfg.network?.enabled || false,
    isBootstrap: cfg.network?.isBootstrap || false,
    nodeUrl: cfg.network?.nodeUrl || null,
    activePeers: active.length,
    totalPeers: all.length,
    bootstrapNodes: bootstraps.length,
    topPeers: active
      .sort((a,b) => (b.reputation||0)-(a.reputation||0))
      .slice(0, 20)
      .map(p => ({
        nodeId: p.nodeId,
        url: p.url,
        reputation: Math.round((p.reputation||0)*100),
        lastSeen: p.lastSeen,
        version: p.version,
        isBootstrap: p.isBootstrap||false,
        region: p.region||null,
      })),
  });
});

// ─── Favicon cache ────────────────────────────────────────────────
app.get('/api/sites/:id/favicon', async (req, res) => {
  const site = loadSites().sites.find(s => s.id === req.params.id);
  if (!site) return res.status(404).end();
  fs.mkdirSync(FAVICONS_DIR, { recursive: true });
  const cacheFile = path.join(FAVICONS_DIR, req.params.id + '.ico');
  const missFile  = path.join(FAVICONS_DIR, req.params.id + '.miss');
  const ICON_TTL  = 7 * 24 * 3600 * 1000;  // 7 días para hits
  const MISS_TTL  = 24 * 3600 * 1000;       // 24 h para misses (negative cache)

  // Serve from positive cache
  if (fs.existsSync(cacheFile) && Date.now() - fs.statSync(cacheFile).mtimeMs < ICON_TTL) {
    return res.sendFile(cacheFile);
  }
  // Negative cache — no volver a intentar hasta que expire
  if (fs.existsSync(missFile) && Date.now() - fs.statSync(missFile).mtimeMs < MISS_TTL) {
    return res.status(404).end();
  }

  try {
    let origin = site.url;
    try { origin = new URL(site.url.replace(/^tcp:\/\/|^ssl:\/\//, 'https://')).origin; } catch {}
    const faviconUrl = origin + '/favicon.ico';
    const resp = await new Promise((resolve, reject) => {
      const mod = faviconUrl.startsWith('https') ? https : http;
      mod.get(faviconUrl, { timeout: 4000 }, r => {
        if (r.statusCode !== 200) return reject(new Error('not found'));
        const chunks = [];
        r.on('data', c => chunks.push(c));
        r.on('end', () => resolve(Buffer.concat(chunks)));
      }).on('error', reject).on('timeout', function(){ this.destroy(); reject(new Error('timeout')); });
    });
    // Éxito: guardar icono y borrar miss si existía
    fs.writeFileSync(cacheFile, resp);
    try { fs.rmSync(missFile); } catch {}
    res.set('Content-Type', 'image/x-icon');
    res.send(resp);
  } catch {
    // Fallo: guardar negative cache para no reintentar en 24 h
    try { fs.writeFileSync(missFile, ''); } catch {}
    res.status(404).end();
  }
});

// ─── Sites reorder ────────────────────────────────────────────────
app.put('/api/sites/reorder', (req, res) => {
  const { order } = req.body; // array of ids in new order
  if (!Array.isArray(order)) return res.status(400).json({ error: 'order must be array' });
  const data = loadSites();
  const map = Object.fromEntries(data.sites.map(s => [s.id, s]));
  const reordered = order.map(id => map[id]).filter(Boolean);
  // Append any sites not in order array at end (safety)
  const missing = data.sites.filter(s => !order.includes(s.id));
  data.sites = [...reordered, ...missing];
  saveSites(data);
  res.json({ ok: true });
});

// ─── Export / Import ──────────────────────────────────────────────
app.get('/api/export', (req, res) => {
  const cfg  = loadConfig();
  const safe = { ...cfg };
  if (safe.smtp?.pass) safe.smtp = { ...safe.smtp, pass: '' }; // strip password
  const payload = { version: APP_VERSION, exportedAt: new Date().toISOString(), sites: loadSites(), config: safe };
  res.setHeader('Content-Disposition', `attachment; filename="statusmon-backup-${Date.now()}.json"`);
  res.json(payload);
});
app.post('/api/import', (req, res) => {
  try {
    const { sites: incomingSites, config } = req.body;
    let sitesImported = 0;
    if (incomingSites?.sites) {
      const cur = loadSites();
      const existingIds = new Set(cur.sites.map(s => s.id));
      const toAdd = incomingSites.sites.filter(s => !existingIds.has(s.id));
      cur.sites = [...cur.sites, ...toAdd];
      saveSites(cur);
      sitesImported = toAdd.length;
    }
    if (config) {
      const cur = loadConfig();
      const merged = { ...cur, ...config };
      // Preserve SMTP password if not present in import
      if (!config.smtp?.pass) merged.smtp = { ...(merged.smtp||{}), pass: cur.smtp?.pass || '' };
      saveConfig(merged);
    }
    res.json({ ok: true, sitesImported });
  } catch(e) { res.status(400).json({ error: e.message }); }
});

// ─── Public status-page theme (no auth needed) ────────────────────
app.get('/api/status-theme', (req, res) => {
  const { statusPage = {} } = loadConfig();
  res.json(statusPage);
});

// ─── Version ──────────────────────────────────────────────────────
app.get('/api/version', (req, res) => res.json({ version: APP_VERSION }));
app.get('/api/health',  (req, res) => res.json({ ok: true, version: APP_VERSION, uptime: Math.floor(process.uptime()) }));

// ─── Hora del servidor + referencia externa neutral ───────────────
// _extTimeOffset = (hora externa real) − (Date.now() local). Permite mostrar
// si el reloj del servidor se ha desviado de una fuente NTP independiente.
let _extTimeOffset = null;
function refreshExternalTime() {
  const t0 = Date.now();
  try {
    const req = https.get('https://www.cloudflare.com/cdn-cgi/trace', { timeout: 5000 }, res => {
      let body = '';
      res.on('data', c => { body += c; if (body.length > 4096) req.destroy(); });
      res.on('end', () => {
        const t1 = Date.now();
        const m = /(?:^|\n)ts=([0-9.]+)/.exec(body);
        if (m) {
          const extMs = Math.round(parseFloat(m[1]) * 1000);
          const localMid = t0 + (t1 - t0) / 2; // compensa el round-trip
          if (extMs > 1e12) _extTimeOffset = extMs - localMid;
        }
      });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => {});
  } catch { /* la referencia externa es opcional */ }
}
app.get('/api/time', (req, res) => {
  res.json({
    server: Date.now(),
    external: _extTimeOffset != null ? Date.now() + _extTimeOffset : null,
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone || null,
  });
});

// Detect public URL from request headers (works behind Cosmos/Traefik/NPM)
app.get('/api/detect-url', (req, res) => {
  const proto = req.headers['x-forwarded-proto'] || req.headers['x-scheme'] || (req.socket?.encrypted ? 'https' : 'http');
  const host = req.headers['x-forwarded-host'] || req.headers['host'] || '';
  const detectedUrl = host ? proto + '://' + host.split(',')[0].trim() : '';
  const configured = loadConfig().network?.nodeUrl || '';
  res.json({ detectedUrl, configured });
});

// ─── Backup endpoints ─────────────────────────────────────────────
app.get('/api/backups', (req, res) => res.json(listBackups()));

app.post('/api/backups', (req, res) => {
  try {
    const result = createBackup(req.body.label || 'manual');
    res.json({ ok: true, ...result });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/history/:id', (req, res) => {
  const id = req.params.id;
  if (id === 'all') {
    // Backup first, then clear all
    const backup = createBackup('pre-clear-all');
    history = {};
    saveHistory(history);
    res.json({ ok: true, backup: backup.name });
  } else {
    if (!history[id]) return res.status(404).json({ error: 'Not found' });
    const backup = createBackup(`pre-clear-${id}`);
    history[id] = [];
    saveHistory(history);
    res.json({ ok: true, backup: backup.name });
  }
});

// ─── Data cleanup endpoints ───────────────────────────────────────
// Get data dir stats
app.get('/api/data/stats', (req, res) => {
  try {
    const stats = {};
    const files = [CONFIG_FILE, SITES_FILE, HISTORY_FILE];
    const labels = ['config.json', 'sites.json', 'history.json'];
    files.forEach((f, i) => {
      try {
        const s = fs.statSync(f);
        stats[labels[i]] = { size: s.size, mtime: s.mtime.getTime() };
      } catch { stats[labels[i]] = { size: 0 }; }
    });
    // Backup dir size
    let backupSize = 0;
    let backupCount = 0;
    if (fs.existsSync(BACKUPS_DIR)) {
      const walk = (dir) => {
        fs.readdirSync(dir).forEach(f => {
          const full = path.join(dir, f);
          if (fs.statSync(full).isDirectory()) { walk(full); backupCount++; }
          else backupSize += fs.statSync(full).size;
        });
      };
      walk(BACKUPS_DIR);
    }
    stats['backups/'] = { size: backupSize, count: backupCount };
    // Releases folder (bind-mounted DATA_DIR/releases/)
    let relSize = 0, relCount = 0;
    if (fs.existsSync(RELEASES_DIR)) {
      fs.readdirSync(RELEASES_DIR).forEach(f => {
        try { const s = fs.statSync(path.join(RELEASES_DIR, f)); relSize += s.size; relCount++; } catch {}
      });
    }
    stats['releases/'] = { size: relSize, count: relCount };
    // Total
    const total = Object.values(stats).reduce((a, b) => a + (b.size || 0), 0);
    res.json({ files: stats, total, historyEntries: Object.values(history).reduce((a, b) => a + b.length, 0) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Delete old backups
// GET /api/backups/:name/download — descarga backup como ZIP (pure Node.js, sin binario zip)
app.get('/api/backups/:name/download', requireAuth, (req, res) => {
  const name = path.basename(req.params.name);
  const backupDir = path.join(BACKUPS_DIR, name);
  if (!fs.existsSync(backupDir)) return res.status(404).json({ error: 'Backup no encontrado' });
  try {
    const entries = fs.readdirSync(backupDir)
      .filter(f => fs.statSync(path.join(backupDir, f)).isFile())
      .map(f => ({ name: `${name}/${f}`, data: fs.readFileSync(path.join(backupDir, f)) }));
    if (entries.length === 0) return res.status(404).json({ error: 'Backup vacío' });
    const zipBuf = buildZipBuffer(entries);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${name}.zip"`);
    res.setHeader('Content-Length', zipBuf.length);
    res.end(zipBuf);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/backups/restore — sube ZIP de backup y restaura (reinicia)
app.post('/api/backups/restore', requireAuth,
  express.raw({ type: ['application/zip','application/octet-stream','application/x-zip-compressed'], limit: '100mb' }),
  async (req, res) => {
    if (!req.body || !req.body.length) return res.status(400).json({ error: 'Sin archivo' });
    const restoreDir = path.join(DATA_DIR, '_restore_tmp');
    const tmpZip    = path.join(DATA_DIR, '_restore.zip');
    try {
      fs.writeFileSync(tmpZip, req.body);
      // Backup del estado actual antes de restaurar
      const backup = createBackup('pre-restore');
      // Extraer ZIP
      fs.rmSync(restoreDir, { recursive: true, force: true });
      fs.mkdirSync(restoreDir, { recursive: true });
      execSync(`unzip -o "${tmpZip}" -d "${restoreDir}"`, { timeout: 30000 });
      // Encontrar la carpeta raíz dentro del ZIP (backup-xxx-xxx/)
      const entries = fs.readdirSync(restoreDir).filter(e =>
        !e.startsWith('.') && e !== '__MACOSX' &&
        fs.statSync(path.join(restoreDir, e)).isDirectory()
      );
      const srcDir = entries.length === 1 ? path.join(restoreDir, entries[0]) : restoreDir;
      // Copiar ficheros a DATA_DIR (nunca .secret — cada instancia tiene su propia clave)
      const files = fs.readdirSync(srcDir).filter(f =>
        fs.statSync(path.join(srcDir, f)).isFile() && f !== '.secret'
      );
      files.forEach(f => fs.copyFileSync(path.join(srcDir, f), path.join(DATA_DIR, f)));
      // Limpiar temporales
      fs.rmSync(restoreDir, { recursive: true, force: true });
      fs.unlinkSync(tmpZip);
      res.json({ ok: true, files: files.length, backup: backup.name, message: 'Reiniciando…' });
      setTimeout(() => process.exit(0), 600);
    } catch(e) {
      try { fs.rmSync(restoreDir, { recursive: true, force: true }); } catch {}
      try { fs.unlinkSync(tmpZip); } catch {}
      res.status(500).json({ error: e.message });
    }
  }
);

app.delete('/api/backups/:name', (req, res) => {
  try {
    const target = path.join(BACKUPS_DIR, path.basename(req.params.name));
    if (!fs.existsSync(target)) return res.status(404).json({ error: 'Not found' });
    fs.rmSync(target, { recursive: true, force: true });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Delete ALL backups
app.delete('/api/backups', (req, res) => {
  try {
    if (fs.existsSync(BACKUPS_DIR)) fs.rmSync(BACKUPS_DIR, { recursive: true, force: true });
    fs.mkdirSync(BACKUPS_DIR, { recursive: true });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Compact history — trim each site to current maxHistory
app.post('/api/data/compact', (req, res) => {
  const cfg = loadConfig();
  const maxH = cfg.maxHistory || 500;
  let removed = 0;
  Object.keys(history).forEach(id => {
    const before = history[id].length;
    history[id] = history[id].slice(-maxH);
    removed += before - history[id].length;
  });
  saveHistory(history);
  res.json({ ok: true, removed });
});


// ─── Auth endpoints ───────────────────────────────────────────────
app.get('/api/auth/status', (req, res) => {
  const cfg = loadConfig();
  const hasPassword = !!(cfg.auth?.passwordHash);
  // Check if currently authenticated
  let authenticated = false;
  if (hasPassword) {
    const token = req.headers.authorization?.replace('Bearer ', '') || req.cookies?.token;
    if (token) {
      try { jwt.verify(token, getJwtSecret()); authenticated = true; } catch {}
    }
  }
  res.json({ authEnabled: hasPassword, authenticated: hasPassword ? authenticated : true });
});

app.post('/api/auth/login', async (req, res) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress || 'unknown';
  const bf = checkBruteForce(ip);
  if (bf.locked) return res.status(429).json({ error: `Demasiados intentos. Espera ${bf.remaining}s.`, remaining: bf.remaining });

  const cfg = loadConfig();
  if (!cfg.auth?.passwordHash) return res.status(400).json({ error: 'No password configured' });

  const { password } = req.body;
  if (!password) return res.status(400).json({ error: 'Password required' });

  const valid = await bcrypt.compare(password, cfg.auth.passwordHash);
  if (!valid) {
    recordFailedAttempt(ip);
    const bf2 = checkBruteForce(ip);
    const attemptsLeft = MAX_ATTEMPTS - bf2.count;
    return res.status(401).json({ error: 'Contraseña incorrecta', attemptsLeft: Math.max(0, attemptsLeft) });
  }

  resetAttempts(ip);
  const token = jwt.sign({ admin: true }, getJwtSecret(), { expiresIn: cfg.auth?.jwtExpiry || '24h' });
  res.json({ ok: true, token });
});

app.post('/api/auth/logout', (req, res) => res.json({ ok: true }));

app.post('/api/auth/password', async (req, res) => {
  const { password, currentPassword } = req.body;
  if (!password || password.length < 6) return res.status(400).json({ error: 'Mínimo 6 caracteres' });
  const cfg = loadConfig();
  // If password already set, require current password (checked by middleware already but double-check)
  if (cfg.auth?.passwordHash && currentPassword) {
    const valid = await bcrypt.compare(currentPassword, cfg.auth.passwordHash);
    if (!valid) return res.status(401).json({ error: 'Contraseña actual incorrecta' });
  }
  const hash = await bcrypt.hash(password, 12);
  cfg.auth = { ...cfg.auth, enabled: true, passwordHash: hash };
  saveConfig(cfg);
  res.json({ ok: true });
});

app.delete('/api/auth/password', requireAuth, (req, res) => {
  const cfg = loadConfig();
  cfg.auth = { enabled: false, passwordHash: '', jwtExpiry: '24h' };
  saveConfig(cfg);
  res.json({ ok: true });
});

// ─── Diagnostics ──────────────────────────────────────────────────
const dns = require('dns').promises;

async function runDiagnostic(url) {
  const result = { url, ts: Date.now(), dns: null, ping: null, trace: null };
  let hostname;
  try { hostname = new URL(url).hostname; } catch { return { ...result, error: 'Invalid URL' }; }

  // DNS lookup
  try {
    const dnsStart = Date.now();
    const addrs = await dns.lookup(hostname, { all: true });
    result.dns = {
      hostname,
      addresses: addrs.map(a => a.address),
      resolveMs: Date.now() - dnsStart,
    };
    // Also get nameservers
    try {
      const ns = await dns.resolveNs(hostname).catch(() => []);
      result.dns.nameservers = ns;
    } catch {}
  } catch(e) {
    result.dns = { hostname, error: e.message, addresses: [] };
  }

  // Ping (HTTP HEAD)
  try {
    const pingStart = Date.now();
    await new Promise((resolve, reject) => {
      const u = new URL(url);
      const lib = u.protocol === 'https:' ? require('https') : require('http');
      const req = lib.request({
        hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname || '/', method: 'HEAD', timeout: 8000,
        rejectUnauthorized: false,
      }, res => { resolve(res.statusCode); res.resume(); });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
      req.end();
    }).then(code => {
      result.ping = { latencyMs: Date.now() - pingStart, statusCode: code, reachable: code < 500 };
    });
  } catch(e) {
    result.ping = { latencyMs: Date.now() - result.ts, reachable: false, error: e.message };
  }

  // Traceroute (tracepath or traceroute, whichever available)
  try {
    const cmd = (() => {
      try { execSync('which tracepath 2>/dev/null', { timeout: 1000 }); return `tracepath -n -m 15 ${hostname}`; } catch {}
      try { execSync('which traceroute 2>/dev/null', { timeout: 1000 }); return `traceroute -n -m 15 -w 2 ${hostname}`; } catch {}
      return null;
    })();
    if (cmd) {
      const out = execSync(cmd, { timeout: 20000, encoding: 'utf8' });
      const hops = out.split('\n').slice(1).filter(Boolean).map(line => {
        const m = line.match(/^\s*(\d+).*?([\d.]+)\s+([\d.]+)\s*ms/);
        if (!m) return null;
        return { hop: parseInt(m[1]), ip: m[2], ms: parseFloat(m[3]) };
      }).filter(Boolean);
      result.trace = { hops, raw: out.split('\n').slice(0, 20).join('\n') };
    } else {
      result.trace = { error: 'tracepath/traceroute not available' };
    }
  } catch(e) {
    result.trace = { error: e.message.slice(0, 200) };
  }

  return result;
}

// Cache last diagnostic per site
const diagCache = {};

app.post('/api/diagnose/:id', async (req, res) => {
  const { sites } = loadSites();
  const site = sites.find(s => s.id === req.params.id);
  if (!site) return res.status(404).json({ error: 'Not found' });
  const result = await runDiagnostic(site.url);
  diagCache[site.id] = result;
  res.json(result);
});

app.get('/api/diagnose/:id', (req, res) => {
  res.json(diagCache[req.params.id] || null);
});

// Network routes (peer API + bootstrap endpoints)
registerNetworkRoutes(app, loadConfig, (() => { const cfg = loadConfig(); return cfg.network?.nodeUrl || ''; })());


// ─── Badges SVG ───────────────────────────────────────────────────
app.get('/badge/:name', (req, res) => {
  const name = req.params.name;
  // Find site by name (case-insensitive) or id
  const { sites } = loadSites();
  const site = sites.find(s =>
    s.name.toLowerCase() === name.toLowerCase() ||
    s.id === name ||
    (s.url && s.url.toLowerCase().includes(name.toLowerCase()))
  );
  const s = site ? status[site.id] : null;
  const up = s ? s.up : null;
  const color = up === true ? '#2affa0' : up === false ? '#ff3d6b' : '#4a4d6e';
  const label = up === true ? 'operativo' : up === false ? 'caído' : 'desconocido';
  const dot = up === true ? '●' : up === false ? '●' : '○';
  const siteName = site ? site.name : name;
  const textWidth = siteName.length * 6.5 + 20;
  const totalWidth = textWidth + 80;

  res.setHeader('Content-Type', 'image/svg+xml');
  res.setHeader('Cache-Control', 'no-cache, max-age=60');
  res.send(`<svg xmlns="http://www.w3.org/2000/svg" width="${totalWidth}" height="20">
    <rect width="${totalWidth}" height="20" rx="4" fill="#1a1c2e"/>
    <rect x="0" y="0" width="${textWidth}" height="20" rx="4" fill="#12141f"/>
    <rect x="${textWidth-4}" y="0" width="4" height="20" fill="#12141f"/>
    <text x="10" y="14" font-family="monospace" font-size="11" fill="#dde0f5">${siteName}</text>
    <text x="${textWidth + 8}" y="14" font-family="monospace" font-size="11" fill="${color}">${dot} ${label}</text>
  </svg>`);
});

// ─── Releases ─────────────────────────────────────────────────────
app.get('/api/releases', async (req, res) => {
  // RELEASES_DIR = DATA_DIR/releases/ — bind-mounted, persists across updates
  const releasesJson = path.join(__dirname, '../public/releases.json');

  // Scan actual ZIP files in RELEASES_DIR (bind-mounted, persists across updates)
  let scannedFiles = [];
  if (fs.existsSync(RELEASES_DIR)) {
    scannedFiles = fs.readdirSync(RELEASES_DIR)
      .filter(f => f.endsWith('.zip') && f.startsWith('statusmon-'))
      .map(f => {
        const versionMatch = f.match(/statusmon-v([\d.+]+)\.zip/);
        const version = versionMatch ? versionMatch[1] : f.replace('statusmon-','').replace('.zip','');
        const stat = fs.statSync(path.join(RELEASES_DIR, f));
        return {
          version,
          filename: f,
          size: stat.size,
          downloadUrl: '/releases/' + f,
          date: stat.mtime.toISOString().slice(0,10),
        };
      })
      .sort((a, b) => b.version.localeCompare(a.version, undefined, {numeric:true}));
  }

  // Merge with releases.json metadata (descriptions etc)
  let metadata = { releases: [], remoteUrl: '' };
  if (fs.existsSync(releasesJson)) {
    try { metadata = JSON.parse(fs.readFileSync(releasesJson, 'utf8')); } catch {}
  }

  // Fetch remote releases server-side (no browser CORS/SSL issues)
  let remoteReleases = [];
  const remoteUrl = metadata.remoteUrl || '';
  if (remoteUrl) {
    try {
      remoteReleases = await new Promise((resolve) => {
        const mod = remoteUrl.startsWith('https') ? https : http;
        const reqRemote = mod.get(remoteUrl, { timeout: 4000 }, r => {
          if (r.statusCode !== 200) return resolve([]);
          const chunks = [];
          r.on('data', c => chunks.push(c));
          r.on('end', () => {
            try { resolve(JSON.parse(Buffer.concat(chunks).toString()).releases || []); }
            catch { resolve([]); }
          });
        });
        reqRemote.on('error', () => resolve([]));
        reqRemote.on('timeout', () => { reqRemote.destroy(); resolve([]); });
      });
    } catch { remoteReleases = []; }
  }

  // Merge: local metadata + remote, scanned files take priority for download URLs
  const allMeta = [...metadata.releases];
  remoteReleases.forEach(r => {
    if (!allMeta.find(m => m.version === r.version)) allMeta.push(r);
  });

  // Ensure the currently running version is always present in the list
  if (!allMeta.find(m => m.version === APP_VERSION)) {
    allMeta.push({
      version: APP_VERSION,
      title: `StatusMon v${APP_VERSION}`,
      date: new Date().toISOString().slice(0, 10),
    });
  }

  const merged = allMeta.map(r => {
    const scanned = scannedFiles.find(s => s.version === r.version);
    const isCurrent = r.version === APP_VERSION;
    return {
      ...r,
      ...(scanned ? { downloadUrl: scanned.downloadUrl, size: scanned.size } : {}),
      // Running version is always "available" — it's what's running right now
      available: scanned ? true : (isCurrent ? true : (r.available || false)),
      current: isCurrent,
    };
  });

  // Add scanned files not in metadata
  scannedFiles.forEach(s => {
    if (!merged.find(r => r.version === s.version)) {
      merged.push({ version: s.version, title: 'StatusMon v'+s.version, date: s.date, downloadUrl: s.downloadUrl, size: s.size, available: true, current: s.version === APP_VERSION });
    }
  });

  merged.sort((a, b) => b.version.localeCompare(a.version, undefined, {numeric:true}));

  res.json({
    releases: merged,
    currentVersion: APP_VERSION,
    scannedFiles: scannedFiles.length,
    source: remoteReleases.length ? 'merged' : 'local',
    remoteUrl,
  });
});

// ─── About / community stats ──────────────────────────────────────
app.get('/api/about', (req, res) => {
  const cfg = loadConfig();
  const { getAllPeers, getActivePeers } = require('./network/peers');
  let networkStats = { activePeers: 0, totalPeers: 0 };
  try {
    networkStats = { activePeers: getActivePeers().length, totalPeers: getAllPeers().length };
  } catch {}
  res.json({
    version: APP_VERSION,
    networkEnabled: cfg.network?.enabled || false,
    networkStats,
  });
});

// ─── Heartbeat ping (public — called by external cron jobs) ──────
app.post('/api/heartbeat/:id/ping', (req, res) => {
  const { sites } = loadSites();
  const site = sites.find(s => s.id === req.params.id);
  if (!site) return res.status(404).json({ error: 'Not found' });
  _lastHeartbeatPing[req.params.id] = Date.now();
  // Update live status immediately
  const result = checkHeartbeat(site);
  const ts = Date.now();
  status[site.id] = { ...result, lastCheck: ts, name: site.name, url: site.url, id: site.id };
  res.json({ ok: true, ts });
});

// ─── SLA report ───────────────────────────────────────────────────
app.get('/api/sla/:id', (req, res) => {
  const { sites } = loadSites();
  const site = sites.find(s => s.id === req.params.id);
  if (!site) return res.status(404).json({ error: 'Not found' });
  const h = history[req.params.id] || [];
  const { period = 'monthly', year, month } = req.query;

  let from, to, label;
  const now = Date.now();
  if (period === 'monthly' && year && month) {
    from  = new Date(parseInt(year), parseInt(month) - 1, 1).getTime();
    to    = new Date(parseInt(year), parseInt(month), 1).getTime();
    label = `${year}-${String(month).padStart(2, '0')}`;
  } else if (period === '7d') {
    from = now - 7 * 86400000; to = now; label = 'last-7d';
  } else {
    from = now - 30 * 86400000; to = now; label = 'last-30d';
  }

  const filtered  = h.filter(e => e.ts >= from && e.ts < to);
  const upCount   = filtered.filter(e => e.up).length;
  const downCount = filtered.length - upCount;
  const uptimePct = filtered.length ? +(upCount / filtered.length * 100).toFixed(4) : null;

  // Compute outage periods
  const outages = [];
  let outStart = null;
  for (const e of filtered) {
    if (!e.up && outStart === null) outStart = e.ts;
    if (e.up && outStart !== null) { outages.push({ from: outStart, to: e.ts, durationMs: e.ts - outStart }); outStart = null; }
  }
  if (outStart !== null) outages.push({ from: outStart, to: now, durationMs: now - outStart });
  const totalDowntimeMs  = outages.reduce((a, o) => a + o.durationMs, 0);

  if (req.query.format === 'csv') {
    const name = site.name.replace(/[^a-z0-9]/gi, '_');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="sla-${name}-${label}.csv"`);
    const rows = ['period,site,total_checks,up_checks,down_checks,uptime_pct,downtime_min,outages'];
    rows.push([label, site.name, filtered.length, upCount, downCount, uptimePct ?? '', Math.round(totalDowntimeMs / 60000), outages.length].join(','));
    // Outage detail rows
    if (outages.length) {
      rows.push('');
      rows.push('outage_from,outage_to,duration_min');
      outages.forEach(o => rows.push([new Date(o.from).toISOString(), new Date(o.to).toISOString(), Math.round(o.durationMs / 60000)].join(',')));
    }
    return res.send(rows.join('\n'));
  }

  res.json({ site: site.name, period: label, from, to, total: filtered.length, upCount, downCount, uptimePct, totalDowntimeMs, totalDowntimeMin: Math.round(totalDowntimeMs / 60000), outages });
});

// ─── Push notification endpoints ──────────────────────────────────
app.get('/api/push/vapid-key', (req, res) => {
  if (!push) return res.status(503).json({ error: 'Push not available' });
  const key = push.getPublicKey();
  if (!key) return res.status(503).json({ error: 'Push not initialized' });
  res.json({ publicKey: key });
});

app.post('/api/push/subscribe', requireAuth, (req, res) => {
  if (!push) return res.status(503).json({ error: 'Push not available' });
  const sub = req.body;
  if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth)
    return res.status(400).json({ error: 'Invalid subscription object' });
  const count = push.addSubscription(sub);
  res.json({ ok: true, total: count });
});

app.delete('/api/push/subscribe', requireAuth, (req, res) => {
  if (!push) return res.status(503).json({ error: 'Push not available' });
  const { endpoint } = req.body;
  if (!endpoint) return res.status(400).json({ error: 'endpoint required' });
  push.removeSubscription(endpoint);
  res.json({ ok: true });
});

app.get('/api/push/status', requireAuth, (req, res) => {
  if (!push) return res.json({ available: false });
  res.json({ available: true, subscriptions: push.getSubscriptionCount() });
});

app.delete('/api/push/subscriptions', requireAuth, (req, res) => {
  if (!push) return res.status(404).json({ error: 'Push no disponible' });
  push.clearAllSubscriptions();
  res.json({ ok: true });
});

// POST /api/mail/test — envía email de prueba con la config actual
app.post('/api/mail/test', requireAuth, async (req, res) => {
  const cfg = loadConfig();
  const smtp = cfg.smtp;
  if (!smtp.enabled || !smtp.to) return res.status(400).json({ error: 'Email no activado o sin destinatario' });
  try {
    await sendEmail(cfg, { name: 'Test StatusMon', url: 'https://statusmon' }, { up: true, responseTime: 0 }, 'test');
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Serve public status page
// ─── Page routes ──────────────────────────────────────────────────
// Root → public status page
app.get('/', (req, res) => res.sendFile(path.join(__dirname, '../public/status.html')));
app.get('/status', (req, res) => res.sendFile(path.join(__dirname, '../public/status.html')));
app.get('/status/:tag', (req, res) => res.sendFile(path.join(__dirname, '../public/status.html')));

// Admin panel (requires auth handled client-side)
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, '../public/admin.html')));
app.get('/about', (req, res) => res.sendFile(path.join(__dirname, '../public/about.html')));
app.get('/network', (req, res) => res.sendFile(path.join(__dirname, '../public/network.html')));

// Serve releases from DATA_DIR/releases/ (bind-mounted, persists across updates)
app.use('/releases', require('express').static(RELEASES_DIR));

// /releases/latest → redirect to latest zip
app.get('/releases/latest', (req, res) => {
  try {
    const files = fs.readdirSync(RELEASES_DIR)
      .filter(f => f.endsWith('.zip') && f.startsWith('statusmon-'))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    if (!files.length) return res.status(404).json({ error: 'No releases found' });
    res.redirect('/releases/' + files[0]);
  } catch {
    res.status(404).json({ error: 'No releases found' });
  }
});

// Widget (embeddable iframe)
app.get('/widget', (req, res) => res.sendFile(path.join(__dirname, '../public/widget.html')));
app.get('/widget/:tag', (req, res) => res.sendFile(path.join(__dirname, '../public/widget.html')));

// Tag filter routes — must be after all /api/* routes
app.get('/:tag', (req, res, next) => {
  const reserved = ['admin','widget','login','manifest.json','sw.js','icon-192.svg','icon-512.svg'];
  if (reserved.includes(req.params.tag) || req.params.tag.includes('.')) return next();
  res.sendFile(path.join(__dirname, '../public/status.html'));
});

// Flush history on graceful shutdown
function shutdownFlush() {
  flushHistoryNow();
  // Flush metrics history to disk
  if (metricsHistory.length > 0) {
    try { atomicWriteFileSync(METRICS_FILE, JSON.stringify(metricsHistory)); } catch {}
  }
  // Always save peers on shutdown regardless of peersMemoryOnly
  try { netPeers.savePeers(); } catch {}
  process.exit(0);
}
process.on('SIGTERM', shutdownFlush);
process.on('SIGINT', shutdownFlush);

// Red de seguridad: un error aislado (p.ej. una URL malformada en un check, un
// webhook roto) NUNCA debe tumbar el monitor entero ni provocar un bucle de
// reinicios. Lo registramos y seguimos vivos.
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException] error no capturado — la app sigue en marcha:', (err && err.stack) || err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection] promesa rechazada sin manejar — la app sigue en marcha:', (reason && reason.stack) || reason);
});

app.listen(PORT, () => {
  console.log(`StatusMon v${APP_VERSION} :${PORT}`);
  if (push) {
    const cfg = loadConfig();
    push.init(DATA_DIR, cfg.smtp?.from ? `mailto:${cfg.smtp.from}` : undefined);
    console.log(`Push VAPID ready (public key: ${push.getPublicKey()?.slice(0, 12)}…)`);
  }
  initNetwork();
  autoDetectContinent();
  runChecks();
  scheduleChecks();
  scheduleNasRefresh();
  scheduleMetrics();
  scheduleAutoBackup();
  scheduleSafetyFlush();
  refreshExternalTime();
  setInterval(refreshExternalTime, 5 * 60 * 1000); // refresca el offset NTP cada 5 min
});
