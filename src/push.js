'use strict';
// src/push.js — Web Push (VAPID + RFC 8291 aes128gcm) without npm deps
const crypto = require('crypto');
const https  = require('https');
const http   = require('http');
const fs     = require('fs');
const path   = require('path');

let _dataDir = null;
let _vapidKeys = null;
let _subject  = 'mailto:admin@statusmon.local';

function init(dataDir, subject) {
  _dataDir = dataDir;
  if (subject) _subject = subject;
  _vapidKeys = _loadOrCreateVapidKeys();
}

function getPublicKey() { return _vapidKeys ? _vapidKeys.pub : null; }

// ─── VAPID key management ─────────────────────────────────────────
// P-256 SPKI DER header is 26 bytes; remaining 65 bytes = uncompressed point
function _loadOrCreateVapidKeys() {
  if (!_dataDir) return null;
  const keyFile = path.join(_dataDir, '.vapid.json');
  if (fs.existsSync(keyFile)) {
    try { return JSON.parse(fs.readFileSync(keyFile, 'utf8')); } catch {}
  }
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', {
    namedCurve: 'P-256',
    publicKeyEncoding:  { type: 'spki',  format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'der' },
  });
  const rawPub = publicKey.slice(26); // 65 bytes: 0x04 || x(32) || y(32)
  const keys = {
    pub:  rawPub.toString('base64url'),   // for browser applicationServerKey
    priv: privateKey.toString('base64'),  // PKCS8 DER, for signing JWTs
  };
  fs.writeFileSync(keyFile, JSON.stringify(keys), { mode: 0o600 });
  return keys;
}

// ─── Subscription store ───────────────────────────────────────────
function _subsFile()  { return path.join(_dataDir, '.push-subs.json'); }
function _loadSubs()  { try { return JSON.parse(fs.readFileSync(_subsFile(), 'utf8')); } catch { return []; } }
function _saveSubs(a) {
  try { fs.writeFileSync(_subsFile(), JSON.stringify(a)); }
  catch(e) { console.warn('Push: no se pudo guardar suscripciones:', e.message); }
}
function clearAllSubscriptions() { _saveSubs([]); }

function addSubscription(sub) {
  const arr = _loadSubs();
  const idx = arr.findIndex(s => s.endpoint === sub.endpoint);
  if (idx >= 0) arr[idx] = sub; else arr.push(sub);
  _saveSubs(arr);
  return arr.length;
}
function removeSubscription(endpoint) {
  _saveSubs(_loadSubs().filter(s => s.endpoint !== endpoint));
}

// ─── HKDF helpers (RFC 5869) ──────────────────────────────────────
function _hkdfExtract(salt, ikm) {
  return crypto.createHmac('sha256', salt).update(ikm).digest();
}
function _hkdfExpand(prk, info, len) {
  const blocks = Math.ceil(len / 32);
  const out = Buffer.alloc(blocks * 32);
  let t = Buffer.alloc(0);
  for (let i = 1; i <= blocks; i++) {
    const h = crypto.createHmac('sha256', prk);
    h.update(t); h.update(info); h.update(Buffer.from([i]));
    t = h.digest();
    t.copy(out, (i - 1) * 32);
  }
  return out.slice(0, len);
}

// ─── RFC 8291 aes128gcm message encryption ────────────────────────
function _encrypt(subscription, payload) {
  const rcvPub = Buffer.from(subscription.keys.p256dh, 'base64url');
  const auth   = Buffer.from(subscription.keys.auth,   'base64url');
  const plain  = Buffer.isBuffer(payload)
    ? payload
    : Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload));

  // Ephemeral sender ECDH key pair
  const sndEcdh = crypto.createECDH('prime256v1');
  sndEcdh.generateKeys();
  const sndPub  = sndEcdh.getPublicKey(); // 65-byte uncompressed point

  // ECDH shared secret
  const ecdhSec = sndEcdh.computeSecret(rcvPub);

  // Combine with auth secret (RFC 8291 §3.3)
  const prk1  = _hkdfExtract(auth, ecdhSec);
  const info1 = Buffer.concat([Buffer.from('WebPush: info\x00'), rcvPub, sndPub]);
  const ikm   = _hkdfExpand(prk1, info1, 32);

  // Derive CEK + nonce from random salt
  const salt  = crypto.randomBytes(16);
  const prk2  = _hkdfExtract(salt, ikm);
  const cek   = _hkdfExpand(prk2, Buffer.from('Content-Encoding: aes128gcm\x00'), 16);
  const nonce = _hkdfExpand(prk2, Buffer.from('Content-Encoding: nonce\x00'), 12);

  // AES-128-GCM encrypt; pad with 0x02 (last-record delimiter per RFC 8188)
  const padded = Buffer.concat([plain, Buffer.from([2])]);
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const ct     = Buffer.concat([cipher.update(padded), cipher.final(), cipher.getAuthTag()]);

  // Build aes128gcm body: salt(16) | rs(4 BE) | idlen(1) | keyid(65) | ciphertext
  const rs = Buffer.allocUnsafe(4);
  rs.writeUInt32BE(4096, 0);
  return Buffer.concat([salt, rs, Buffer.from([sndPub.length]), sndPub, ct]);
}

