import { WebSocketServer } from 'ws';
import { randomUUID } from 'node:crypto';
import {
  initCrypto,
  generateServerKeypair,
  generatePairingToken,
  deriveServerSessionKeys,
  encrypt,
  decrypt,
  publicKeyToB64,
} from './crypto.js';
import { checkCloudflaredInstalled, startTunnel } from './tunnel.js';
import { printQrToTerminal, saveQrPng } from './pairing.js';

const LOCAL_PORT = process.env.REMOTEBUILD_PORT
  ? Number(process.env.REMOTEBUILD_PORT)
  : 7532;

async function main() {
  console.log('remoteBuild daemon starting...\n');

  const hasCloudflared = await checkCloudflaredInstalled();
  if (!hasCloudflared) {
    console.error(
      'cloudflared is not installed or not on PATH.\n' +
        'Install it with:  brew install cloudflared\n' +
        'Then re-run this daemon.',
    );
    process.exit(1);
  }

  await initCrypto();
  const serverKeypair = generateServerKeypair();
  let pairingToken = generatePairingToken();
  let tokenConsumed = false;

  // session state for the single paired client (Phase 1: one device at a time)
  let session = null; // { rx, tx, id }

  const wss = new WebSocketServer({ port: LOCAL_PORT, host: '127.0.0.1' });
  console.log(`Local WebSocket server listening on ws://127.0.0.1:${LOCAL_PORT}`);

  wss.on('connection', (ws) => {
    const connId = randomUUID();
    console.log(`[${connId}] incoming connection`);

    let handshakeComplete = false;

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        console.warn(`[${connId}] dropped non-JSON message`);
        return;
      }

      if (!handshakeComplete) {
        if (msg.type !== 'hello') {
          console.warn(`[${connId}] expected hello, got ${msg.type}`);
          ws.close(4000, 'expected hello');
          return;
        }
        if (tokenConsumed || msg.token !== pairingToken) {
          console.warn(`[${connId}] invalid or reused pairing token, rejecting`);
          ws.send(JSON.stringify({ type: 'hello-reject', reason: 'invalid_token' }));
          ws.close(4001, 'invalid token');
          return;
        }

        tokenConsumed = true;
        const { rx, tx } = deriveServerSessionKeys(serverKeypair, msg.pub);
        session = { rx, tx, id: connId, ws };
        handshakeComplete = true;

        ws.send(
          JSON.stringify({
            type: 'hello-ack',
            pub: publicKeyToB64(serverKeypair),
          }),
        );
        console.log(`[${connId}] paired successfully — session encrypted`);
        return;
      }

      // post-handshake: expect encrypted frames
      if (msg.type !== 'enc') {
        console.warn(`[${connId}] expected enc frame, got ${msg.type}`);
        return;
      }

      let inner;
      try {
        inner = decrypt(session.rx, msg);
      } catch (err) {
        console.warn(`[${connId}] failed to decrypt frame: ${err.message}`);
        return;
      }

      console.log(`[${connId}] decrypted message:`, inner);

      if (inner.type === 'ping') {
        const frame = encrypt(session.tx, { type: 'pong', at: Date.now(), echo: inner.at });
        ws.send(JSON.stringify({ type: 'enc', ...frame }));
      }
    });

    ws.on('close', () => {
      console.log(`[${connId}] connection closed`);
      if (session && session.id === connId) {
        session = null;
      }
    });

    ws.on('error', (err) => {
      console.warn(`[${connId}] socket error: ${err.message}`);
    });
  });

  console.log('Opening Cloudflare Tunnel...');
  const { url: httpsUrl } = await startTunnel(LOCAL_PORT);
  const wssUrl = httpsUrl.replace(/^https:/, 'wss:');
  console.log(`Tunnel established: ${httpsUrl}`);

  const pairingPayload = JSON.stringify({
    v: 1,
    url: wssUrl,
    token: pairingToken,
    pub: publicKeyToB64(serverKeypair),
  });

  console.log('\nScan this QR code from the remoteBuild PWA to pair:\n');
  printQrToTerminal(pairingPayload);
  console.log(`\nPairing payload (for manual/dev testing): ${pairingPayload}`);

  try {
    const pngPath = new URL('../pairing-qr.png', import.meta.url).pathname;
    await saveQrPng(pairingPayload, pngPath);
    console.log(`\n(QR also saved to ${pngPath} if the terminal one doesn't scan)`);
  } catch (err) {
    console.warn(`Could not save QR PNG: ${err.message}`);
  }

  console.log('\nWaiting for a device to pair... (this pairing token is single-use)');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
