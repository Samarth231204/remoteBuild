// Manual Phase 4 smoke test: pairs, lists adapters, starts TWO concurrent
// sessions (both using the 'shell' adapter, since it's guaranteed present
// regardless of which real CLI agents happen to be installed), confirms
// only the currently-attached session's output streams live, then attaches
// back to the first session and confirms its own scrollback (and only its
// own) replays correctly.
//
// Usage: node test/manual-multisession-test.js '<pairing JSON from QR>'
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

// Every decrypted message is appended here in order, permanently. waitFor()
// scans forward from a cursor rather than installing a single mutable
// handler — a single-handler design silently drops any message that
// doesn't match the *current* predicate if it arrives in the same
// synchronous batch as a match (e.g. session:started + session:output
// both sent back-to-back on reattach), since there's nowhere for an
// unmatched message to go once a handler exists. A persistent, replayable
// log has no such gap.
const allMessages = [];
let cursor = 0;
let pending = null; // { predicate, resolve }

function deliver(inner) {
  allMessages.push(inner);
  if (pending) {
    while (cursor < allMessages.length) {
      const msg = allMessages[cursor++];
      if (pending.predicate(msg)) {
        const { resolve } = pending;
        pending = null;
        resolve(msg);
        return;
      }
    }
  }
}

function sendEnc(obj) {
  const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
  const plaintext = sodium.from_string(JSON.stringify(obj));
  const ciphertext = sodium.crypto_secretbox_easy(plaintext, nonce, sessionKeys.tx);
  ws.send(JSON.stringify({ type: 'enc', nonce: b64(nonce), ciphertext: b64(ciphertext) }));
}

function waitFor(predicate, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    while (cursor < allMessages.length) {
      const msg = allMessages[cursor++];
      if (predicate(msg)) {
        resolve(msg);
        return;
      }
    }
    const timer = setTimeout(() => {
      pending = null;
      reject(new Error('timed out waiting for expected message'));
    }, timeoutMs);
    pending = {
      predicate,
      resolve: (msg) => {
        clearTimeout(timer);
        resolve(msg);
      },
    };
  });
}

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
    deliver(JSON.parse(sodium.to_string(plaintext)));
  }
});

ws.on('error', (err) => {
  console.error('WS error:', err.message);
  process.exit(1);
});

async function main() {
  const adaptersMsg = await waitFor((inner) => inner.type === 'adapters:list');
  console.log(
    'Adapters:',
    adaptersMsg.adapters.map((a) => `${a.id}${a.available ? '' : ' (unavailable)'}`).join(', '),
  );

  console.log('\n--- starting session A (shell) ---');
  sendEnc({ type: 'session:start', adapterId: 'shell', cols: 100, rows: 30 });
  const startedA = await waitFor((inner) => inner.type === 'session:started');
  const sessionA = startedA.sessionId;
  console.log('session A:', sessionA);

  await new Promise((resolve) => setTimeout(resolve, 500));
  sendEnc({ type: 'session:input', sessionId: sessionA, data: 'echo SESSION_A_OUTPUT\n' });
  await waitFor((inner) => inner.type === 'session:output' && inner.data.includes('SESSION_A_OUTPUT'));
  console.log('session A produced its own output correctly');

  console.log('\n--- starting session B (shell), while A keeps running in background ---');
  sendEnc({ type: 'session:start', adapterId: 'shell', cols: 100, rows: 30 });
  const startedB = await waitFor((inner) => inner.type === 'session:started');
  const sessionB = startedB.sessionId;
  console.log('session B:', sessionB, '(now attached; A is backgrounded)');

  const cursorBeforeInput = cursor;
  sendEnc({ type: 'session:input', sessionId: sessionB, data: 'echo SESSION_B_OUTPUT\n' });
  sendEnc({ type: 'session:input', sessionId: sessionA, data: 'echo THIS_SHOULD_NOT_LEAK\n' });
  await waitFor((inner) => inner.type === 'session:output' && inner.data.includes('SESSION_B_OUTPUT'));
  await new Promise((r) => setTimeout(r, 500)); // give any (incorrect) leaked output time to arrive too
  const leakedFromA = allMessages
    .slice(cursorBeforeInput)
    .some((m) => m.type === 'session:output' && m.sessionId === sessionA);
  console.log(`session A output leaked while detached: ${leakedFromA} (should be false)`);

  console.log('\n--- listing sessions ---');
  sendEnc({ type: 'session:list' });
  const list = await waitFor((inner) => inner.type === 'session:list');
  console.log('sessions:', list.sessions.map((s) => `${s.sessionId.slice(0, 8)} (${s.adapterId})`).join(', '));
  const bothListed = list.sessions.length === 2;

  console.log('\n--- attaching back to session A ---');
  sendEnc({ type: 'session:attach', sessionId: sessionA });
  const attachedA = await waitFor((inner) => inner.type === 'session:started' && inner.sessionId === sessionA);
  console.log(`reattached to A, resumed=${attachedA.resumed}`);

  const replay = await waitFor((inner) => inner.type === 'session:output' && inner.sessionId === sessionA);
  const hasOwnOutput = replay.data.includes('SESSION_A_OUTPUT');
  console.log(`scrollback replay contains session A's own output: ${hasOwnOutput}`);

  sendEnc({ type: 'session:stop', sessionId: sessionA });
  sendEnc({ type: 'session:stop', sessionId: sessionB });

  console.log('\n--- results ---');
  const pass = !leakedFromA && bothListed && attachedA.resumed && hasOwnOutput;
  console.log(pass ? 'MULTI-SESSION TEST PASSED' : 'MULTI-SESSION TEST FAILED');
  setTimeout(() => process.exit(pass ? 0 : 1), 300);
}

main().catch((err) => {
  console.error('Test error:', err.message);
  process.exit(1);
});