// ─── VAPID JWT (ES256) ────────────────────────────────────────────
function _makeJwt(audience) {
  const hdr = Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })).toString('base64url');
  const exp = Math.floor(Date.now() / 1000) + 43200; // 12 h
  const pld = Buffer.from(JSON.stringify({ aud: audience, exp, sub: _subject })).toString('base64url');
  const data = `${hdr}.${pld}`;

  const privKey = crypto.createPrivateKey({
    key:    Buffer.from(_vapidKeys.priv, 'base64'),
    format: 'der',
    type:   'pkcs8',
  });
  // ieee-p1363 = raw r||s (64 bytes) required by JWT ES256
  const sig = crypto.createSign('SHA256').update(data)
    .sign({ key: privKey, dsaEncoding: 'ieee-p1363' });
  return `${data}.${sig.toString('base64url')}`;
}

// ─── Deliver to one endpoint ──────────────────────────────────────
function _deliverOne(sub, body) {
  return new Promise((resolve) => {
    try {
      const u   = new URL(sub.endpoint);
      const jwt = _makeJwt(`${u.protocol}//${u.host}`);
      const lib = u.protocol === 'https:' ? https : http;
      const req = lib.request({
        hostname: u.hostname,
        port:     u.port || (u.protocol === 'https:' ? 443 : 80),
        path:     u.pathname + u.search,
        method:   'POST',
        headers: {
          'Authorization':   `vapid t=${jwt},k=${_vapidKeys.pub}`,
          'Content-Type':    'application/octet-stream',
          'Content-Encoding':'aes128gcm',
          'TTL':             '86400',
          'Content-Length':  body.length,
        },
      }, (res) => {
        res.resume();
        if (res.statusCode === 410 || res.statusCode === 404) removeSubscription(sub.endpoint);
        resolve({ ok: res.statusCode < 300, status: res.statusCode });
      });
      req.on('error', (e) => resolve({ ok: false, error: e.message }));
      req.setTimeout(10000, () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
      req.write(body);
      req.end();
    } catch(e) { resolve({ ok: false, error: e.message }); }
  });
}

// ─── Public API ───────────────────────────────────────────────────
async function notifyAll(payload) {
  if (!_vapidKeys) return;
  const subs = _loadSubs();
  if (!subs.length) return;
  const results = await Promise.all(subs.map(async sub => {
    try {
      const body = _encrypt(sub, payload);
      return await _deliverOne(sub, body);
    } catch(e) {
      console.warn('Push error:', e.message);
      return { ok: false, error: e.message };
    }
  }));
  const ok      = results.filter(r => r.ok).length;
  const expired = results.filter(r => r.status === 404 || r.status === 410).length;
  const failed  = results.filter(r => !r.ok && r.status !== 404 && r.status !== 410).length;
  if (ok > 0)      console.log(`Push: ${ok}/${subs.length} entregadas`);
  if (expired > 0) console.log(`Push: ${expired} suscripción(es) expirada(s) eliminadas automáticamente`);
  if (failed > 0)  console.warn(`Push: ${failed} fallo(s) de entrega (endpoint accesible pero rechazó)`);
}

function getSubscriptionCount() { return _loadSubs().length; }

module.exports = { init, getPublicKey, addSubscription, removeSubscription, notifyAll, getSubscriptionCount, clearAllSubscriptions };
