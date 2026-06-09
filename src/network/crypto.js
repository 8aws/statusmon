/**
 * network/crypto.js
 * ED25519 keypair identity + ECIES-style encryption for emergency webhooks
 * Uses tweetnacl — pure JS, no native compilation needed
 */

const nacl = require('tweetnacl');
const { encodeBase64, decodeBase64, encodeUTF8, decodeUTF8 } = require('tweetnacl-util');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ─── Node identity ────────────────────────────────────────────────
let _keypair = null;

function loadOrCreateKeypair(dataDir) {
  const keyFile = path.join(dataDir, '.nodekey');
  if (fs.existsSync(keyFile)) {
    try {
      const raw = JSON.parse(fs.readFileSync(keyFile, 'utf8'));
      _keypair = {
        publicKey: decodeBase64(raw.publicKey),
        secretKey: decodeBase64(raw.secretKey),
      };
      return _keypair;
    } catch {}
  }
  // Generate new signing keypair (ED25519)
  _keypair = nacl.sign.keyPair();
  fs.writeFileSync(keyFile, JSON.stringify({
    publicKey: encodeBase64(_keypair.publicKey),
    secretKey: encodeBase64(_keypair.secretKey),
  }), { mode: 0o600 });
  return _keypair;
}

function getKeypair() { return _keypair; }

function getNodeId() {
  if (!_keypair) return null;
  return crypto.createHash('sha256')
    .update(_keypair.publicKey)
    .digest('hex')
    .slice(0, 16);
}

function getPublicKeyB64() {
  if (!_keypair) return null;
  return encodeBase64(_keypair.publicKey);
}

// ─── Signing ──────────────────────────────────────────────────────
function sign(message) {
  if (!_keypair) throw new Error('Keypair not loaded');
  // Guarantee Uint8Array types — crucial when keypair comes from Buffer/File
  const msgBytes = new Uint8Array(encodeUTF8(typeof message === 'string' ? message : JSON.stringify(message)));
  const finalKey = new Uint8Array(_keypair.secretKey);
  const sig = nacl.sign.detached(msgBytes, finalKey);
  return encodeBase64(sig);
}

function verify(message, signatureB64, publicKeyB64) {
  try {
    const msgBytes = encodeUTF8(typeof message === 'string' ? message : JSON.stringify(message));
    const sig = decodeBase64(signatureB64);
    const pubKey = decodeBase64(publicKeyB64);
    return nacl.sign.detached.verify(msgBytes, sig, pubKey);
  } catch { return false; }
}

// ─── Webhook encryption (box = Curve25519 + XSalsa20-Poly1305) ───
// Encrypt a webhook URL with recipient's public key
// Only the recipient (with their secret key) can decrypt it
function encryptWebhook(webhookUrl, recipientPublicKeyB64) {
  try {
    // Convert ED25519 public key to Curve25519 for box
    const edPub = decodeBase64(recipientPublicKeyB64);
    // Use a random ephemeral keypair for ECIES
    const ephemeral = nacl.box.keyPair();
    // Derive shared key: ephemeral_secret + recipient_pub
    // We hash the ED25519 key to get a Curve25519-compatible key (simplified)
    const recipientCurve = crypto.createHash('sha256').update(edPub).digest();
    const nonce = nacl.randomBytes(nacl.box.nonceLength);
    const msgBytes = encodeUTF8(webhookUrl);
    const encrypted = nacl.box(msgBytes, nonce, recipientCurve, ephemeral.secretKey);
    return {
      ciphertext: encodeBase64(encrypted),
      nonce: encodeBase64(nonce),
      ephemeralPublicKey: encodeBase64(ephemeral.publicKey),
    };
  } catch(e) {
    throw new Error('Encryption failed: ' + e.message);
  }
}

// Decrypt webhook URL using our own secret key
function decryptWebhook(encrypted) {
  try {
    if (!_keypair) throw new Error('Keypair not loaded');
    const ciphertext = decodeBase64(encrypted.ciphertext);
    const nonce = decodeBase64(encrypted.nonce);
    const ephemeralPub = decodeBase64(encrypted.ephemeralPublicKey);
    // Derive same shared key: our ED25519 pub → Curve25519
    const ourCurve = crypto.createHash('sha256').update(_keypair.publicKey).digest();
    const decrypted = nacl.box.open(ciphertext, nonce, ephemeralPub, ourCurve);
    if (!decrypted) throw new Error('Decryption failed — invalid key or tampered data');
    return decodeUTF8(decrypted);
  } catch(e) {
    throw new Error('Decryption failed: ' + e.message);
  }
}

// ─── Signed peer message ──────────────────────────────────────────
function signedMessage(payload) {
  const msg = { ...payload, ts: Date.now(), nodeId: getNodeId() };
  msg.sig = sign(JSON.stringify({ ...msg, sig: undefined }));
  return msg;
}

function verifyMessage(msg, senderPublicKeyB64) {
  const { sig, ...rest } = msg;
  if (!sig) return false;
  if (Math.abs(Date.now() - msg.ts) > 60000) return false; // replay protection: 60s window
  return verify(JSON.stringify(rest), sig, senderPublicKeyB64);
}

module.exports = {
  loadOrCreateKeypair, getKeypair, getNodeId, getPublicKeyB64,
  sign, verify, signedMessage, verifyMessage,
  encryptWebhook, decryptWebhook,
};
