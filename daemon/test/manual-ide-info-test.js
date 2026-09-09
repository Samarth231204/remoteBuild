// Manual Phase 5 smoke test: pairs, waits for the daemon's proactive
// ide:info push, and confirms it reports code-server as available with a
// real URL and password (delivered over the encrypted channel, same as
// adapters:list/session:list).
//
// Usage: node test/manual-ide-info-test.js '<pairing JSON from QR>'
import { createRequire } from 'node:module';
import WebSocket from 'ws';

const require = createRequire(import.meta.url);
const sodium = require('libsodium-wrappers');
await sodium.ready;

const payload = JSON.parse(process.argv[2]);
const b64 = (buf) => sodium.to_base64(buf, sodium.base64_variants.URLSAFE_NO_PADDING);
const fromB64 = (s) => sodium.from_base64(s, sodium.base64_variants.URLSAFE_NO_PADDING);

const clientKeypair = sodium.crypto_kx_keypair();
const ws = new WebSocket(payload.url);
let sessionKeys = null;

ws.on('open', () => {
  ws.send(JSON.stringify({ type: 'hello', pub: b64(clientKeypair.publicKey), token: payload.token }));
});

ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString());

  if (msg.type === 'hello-reject') {
    console.error('Rejected:', msg.reason);
    process.exit(1);
  }

  if (msg.type === 'hello-ack') {
    const serverPub = fromB64(msg.pub);
    const { sharedRx, sharedTx } = sodium.crypto_kx_client_session_keys(
      clientKeypair.publicKey,
      clientKeypair.privateKey,
      serverPub,
    );
    sessionKeys = { rx: sharedRx, tx: sharedTx };
    return;
  }

  if (msg.type === 'enc' && sessionKeys) {
    const nonce = fromB64(msg.nonce);
    const ciphertext = fromB64(msg.ciphertext);
    const plaintext = sodium.crypto_secretbox_open_easy(ciphertext, nonce, sessionKeys.rx);
    const inner = JSON.parse(sodium.to_string(plaintext));

    if (inner.type === 'ide:info') {
      console.log('ide:info received:', inner);
      if (inner.available && inner.url && inner.password) {
        console.log('\nIDE_INFO_TEST_PASSED');
        process.exit(0);
      } else {
        console.log('\nIDE_INFO_TEST_FAILED (not available or missing fields)');
        process.exit(1);
      }
    }
  }
});

ws.on('error', (err) => {
  console.error('WS error:', err.message);
  process.exit(1);
});

setTimeout(() => {
  console.error('Timed out waiting for ide:info');
  process.exit(1);
}, 10000);
