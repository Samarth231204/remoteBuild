import { useCallback, useEffect, useRef, useState } from 'react';
import QrScanner from './QrScanner.jsx';
import {
  initCrypto,
  generateClientKeypair,
  deriveClientSessionKeys,
  encrypt,
  decrypt,
  toB64,
} from './crypto.js';
import { stripAnsi } from './ansi.js';
import './App.css';

const STORAGE_KEY = 'remotebuild_pairing';

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
  const [output, setOutput] = useState('');
  const [inputValue, setInputValue] = useState('');
  const [savedPairing, setSavedPairing] = useState(() => loadSavedPairing());

  const wsRef = useRef(null);
  const sessionRef = useRef(null); // { rx, tx }
  const outputEndRef = useRef(null);

  const appendLog = useCallback((line) => {
    setLog((prev) => [...prev.slice(-19), `${new Date().toLocaleTimeString()}  ${line}`]);
  }, []);

  useEffect(() => {
    outputEndRef.current?.scrollIntoView({ block: 'end' });
  }, [output]);

  const handleFrame = useCallback(
    (inner) => {
      if (inner.type === 'pong') {
        appendLog(`pong received — round trip ${Date.now() - inner.echo}ms`);
        return;
      }
      if (inner.type === 'session:started') {
        appendLog(`session started (resumed=${inner.resumed})`);
        setPhase('session');
        return;
      }
      if (inner.type === 'session:output') {
        setOutput((prev) => prev + stripAnsi(inner.data));
        return;
      }
      if (inner.type === 'session:exit') {
        appendLog(`session exited (code=${inner.exitCode}, signal=${inner.signal})`);
        setPhase('paired');
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

  const sendFrame = useCallback((obj) => {
    if (!wsRef.current || !sessionRef.current) return;
    const frame = encrypt(sessionRef.current.tx, obj);
    wsRef.current.send(JSON.stringify({ type: 'enc', ...frame }));
  }, []);

  const sendPing = useCallback(() => sendFrame({ type: 'ping', at: Date.now() }), [sendFrame]);

  const startSession = useCallback(() => {
    setOutput('');
    sendFrame({ type: 'session:start', cols: 100, rows: 30 });
  }, [sendFrame]);

  const stopSession = useCallback(() => sendFrame({ type: 'session:stop' }), [sendFrame]);

  const sendInput = useCallback(() => {
    if (!inputValue) return;
    sendFrame({ type: 'session:input', data: inputValue + '\n' });
    setInputValue('');
  }, [inputValue, sendFrame]);

  // Raw control bytes for navigating interactive TUI menus (like Claude
  // Code's own trust-folder / permission prompts) that can't be driven by
  // typed text alone.
  const sendRaw = useCallback((data) => sendFrame({ type: 'session:input', data }), [sendFrame]);
  const CONTROL_KEYS = [
    { label: '↑', data: '\x1b[A' },
    { label: '↓', data: '\x1b[B' },
    { label: '←', data: '\x1b[D' },
    { label: '→', data: '\x1b[C' },
    { label: 'Enter', data: '\r' },
    { label: 'Esc', data: '\x1b' },
    { label: 'Tab', data: '\t' },
    { label: 'Ctrl+C', data: '\x03' },
  ];

  const forgetDevice = useCallback(() => {
    clearSavedPairing();
    setSavedPairing(null);
  }, []);

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
          <button className="primary" onClick={startSession}>
            Start agent session
          </button>
        </div>
      )}

      {phase === 'session' && (
        <div className="session-panel">
          <p className="status-ok">Session live</p>
          <pre className="terminal">
            {output}
            <span ref={outputEndRef} />
          </pre>
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
          <button className="ghost" onClick={stopSession}>
            Stop session
          </button>
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
