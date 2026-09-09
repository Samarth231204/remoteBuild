import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

// Thin wrapper around a real xterm.js instance. Renders full ANSI (colors,
// cursor movement, alt-screen redraws) correctly, unlike Phase 2's stripped
// plain-text view. Tapping into it brings up the mobile keyboard (xterm
// manages a hidden focusable textarea internally) and every keystroke is
// forwarded immediately via onData, matching real terminal semantics
// (needed for things like shell history / autocomplete / interactive menus).
const XTermView = forwardRef(function XTermView({ onData, onResize }, ref) {
  const containerRef = useRef(null);
  const termRef = useRef(null);
  const fitRef = useRef(null);

  useEffect(() => {
    const term = new XTerm({
      convertEol: true,
      cursorBlink: true,
      fontSize: 12,
      // Full palette spelled out explicitly rather than relying on a
      // partial theme merging with xterm's built-in defaults — that merge
      // behavior isn't guaranteed across versions, and a partial theme
      // silently rendering every SGR color as plain foreground is exactly
      // the failure mode this caused during testing.
      theme: {
        background: '#000000',
        foreground: '#e5e7eb',
        cursor: '#e5e7eb',
        black: '#1e1e1e',
        red: '#f87171',
        green: '#4ade80',
        yellow: '#facc15',
        blue: '#60a5fa',
        magenta: '#c084fc',
        cyan: '#22d3ee',
        white: '#e5e7eb',
        brightBlack: '#6b7280',
        brightRed: '#fca5a5',
        brightGreen: '#86efac',
        brightYellow: '#fde047',
        brightBlue: '#93c5fd',
        brightMagenta: '#d8b4fe',
        brightCyan: '#67e8f9',
        brightWhite: '#f9fafb',
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current);
    fit.fit();
    termRef.current = term;
    fitRef.current = fit;

    const dataDisposable = term.onData((data) => onData?.(data));

    const notifyResize = () => onResize?.(term.cols, term.rows);
    const handleResize = () => {
      fit.fit();
      notifyResize();
    };
    window.addEventListener('resize', handleResize);
    notifyResize();

    return () => {
      dataDisposable.dispose();
      window.removeEventListener('resize', handleResize);
      term.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useImperativeHandle(ref, () => ({
    write(data) {
      termRef.current?.write(data);
    },
    clear() {
      termRef.current?.clear();
    },
    getDims() {
      return termRef.current ? { cols: termRef.current.cols, rows: termRef.current.rows } : null;
    },
  }));

  return <div ref={containerRef} className="xterm-container" />;
});

export default XTermView;
