// Manual Phase 2 reconnect test: pairs, starts a session, sends input,
// disconnects WITHOUT stopping the session, then reconnects using the
// device token instead of the (already consumed) one-time pairing token,
// and checks that scrollback is replayed.
//
// Usage: node test/manual-reconnect-test.js '<pairing JSON from QR>'
import { createRequire } from 'node:module';
import WebSocket from 'ws';

const require = createRequire(import.meta.url);
const sodium = require('libsodium-wrappers');
await sodium.ready;

const payload = JSON.parse(process.argv[2]);
const b64 = (buf) => sodium.to_base64(buf, sodium.base64_variants.URLSAFE_NO_PADDING);
const fromB64 = (s) => sodium.from_base64(s, sodium.base64_variants.URLSAFE_NO_PADDING);

function connect({ token, deviceToken }) {
  return new Promise((resolve, reject) => {
    const clientKeypair = sodium.crypto_kx_keypair();
    const ws = new WebSocket(payload.url);
    let sessionKeys = null;

    // Messages can arrive bundled in one TCP read right after hello-ack
    // (the daemon sends session:started + buffered output immediately on
    // reconnect), so `ws` may emit several synchronous 'message' events
    // before the `await connect()` continuation runs and attaches a real
    // handler. Queue anything that arrives before a handler is set, and
    // flush it in order once one is.
    const backlog = [];

    const api = {
      sendEnc(obj) {
        const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
        const plaintext = sodium.from_string(JSON.stringify(obj));
        const ciphertext = sodium.crypto_secretbox_easy(plaintext, nonce, sessionKeys.tx);
        ws.send(JSON.stringify({ type: 'enc', nonce: b64(nonce), ciphertext: b64(ciphertext) }));
      },
      close() {
        ws.close();
      },
      setHandler(fn) {
        api._onMessage = fn;
        backlog.splice(0).forEach(fn);
      },
      _onMessage: null,
    };

    ws.on('open', () => {
      const hello = { type: 'hello', pub: b64(clientKeypair.publicKey) };
      if (token) hello.token = token;
      if (deviceToken) hello.deviceToken = deviceToken;
      ws.send(JSON.stringify(hello));
    });

    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());

      if (msg.type === 'hello-reject') {
        reject(new Error(`rejected: ${msg.reason}`));
        return;
      }

      if (msg.type === 'hello-ack') {
        const serverPub = fromB64(msg.pub);
        const { sharedRx, sharedTx } = sodium.crypto_kx_client_session_keys(
          clientKeypair.publicKey,
          clientKeypair.privateKey,
          serverPub,
        );
        sessionKeys = { rx: sharedRx, tx: sharedTx };
        api.deviceToken = msg.deviceToken;
        resolve(api);
        return;
      }

      if (msg.type === 'enc' && sessionKeys) {
        const nonce = fromB64(msg.nonce);
        const ciphertext = fromB64(msg.ciphertext);
        const plaintext = sodium.crypto_secretbox_open_easy(ciphertext, nonce, sessionKeys.rx);
        const inner = JSON.parse(sodium.to_string(plaintext));
        if (api._onMessage) api._onMessage(inner);
        else backlog.push(inner);
      }
    });

    ws.on('error', reject);
  });
}

async function main() {
  console.log('--- first connection: pair + start session + send input ---');
  const conn1 = await connect({ token: payload.token });
  console.log('paired, deviceToken =', conn1.deviceToken);

  await new Promise((resolve) => {
    conn1.setHandler((inner) => {
      if (inner.type === 'session:started') {
        conn1.sendEnc({ type: 'session:input', data: 'echo BEFORE_DISCONNECT\n' });
        setTimeout(resolve, 800);
      }
    });
    conn1.sendEnc({ type: 'session:start', cols: 100, rows: 30 });
  });

  console.log('closing first connection WITHOUT stopping the session...');
  conn1.close();
  await new Promise((r) => setTimeout(r, 500));

  console.log('\n--- second connection: reconnect with device token ---');
  const conn2 = await connect({ deviceToken: conn1.deviceToken });
  console.log('reconnected using device token (no QR rescan)');

  let sawResumed = false;
  let sawScrollback = false;

  await new Promise((resolve, reject) => {
    conn2.setHandler((inner) => {
      if (inner.type === 'session:started') {
        sawResumed = inner.resumed === true;
      }
      if (inner.type === 'session:output' && inner.data.includes('BEFORE_DISCONNECT')) {
        sawScrollback = true;
        resolve();
      }
    });
    setTimeout(() => reject(new Error('timed out waiting for scrollback replay')), 8000);
  });

  console.log(`resumed flag correct: ${sawResumed}`);
  console.log(`scrollback replay contained prior output: ${sawScrollback}`);

  if (sawResumed && sawScrollback) {
    console.log('\nRECONNECT + SCROLLBACK REPLAY CONFIRMED');
    conn2.sendEnc({ type: 'session:stop' });
    setTimeout(() => process.exit(0), 300);
  } else {
    console.log('\nRECONNECT TEST FAILED');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Test error:', err.message);
  process.exit(1);
});
