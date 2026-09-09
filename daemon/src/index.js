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
import { listAdaptersWithAvailability, getAdapter } from './adapters.js';
import { isCodeServerInstalled, generatePassword, startCodeServer } from './codeServer.js';
import {
  isDockerAvailable,
  generateVncPassword,
  buildImageIfNeeded,
  startContainer,
  stopContainer,
} from './dockerGui.js';

const LOCAL_PORT = process.env.REMOTEBUILD_PORT
  ? Number(process.env.REMOTEBUILD_PORT)
  : 7532;

const CODE_SERVER_PORT = process.env.REMOTEBUILD_CODE_SERVER_PORT
  ? Number(process.env.REMOTEBUILD_CODE_SERVER_PORT)
  : 8080;

const GUI_PORT = process.env.REMOTEBUILD_GUI_PORT
  ? Number(process.env.REMOTEBUILD_GUI_PORT)
  : 6080;

const GUI_APP_CMD = process.env.GUI_APP_CMD || null; // null = image default (xterm stand-in)
const GUI_CONTAINER_NAME = 'remotebuild-gui-session';

const AGENT_CWD = process.env.AGENT_CWD || process.cwd();
const IDE_WORKSPACE_DIR = process.env.IDE_WORKSPACE_DIR || AGENT_CWD;

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
  // rest of this daemon's lifetime without rescanning, using a longer-lived
  // device token.
  const deviceTokens = new Set();
  // Which session each device was last attached to, so a reconnect can
  // resume the right one automatically.
  const deviceLastAttached = new Map();

  // Multiple agent sessions (possibly different CLI agents) can run
  // concurrently. Only one is "attached" to the paired connection at a
  // time — its output streams live; the rest keep running and buffering
  // in the background until attached to.
  const sessions = new Map(); // sessionId -> { id, adapterId, agent }

  // Single active connection, matching Phase 1's one-device-at-a-time scope.
  let paired = null; // { rx, tx, id, ws, deviceToken, attachedSessionId }

  // code-server (VS Code in the browser), started once below if installed.
  // null means unavailable — the client shows it as disabled rather than
  // failing when the phone tries to open it.
  let ideInfo = null; // { url, password }
  let codeServerProcess = null;

  // Docker + Xvfb + noVNC container for closed GUI tools with no server
  // mode (Cursor, Antigravity). Same non-fatal-if-unavailable pattern as
  // code-server.
  let guiInfo = null; // { url, password }

  function sendEncrypted(ws, key, obj) {
    if (ws.readyState !== ws.OPEN) return;
    const frame = encrypt(key, obj);
    ws.send(JSON.stringify({ type: 'enc', ...frame }));
  }

  function sessionSummaries() {
    return [...sessions.values()].map((s) => ({
      sessionId: s.id,
      adapterId: s.adapterId,
      exited: s.agent.exited,
    }));
  }

  function sendPickerData(ws, tx) {
    sendEncrypted(ws, tx, { type: 'adapters:list', adapters: listAdaptersWithAvailability() });
    sendEncrypted(ws, tx, { type: 'session:list', sessions: sessionSummaries() });
    sendEncrypted(ws, tx, {
      type: 'ide:info',
      available: Boolean(ideInfo),
      url: ideInfo?.url,
      password: ideInfo?.password,
    });
    sendEncrypted(ws, tx, {
      type: 'gui:info',
      available: Boolean(guiInfo),
      url: guiInfo?.url,
      password: guiInfo?.password,
    });
  }

  function createSession(adapterId, cols, rows) {
    const adapter = getAdapter(adapterId);
    if (!adapter) return null;

    const id = randomUUID();
    const agent = new AgentSession({
      cmd: adapter.cmd,
      args: adapter.args,
      cwd: AGENT_CWD,
      cols: cols || 100,
      rows: rows || 30,
      onData: (data) => {
        if (paired && paired.attachedSessionId === id) {
          sendEncrypted(paired.ws, paired.tx, { type: 'session:output', sessionId: id, data });
        }
      },
      onExit: ({ exitCode, signal }) => {
        if (paired) {
          sendEncrypted(paired.ws, paired.tx, {
            type: 'session:exit',
            sessionId: id,
            exitCode,
            signal,
          });
        }
        sessions.delete(id);
      },
    });

    sessions.set(id, { id, adapterId, agent });
    console.log(`Session ${id} started: ${adapter.label} (${adapter.cmd})`);
    return sessions.get(id);
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

        paired = { rx, tx, id: connId, ws, deviceToken, attachedSessionId: null };
        handshakeComplete = true;

        ws.send(
          JSON.stringify({
            type: 'hello-ack',
            pub: publicKeyToB64(serverKeypair),
            deviceToken,
          }),
        );
        console.log(`[${connId}] paired successfully — session encrypted`);

        const lastId = deviceLastAttached.get(deviceToken);
        const lastEntry = lastId ? sessions.get(lastId) : null;
        if (lastEntry) {
          paired.attachedSessionId = lastEntry.id;
          sendEncrypted(ws, tx, {
            type: 'session:started',
            sessionId: lastEntry.id,
            adapterId: lastEntry.adapterId,
            resumed: true,
          });
          if (lastEntry.agent.buffer) {
            sendEncrypted(ws, tx, {
              type: 'session:output',
              sessionId: lastEntry.id,
              data: lastEntry.agent.buffer,
            });
          }
        }

        sendPickerData(ws, tx);
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

        case 'adapters:list': {
          sendEncrypted(ws, paired.tx, { type: 'adapters:list', adapters: listAdaptersWithAvailability() });
          break;
        }

        case 'session:list': {
          sendEncrypted(ws, paired.tx, { type: 'session:list', sessions: sessionSummaries() });
          break;
        }

        case 'ide:info': {
          sendEncrypted(ws, paired.tx, {
            type: 'ide:info',
            available: Boolean(ideInfo),
            url: ideInfo?.url,
            password: ideInfo?.password,
          });
          break;
        }

        case 'gui:info': {
          sendEncrypted(ws, paired.tx, {
            type: 'gui:info',
            available: Boolean(guiInfo),
            url: guiInfo?.url,
            password: guiInfo?.password,
          });
          break;
        }

        case 'session:start': {
          const entry = createSession(inner.adapterId, inner.cols, inner.rows);
          if (!entry) {
            sendEncrypted(ws, paired.tx, {
              type: 'session:error',
              message: `Unknown or unavailable adapter: ${inner.adapterId}`,
            });
            break;
          }
          paired.attachedSessionId = entry.id;
          deviceLastAttached.set(paired.deviceToken, entry.id);
          sendEncrypted(ws, paired.tx, {
            type: 'session:started',
            sessionId: entry.id,
            adapterId: entry.adapterId,
            resumed: false,
          });
          break;
        }

        case 'session:attach': {
          const entry = sessions.get(inner.sessionId);
          if (!entry) {
            sendEncrypted(ws, paired.tx, { type: 'session:error', message: 'Session not found' });
            break;
          }
          paired.attachedSessionId = entry.id;
          deviceLastAttached.set(paired.deviceToken, entry.id);
          sendEncrypted(ws, paired.tx, {
            type: 'session:started',
            sessionId: entry.id,
            adapterId: entry.adapterId,
            resumed: true,
          });
          if (entry.agent.buffer) {
            sendEncrypted(ws, paired.tx, {
              type: 'session:output',
              sessionId: entry.id,
              data: entry.agent.buffer,
            });
          }
          break;
        }

        case 'session:input': {
          sessions.get(inner.sessionId)?.agent.write(inner.data);
          break;
        }

        case 'session:resize': {
          sessions.get(inner.sessionId)?.agent.resize(inner.cols, inner.rows);
          break;
        }

        case 'session:stop': {
          const entry = sessions.get(inner.sessionId);
          if (entry) {
            entry.agent.kill();
            sessions.delete(inner.sessionId);
            if (paired.attachedSessionId === inner.sessionId) paired.attachedSessionId = null;
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
      // Sessions are intentionally left running so a reconnecting device
      // can resume them — only explicit session:stop or daemon shutdown
      // kills them.
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

  const available = listAdaptersWithAvailability();
  console.log('\nAvailable agent adapters:');
  for (const a of available) {
    console.log(`  ${a.available ? '✓' : '✗'} ${a.label} (${a.id})`);
  }

  if (isCodeServerInstalled()) {
    try {
      console.log('\nStarting code-server (VS Code in the browser)...');
      const password = generatePassword();
      codeServerProcess = await startCodeServer({
        port: CODE_SERVER_PORT,
        workspaceDir: IDE_WORKSPACE_DIR,
        password,
      });
      const { url: codeServerHttpsUrl } = await startTunnel(CODE_SERVER_PORT);
      ideInfo = { url: codeServerHttpsUrl, password };
      console.log(`code-server ready: ${codeServerHttpsUrl}`);
      console.log(`code-server password: ${password}`);
    } catch (err) {
      console.warn(`code-server did not start (IDE tab will be unavailable): ${err.message}`);
      ideInfo = null;
    }
  } else {
    console.log('\ncode-server is not installed — IDE tab will be unavailable.');
    console.log('Install it with:  brew install code-server');
  }

  if (isDockerAvailable()) {
    try {
      await buildImageIfNeeded();
      console.log('\nStarting GUI container (Xvfb + noVNC, for closed IDE tools)...');
      const password = generateVncPassword();
      await startContainer({
        port: GUI_PORT,
        password,
        appCmd: GUI_APP_CMD,
        containerName: GUI_CONTAINER_NAME,
      });
      const { url: guiHttpsUrl } = await startTunnel(GUI_PORT);
      guiInfo = { url: `${guiHttpsUrl}/vnc.html?autoconnect=true`, password };
      console.log(`GUI container ready: ${guiInfo.url}`);
      console.log(`GUI container VNC password: ${password}`);
    } catch (err) {
      console.warn(`GUI container did not start (closed-IDE tab will be unavailable): ${err.message}`);
      guiInfo = null;
    }
  } else {
    console.log('\nDocker is not installed/running — closed-IDE tab will be unavailable.');
    console.log('Install Docker Desktop to enable it.');
  }

  console.log('\nWaiting for a device to pair... (this pairing token is single-use)');

  process.on('SIGINT', () => {
    console.log('\nShutting down...');
    for (const entry of sessions.values()) entry.agent.kill();
    if (codeServerProcess) codeServerProcess.kill();
    stopContainer(GUI_CONTAINER_NAME);
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
