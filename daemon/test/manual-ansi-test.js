// Manual Phase 3 smoke test: pairs, starts a session, sends a command that
// emits raw ANSI color codes, and inspects the RAW bytes the daemon relays
// back — to isolate whether ANSI codes survive the daemon/encryption path
// intact (server-side) versus a client-side (xterm.js) rendering issue.
//
// Usage: node test/manual-ansi-test.js '<pairing JSON from QR>'
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
let collected = '';

function sendEnc(obj) {
  const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
  const plaintext = sodium.from_string(JSON.stringify(obj));
  const ciphertext = sodium.crypto_secretbox_easy(plaintext, nonce, sessionKeys.tx);
  ws.send(JSON.stringify({ type: 'enc', nonce: b64(nonce), ciphertext: b64(ciphertext) }));
}

ws.on('open', () => {
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
      setTimeout(() => {
        sendEnc({
          type: 'session:input',
          data: 'echo -e "\\033[31mRED\\033[0m \\033[32mGREEN\\033[0m \\033[34mBLUE\\033[0m"\n',
        });
      }, 800);
      return;
    }

    if (inner.type === 'session:output') {
      collected += inner.data;
      if (collected.includes('RED') && collected.includes('BLUE')) {
        console.log('Raw bytes received from daemon (JSON-escaped for visibility):');
        console.log(JSON.stringify(collected));
        const hasEscCodes = /\x1b\[\d+m/.test(collected);
        console.log(`\nContains real ANSI escape bytes (\\x1b[..m): ${hasEscCodes}`);
        sendEnc({ type: 'session:stop' });
        setTimeout(() => process.exit(0), 300);
      }
    }
  }
});

ws.on('error', (err) => {
  console.error('WS error:', err.message);
  process.exit(1);
});

setTimeout(() => {
  console.error('Timed out. Collected so far:', JSON.stringify(collected));
  process.exit(1);
}, 15000);
