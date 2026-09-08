import { useCallback, useRef, useState } from 'react';
import QrScanner from './QrScanner.jsx';
import {
  initCrypto,
  generateClientKeypair,
  deriveClientSessionKeys,
  encrypt,
  decrypt,
  toB64,
} from './crypto.js';
import './App.css';

// phase: 'idle' | 'scanning' | 'connecting' | 'connected' | 'error'
export default function App() {
  const [phase, setPhase] = useState('idle');
  const [log, setLog] = useState([]);
  const [lastPing, setLastPing] = useState(null);
  const wsRef = useRef(null);
  const sessionRef = useRef(null); // { rx, tx }

  const appendLog = useCallback((line) => {
    setLog((prev) => [...prev.slice(-19), `${new Date().toLocaleTimeString()}  ${line}`]);
  }, []);

  const handleDecoded = useCallback(
    async (text) => {
      setPhase('connecting');
      let payload;
      try {
        payload = JSON.parse(text);
      } catch {
        appendLog('QR did not contain valid pairing JSON');
        setPhase('error');
        return;
      }

      const sodium = await initCrypto();
      const clientKeypair = generateClientKeypair();
      const ws = new WebSocket(payload.url);
      wsRef.current = ws;

      ws.onopen = () => {
        appendLog(`Connected to ${payload.url}, sending hello...`);
        ws.send(
          JSON.stringify({
            type: 'hello',
            pub: toB64(clientKeypair.publicKey),
            token: payload.token,
          }),
        );
      };

      ws.onmessage = (evt) => {
        const msg = JSON.parse(evt.data);

        if (msg.type === 'hello-ack') {
          sessionRef.current = deriveClientSessionKeys(clientKeypair, msg.pub);
          appendLog('Handshake complete — session encrypted');
          setPhase('connected');
          return;
        }

        if (msg.type === 'hello-reject') {
          appendLog(`Pairing rejected: ${msg.reason}`);
          setPhase('error');
          return;
        }

        if (msg.type === 'enc' && sessionRef.current) {
          const inner = decrypt(sessionRef.current.rx, msg);
          if (inner.type === 'pong') {
            const rtt = Date.now() - inner.echo;
            setLastPing(rtt);
            appendLog(`pong received — round trip ${rtt}ms`);
          }
        }
      };

      ws.onerror = () => {
        appendLog('WebSocket error');
        setPhase('error');
      };

      ws.onclose = () => {
        appendLog('Disconnected');
        if (phase !== 'error') setPhase('idle');
      };
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [appendLog],
  );

  const sendPing = useCallback(() => {
    if (!wsRef.current || !sessionRef.current) return;
    const frame = encrypt(sessionRef.current.tx, { type: 'ping', at: Date.now() });
    wsRef.current.send(JSON.stringify({ type: 'enc', ...frame }));
    appendLog('ping sent');
  }, [appendLog]);

  return (
    <div className="app">
      <h1>remoteBuild</h1>

      {phase === 'idle' && (
        <button className="primary" onClick={() => setPhase('scanning')}>
          Scan QR to pair
        </button>
      )}

      {phase === 'scanning' && (
        <QrScanner onDecoded={handleDecoded} onCancel={() => setPhase('idle')} />
      )}

      {phase === 'connecting' && <p>Connecting…</p>}

      {phase === 'connected' && (
        <div className="connected-panel">
          <p className="status-ok">Connected &amp; encrypted</p>
          <button onClick={sendPing}>Send ping</button>
          {lastPing !== null && <p>Last round trip: {lastPing}ms</p>}
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
