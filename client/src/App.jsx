import { useCallback, useEffect, useRef, useState } from 'react';
import QrScanner from './QrScanner.jsx';
import XTermView from './XTermView.jsx';
import {
  initCrypto,
  generateClientKeypair,
  deriveClientSessionKeys,
  encrypt,
  decrypt,
  toB64,
} from './crypto.js';
import { stripAnsi } from './ansi.js';
import { detectPermissionPrompt } from './promptDetector.js';
import './App.css';

const STORAGE_KEY = 'remotebuild_pairing';
const PROMPT_TAIL_CHARS = 4000;

function loadSavedPairing() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function savePairing({ url, pub, deviceToken }) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ url, pub, deviceToken }));
  } catch {
    // localStorage unavailable (private mode etc.) — reconnect just won't be offered.
  }
}

function clearSavedPairing() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

// phase: 'idle' | 'scanning' | 'connecting' | 'paired' | 'session' | 'error'
export default function App() {
  const [phase, setPhase] = useState('idle');
  const [log, setLog] = useState([]);
  const [inputValue, setInputValue] = useState('');
  const [savedPairing, setSavedPairing] = useState(() => loadSavedPairing());
  const [pendingPrompt, setPendingPrompt] = useState(null);
  const [adapters, setAdapters] = useState([]);
  const [sessionList, setSessionList] = useState([]);
  const [activeSessionId, setActiveSessionId] = useState(null);
  const [activeAdapterId, setActiveAdapterId] = useState(null);
  const [ideInfo, setIdeInfo] = useState(null); // { available, url, password }
  const [guiInfo, setGuiInfo] = useState(null); // { available, url, password }

  const wsRef = useRef(null);
  const sessionRef = useRef(null); // { rx, tx }
  const xtermRef = useRef(null);
  const promptTailRef = useRef('');
  const activeSessionIdRef = useRef(null);

  const appendLog = useCallback((line) => {
    setLog((prev) => [...prev.slice(-19), `${new Date().toLocaleTimeString()}  ${line}`]);
  }, []);

  const sendFrame = useCallback((obj) => {
    if (!wsRef.current || !sessionRef.current) return;
    const frame = encrypt(sessionRef.current.tx, obj);
    wsRef.current.send(JSON.stringify({ type: 'enc', ...frame }));
  }, []);

  const handleFrame = useCallback(
    (inner) => {
      if (inner.type === 'pong') {
        appendLog(`pong received — round trip ${Date.now() - inner.echo}ms`);
        return;
      }

      if (inner.type === 'adapters:list') {
        setAdapters(inner.adapters);
        return;
      }

      if (inner.type === 'session:list') {
        setSessionList(inner.sessions);
        return;
      }

      if (inner.type === 'ide:info') {
        setIdeInfo(inner);
        return;
      }

      if (inner.type === 'gui:info') {
        setGuiInfo(inner);
        return;
      }

      if (inner.type === 'session:started') {
        appendLog(`session started: ${inner.adapterId} (resumed=${inner.resumed})`);
        // Always start from a clean terminal — the previously displayed
        // content (if any) belongs to whichever session was shown before,
        // and a resumed session's own scrollback arrives right after this
        // as a session:output frame anyway.
        xtermRef.current?.clear();
        promptTailRef.current = '';
        setPendingPrompt(null);
        activeSessionIdRef.current = inner.sessionId;
        setActiveSessionId(inner.sessionId);
        setActiveAdapterId(inner.adapterId);
        setPhase('session');
        return;
      }

      if (inner.type === 'session:output') {
        xtermRef.current?.write(inner.data);

        promptTailRef.current = (promptTailRef.current + stripAnsi(inner.data)).slice(
          -PROMPT_TAIL_CHARS,
        );
        setPendingPrompt(detectPermissionPrompt(promptTailRef.current));
        return;
      }

      if (inner.type === 'session:exit') {
        appendLog(`session exited (code=${inner.exitCode}, signal=${inner.signal})`);
        if (activeSessionIdRef.current === inner.sessionId) {
          activeSessionIdRef.current = null;
          setActiveSessionId(null);
          setActiveAdapterId(null);
          setPendingPrompt(null);
          setPhase('paired');
        }
        return;
      }

      if (inner.type === 'session:error') {
        appendLog(`session error: ${inner.message}`);
      }
    },
    [appendLog],
  );

  const openConnection = useCallback(
    ({ url, helloExtra, onPaired }) => {
      setPhase('connecting');

      initCrypto().then(() => {
        const clientKeypair = generateClientKeypair();
        const ws = new WebSocket(url);
        wsRef.current = ws;

        ws.onopen = () => {
          appendLog(`Connected to ${url}, sending hello...`);
          ws.send(
            JSON.stringify({
              type: 'hello',
              pub: toB64(clientKeypair.publicKey),
              ...helloExtra,
            }),
          );
        };

        ws.onmessage = (evt) => {
          const msg = JSON.parse(evt.data);

          if (msg.type === 'hello-ack') {
            sessionRef.current = deriveClientSessionKeys(clientKeypair, msg.pub);
            appendLog('Handshake complete — session encrypted');
            savePairing({ url, pub: msg.pub, deviceToken: msg.deviceToken });
            setSavedPairing({ url, pub: msg.pub, deviceToken: msg.deviceToken });
            setPhase('paired');
            onPaired?.();
            return;
          }

          if (msg.type === 'hello-reject') {
            appendLog(`Pairing rejected: ${msg.reason}`);
            if (msg.reason === 'unknown_device') clearSavedPairing();
            setPhase('error');
            return;
          }

          if (msg.type === 'enc' && sessionRef.current) {
            handleFrame(decrypt(sessionRef.current.rx, msg));
          }
        };

        ws.onerror = () => {
          appendLog('WebSocket error');
          setPhase('error');
        };

        ws.onclose = () => {
          appendLog('Disconnected');
          setPhase((p) => (p === 'error' ? p : 'idle'));
        };
      });
    },
    [appendLog, handleFrame],
  );

  const handleDecoded = useCallback(
    (text) => {
      let payload;
      try {
        payload = JSON.parse(text);
      } catch {
        appendLog('QR did not contain valid pairing JSON');
        setPhase('error');
        return;
      }
      openConnection({ url: payload.url, helloExtra: { token: payload.token } });
    },
    [appendLog, openConnection],
  );

  const handleReconnect = useCallback(() => {
    if (!savedPairing) return;
    openConnection({
      url: savedPairing.url,
      helloExtra: { deviceToken: savedPairing.deviceToken },
    });
  }, [savedPairing, openConnection]);

  const sendPing = useCallback(() => sendFrame({ type: 'ping', at: Date.now() }), [sendFrame]);

  const startSession = useCallback(
    (adapterId) => {
      const dims = xtermRef.current?.getDims();
      sendFrame({ type: 'session:start', adapterId, cols: dims?.cols || 100, rows: dims?.rows || 30 });
    },
    [sendFrame],
  );

  const attachSession = useCallback(
    (sessionId) => sendFrame({ type: 'session:attach', sessionId }),
    [sendFrame],
  );

  const stopSession = useCallback(() => {
    if (activeSessionIdRef.current) sendFrame({ type: 'session:stop', sessionId: activeSessionIdRef.current });
  }, [sendFrame]);

  const switchToPicker = useCallback(() => {
    setPhase('paired');
    sendFrame({ type: 'session:list' });
  }, [sendFrame]);

  const sendInput = useCallback(() => {
    if (!inputValue || !activeSessionIdRef.current) return;
    sendFrame({ type: 'session:input', sessionId: activeSessionIdRef.current, data: inputValue + '\n' });
    setInputValue('');
  }, [inputValue, sendFrame]);

  // Raw control bytes for navigating interactive TUI menus that can't be
  // driven by typed text alone.
  const sendRaw = useCallback(
    (data) => {
      if (!activeSessionIdRef.current) return;
      sendFrame({ type: 'session:input', sessionId: activeSessionIdRef.current, data });
    },
    [sendFrame],
  );
  const CONTROL_KEYS = [
    { label: '↑', data: '\x1b[A' },
    { label: '↓', data: '\x1b[B' },
    { label: '←', data: '\x1b[D' },
    { label: '→', data: '\x1b[C' },
    { label: 'Enter', data: '\r' },
    { label: 'Esc', data: '\x1b' },
    { label: 'Tab', data: '\t' },
    { label: 'Shift+Tab', data: '\x1b[Z' },
    { label: 'Ctrl+C', data: '\x03' },
  ];

  const forgetDevice = useCallback(() => {
    clearSavedPairing();
    setSavedPairing(null);
  }, []);

  // Once the terminal mounts for a session, tell the daemon its real size
  // (it started with a guessed default). Subsequent size changes are
  // reported by XTermView's own resize handler.
  useEffect(() => {
    if (phase !== 'session' || !activeSessionId) return;
    const dims = xtermRef.current?.getDims();
    if (dims) {
      sendFrame({ type: 'session:resize', sessionId: activeSessionId, cols: dims.cols, rows: dims.rows });
    }
  }, [phase, activeSessionId, sendFrame]);

  const handleApprove = useCallback(() => {
    if (pendingPrompt) sendRaw(pendingPrompt.approveKeys);
    setPendingPrompt(null);
  }, [pendingPrompt, sendRaw]);

  const handleDeny = useCallback(() => {
    if (pendingPrompt) sendRaw(pendingPrompt.denyKeys);
    setPendingPrompt(null);
  }, [pendingPrompt, sendRaw]);

  return (
    <div className="app">
      <h1>remoteBuild</h1>

      {phase === 'idle' && (
        <div className="idle-actions">
          <button className="primary" onClick={() => setPhase('scanning')}>
            Scan QR to pair
          </button>
          {savedPairing && (
            <>
              <button onClick={handleReconnect}>Reconnect (no rescan)</button>
              <button className="ghost" onClick={forgetDevice}>
                Forget saved device
              </button>
            </>
          )}
        </div>
      )}

      {phase === 'scanning' && (
        <QrScanner onDecoded={handleDecoded} onCancel={() => setPhase('idle')} />
      )}

      {phase === 'connecting' && <p>Connecting…</p>}

      {phase === 'paired' && (
        <div className="connected-panel">
          <p className="status-ok">Connected &amp; encrypted</p>
          <button onClick={sendPing}>Send ping</button>

          <h2>Start a new session</h2>
          <div className="adapter-list">
            {adapters.map((a) => (
              <button
                key={a.id}
                className="primary"
                disabled={!a.available}
                onClick={() => startSession(a.id)}
                title={a.available ? '' : 'Not installed on this machine'}
              >
                {a.label}
                {!a.available && ' (not installed)'}
              </button>
            ))}
          </div>

          <h2>IDE</h2>
          {ideInfo?.available ? (
            <div className="ide-panel">
              <p>VS Code (code-server) is running. It opens in a separate tab with its own login.</p>
              <button className="primary" onClick={() => window.open(ideInfo.url, '_blank')}>
                Open VS Code
              </button>
              <div className="ide-password-row">
                <span>Password: </span>
                <code>{ideInfo.password}</code>
                <button
                  className="ghost"
                  onClick={() => navigator.clipboard?.writeText(ideInfo.password).catch(() => {})}
                >
                  Copy
                </button>
              </div>
            </div>
          ) : (
            <p className="muted">code-server not installed on this machine.</p>
          )}

          <h2>Closed IDE tools (screen share)</h2>
          {guiInfo?.available ? (
            <div className="ide-panel">
              <p>
                A virtual display is running (noVNC) for GUI tools with no server mode, like
                Cursor or Antigravity. Opens in a separate tab.
              </p>
              <button className="primary" onClick={() => window.open(guiInfo.url, '_blank')}>
                Open screen
              </button>
              <div className="ide-password-row">
                <span>Password: </span>
                <code>{guiInfo.password}</code>
                <button
                  className="ghost"
                  onClick={() => navigator.clipboard?.writeText(guiInfo.password).catch(() => {})}
                >
                  Copy
                </button>
              </div>
            </div>
          ) : (
            <p className="muted">Docker is not installed/running on this machine.</p>
          )}

          {sessionList.length > 0 && (
            <>
              <h2>Running sessions</h2>
              <div className="session-list">
                {sessionList.map((s) => {
                  const adapter = adapters.find((a) => a.id === s.adapterId);
                  return (
                    <button key={s.sessionId} onClick={() => attachSession(s.sessionId)}>
                      {adapter?.label || s.adapterId} — {s.sessionId.slice(0, 8)}
                    </button>
                  );
                })}
              </div>
            </>
          )}
        </div>
      )}

      {phase === 'session' && (
        <div className="session-panel">
          <p className="status-ok">
            Session live — {adapters.find((a) => a.id === activeAdapterId)?.label || activeAdapterId}
          </p>

          {pendingPrompt && (
            <div className="prompt-banner">
              <p>Permission prompt detected: {pendingPrompt.matchedText}</p>
              <div className="prompt-actions">
                <button className="approve" onClick={handleApprove}>
                  Approve
                </button>
                <button className="deny" onClick={handleDeny}>
                  Deny
                </button>
              </div>
            </div>
          )}

          <XTermView
            ref={xtermRef}
            onData={(data) => {
              if (activeSessionIdRef.current) {
                sendFrame({ type: 'session:input', sessionId: activeSessionIdRef.current, data });
              }
            }}
            onResize={(cols, rows) => {
              if (activeSessionIdRef.current) {
                sendFrame({ type: 'session:resize', sessionId: activeSessionIdRef.current, cols, rows });
              }
            }}
          />

          <div className="control-row">
            {CONTROL_KEYS.map((k) => (
              <button key={k.label} className="control-key" onClick={() => sendRaw(k.data)}>
                {k.label}
              </button>
            ))}
          </div>
          <div className="input-row">
            <input
              type="text"
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && sendInput()}
              placeholder="Type a command or prompt..."
            />
            <button onClick={sendInput}>Send</button>
          </div>
          <div className="session-footer-actions">
            <button onClick={switchToPicker}>Switch session</button>
            <button className="ghost" onClick={stopSession}>
              Stop session
            </button>
          </div>
        </div>
      )}

      {phase === 'error' && (
        <div>
          <p className="status-error">Something went wrong — see log below.</p>
          <button onClick={() => setPhase('idle')}>Start over</button>
        </div>
      )}

      <pre className="log">{log.join('\n')}</pre>
    </div>
  );
}
