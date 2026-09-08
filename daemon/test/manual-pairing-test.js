// Manual Phase 1 smoke test: acts as a "client" (standing in for the PWA),
// reads the daemon's pairing QR payload, does the X25519 handshake, and
// sends an encrypted ping, expecting an encrypted pong back.
//
// Usage: node test/manual-pairing-test.js '<pairing JSON from QR>'
import { createRequire } from 'node:module';
import WebSocket from 'ws';

const require = createRequire(import.meta.url);
const sodium = require('libsodium-wrappers');

const payload = JSON.parse(process.argv[2]);

await sodium.ready;

const clientKeypair = sodium.crypto_kx_keypair();
const b64 = (buf) => sodium.to_base64(buf, sodium.base64_variants.URLSAFE_NO_PADDING);
const fromB64 = (s) => sodium.from_base64(s, sodium.base64_variants.URLSAFE_NO_PADDING);

const ws = new WebSocket(payload.url);

ws.on('open', () => {
  console.log('WS open, sending hello...');
  ws.send(JSON.stringify({ type: 'hello', pub: b64(clientKeypair.publicKey), token: payload.token }));
});

let sessionKeys = null;

ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString());

  if (msg.type === 'hello-ack') {
    const serverPub = fromB64(msg.pub);
    const { sharedRx, sharedTx } = sodium.crypto_kx_client_session_keys(
      clientKeypair.publicKey,
      clientKeypair.privateKey,
      serverPub,
    );
    sessionKeys = { rx: sharedRx, tx: sharedTx };
    console.log('Handshake complete, sending encrypted ping...');
    const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
    const plaintext = sodium.from_string(JSON.stringify({ type: 'ping', at: Date.now() }));
    const ciphertext = sodium.crypto_secretbox_easy(plaintext, nonce, sessionKeys.tx);
    ws.send(JSON.stringify({ type: 'enc', nonce: b64(nonce), ciphertext: b64(ciphertext) }));
    return;
  }

  if (msg.type === 'enc' && sessionKeys) {
    const nonce = fromB64(msg.nonce);
    const ciphertext = fromB64(msg.ciphertext);
    const plaintext = sodium.crypto_secretbox_open_easy(ciphertext, nonce, sessionKeys.rx);
    const inner = JSON.parse(sodium.to_string(plaintext));
    console.log('Decrypted reply from daemon:', inner);
    if (inner.type === 'pong') {
      console.log('PING/PONG ROUND TRIP OK, rtt ms =', Date.now() - inner.echo);
      process.exit(0);
    }
    return;
  }

  if (msg.type === 'hello-reject') {
    console.error('Rejected:', msg.reason);
    process.exit(1);
  }
});

ws.on('error', (err) => {
  console.error('WS error:', err.message);
  process.exit(1);
});

setTimeout(() => {
  console.error('Timed out waiting for pong');
  process.exit(1);
}, 15000);
