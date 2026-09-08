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
import { AgentSession } from './agentSession.js';

const LOCAL_PORT = process.env.REMOTEBUILD_PORT
  ? Number(process.env.REMOTEBUILD_PORT)
  : 7532;

const AGENT_CMD = process.env.AGENT_CMD || 'claude';
const AGENT_ARGS = process.env.AGENT_ARGS ? process.env.AGENT_ARGS.split(' ') : [];
const AGENT_CWD = process.env.AGENT_CWD || process.cwd();

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

  // Devices that completed the one-time QR pairing can reconnect for the
  // rest of this daemon's lifetime without rescanning (e.g. after the phone
  // locks or the network drops), using a longer-lived device token.
  const deviceTokens = new Set();

  // Single active connection + single active agent session, matching
  // Phase 1's one-device-at-a-time scope.
  let paired = null; // { rx, tx, id, ws }
  let agentSession = null;

  function sendEncrypted(ws, key, obj) {
    if (ws.readyState !== ws.OPEN) return;
    const frame = encrypt(key, obj);
    ws.send(JSON.stringify({ type: 'enc', ...frame }));
  }

  function startAgentSession(cols, rows) {
    agentSession = new AgentSession({
      cmd: AGENT_CMD,
      args: AGENT_ARGS,
      cwd: AGENT_CWD,
      cols: cols || 100,
      rows: rows || 30,
      onData: (data) => {
        if (paired) sendEncrypted(paired.ws, paired.tx, { type: 'session:output', data });
      },
      onExit: ({ exitCode, signal }) => {
        if (paired) sendEncrypted(paired.ws, paired.tx, { type: 'session:exit', exitCode, signal });
        agentSession = null;
      },
    });
    console.log(`Agent session started: ${AGENT_CMD} ${AGENT_ARGS.join(' ')}`.trim());
  }

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

        const usingPairingToken = Boolean(msg.token);
        const usingDeviceToken = Boolean(msg.deviceToken);

        if (usingPairingToken) {
          if (tokenConsumed || msg.token !== pairingToken) {
            console.warn(`[${connId}] invalid or reused pairing token, rejecting`);
            ws.send(JSON.stringify({ type: 'hello-reject', reason: 'invalid_token' }));
            ws.close(4001, 'invalid token');
            return;
          }
          tokenConsumed = true;
        } else if (usingDeviceToken) {
          if (!deviceTokens.has(msg.deviceToken)) {
            console.warn(`[${connId}] unknown device token, rejecting`);
            ws.send(JSON.stringify({ type: 'hello-reject', reason: 'unknown_device' }));
            ws.close(4001, 'unknown device');
            return;
          }
        } else {
          ws.send(JSON.stringify({ type: 'hello-reject', reason: 'missing_token' }));
          ws.close(4001, 'missing token');
          return;
        }

        const { rx, tx } = deriveServerSessionKeys(serverKeypair, msg.pub);
        const deviceToken = usingDeviceToken ? msg.deviceToken : randomUUID();
        deviceTokens.add(deviceToken);

        paired = { rx, tx, id: connId, ws };
        handshakeComplete = true;

        ws.send(
          JSON.stringify({
            type: 'hello-ack',
            pub: publicKeyToB64(serverKeypair),
            deviceToken,
          }),
        );
        console.log(`[${connId}] paired successfully — session encrypted`);

        // If an agent session is already running (e.g. this device
        // reconnected after a drop), resume it and replay recent output.
        if (agentSession) {
          sendEncrypted(ws, tx, { type: 'session:started', resumed: true });
          if (agentSession.buffer) {
            sendEncrypted(ws, tx, { type: 'session:output', data: agentSession.buffer });
          }
        }
        return;
      }

      // post-handshake: expect encrypted frames
      if (msg.type !== 'enc') {
        console.warn(`[${connId}] expected enc frame, got ${msg.type}`);
        return;
      }

      let inner;
      try {
        inner = decrypt(paired.rx, msg);
      } catch (err) {
        console.warn(`[${connId}] failed to decrypt frame: ${err.message}`);
        return;
      }

      switch (inner.type) {
        case 'ping': {
          sendEncrypted(ws, paired.tx, { type: 'pong', at: Date.now(), echo: inner.at });
          break;
        }

        case 'session:start': {
          if (agentSession) {
            sendEncrypted(ws, paired.tx, { type: 'session:started', resumed: true });
            if (agentSession.buffer) {
              sendEncrypted(ws, paired.tx, { type: 'session:output', data: agentSession.buffer });
            }
            break;
          }
          startAgentSession(inner.cols, inner.rows);
          sendEncrypted(ws, paired.tx, { type: 'session:started', resumed: false });
          break;
        }

        case 'session:input': {
          if (agentSession) agentSession.write(inner.data);
          break;
        }

        case 'session:resize': {
          if (agentSession) agentSession.resize(inner.cols, inner.rows);
          break;
        }

        case 'session:stop': {
          if (agentSession) {
            agentSession.kill();
            agentSession = null;
          }
          break;
        }

        default:
          console.log(`[${connId}] decrypted message:`, inner);
      }
    });

    ws.on('close', () => {
      console.log(`[${connId}] connection closed`);
      if (paired && paired.id === connId) {
        paired = null;
      }
      // Note: the agent session (if any) is intentionally left running so a
      // reconnecting device can resume it — it's only killed on explicit
      // session:stop or daemon shutdown.
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

  console.log(`\nAgent command: ${AGENT_CMD} ${AGENT_ARGS.join(' ')}`.trim());
  console.log('Waiting for a device to pair... (this pairing token is single-use)');

  process.on('SIGINT', () => {
    console.log('\nShutting down...');
    if (agentSession) agentSession.kill();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
