// Manual Phase 2 smoke test: pairs like manual-pairing-test.js, then starts
// an agent session, sends one line of input, and prints whatever comes back
// so we can eyeball that the PTY relay round-trips correctly.
//
// Usage: node test/manual-session-test.js '<pairing JSON from QR>'
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
let sessionKeys = null;

function sendEnc(obj) {
  const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
  const plaintext = sodium.from_string(JSON.stringify(obj));
  const ciphertext = sodium.crypto_secretbox_easy(plaintext, nonce, sessionKeys.tx);
  ws.send(JSON.stringify({ type: 'enc', nonce: b64(nonce), ciphertext: b64(ciphertext) }));
}

ws.on('open', () => {
  console.log('WS open, sending hello...');
  ws.send(JSON.stringify({ type: 'hello', pub: b64(clientKeypair.publicKey), token: payload.token }));
});

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
    console.log(`Handshake complete. deviceToken=${msg.deviceToken}`);
    console.log('Starting agent session...');
    sendEnc({ type: 'session:start', cols: 100, rows: 30 });
    return;
  }

  if (msg.type === 'hello-reject') {
    console.error('Rejected:', msg.reason);
    process.exit(1);
  }

  if (msg.type === 'enc' && sessionKeys) {
    const nonce = fromB64(msg.nonce);
    const ciphertext = fromB64(msg.ciphertext);
    const plaintext = sodium.crypto_secretbox_open_easy(ciphertext, nonce, sessionKeys.rx);
    const inner = JSON.parse(sodium.to_string(plaintext));

    if (inner.type === 'session:started') {
      console.log(`session:started (resumed=${inner.resumed}) — sending a command in 1s...`);
      setTimeout(() => {
        sendEnc({ type: 'session:input', data: 'echo PTY_RELAY_WORKS\n' });
      }, 1000);
      return;
    }

    if (inner.type === 'session:output') {
      process.stdout.write(inner.data);
      if (inner.data.includes('PTY_RELAY_WORKS')) {
        console.log('\n\nPTY RELAY CONFIRMED — exiting.');
        sendEnc({ type: 'session:stop' });
        setTimeout(() => process.exit(0), 300);
      }
      return;
    }

    if (inner.type === 'session:exit') {
      console.log('session:exit', inner);
      process.exit(0);
    }
  }
});

ws.on('error', (err) => {
  console.error('WS error:', err.message);
  process.exit(1);
});

setTimeout(() => {
  console.error('Timed out');
  process.exit(1);
}, 20000);
