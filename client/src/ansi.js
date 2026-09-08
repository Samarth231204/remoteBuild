// Strips ANSI escape sequences so raw PTY output is legible in a plain
// <pre> block. Not a terminal emulator — cursor movement/clear-screen
// sequences are just removed, not interpreted. Good enough to prove the
// PTY relay works; Phase 3 replaces this with real xterm.js rendering.
const ANSI_PATTERN = [
  '[\\u001B\\u009B][[\\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\\d/#&.:=?%@~_]+)*|[a-zA-Z\\d]+(?:;[-a-zA-Z\\d/#&.:=?%@~_]*)*)?\\u0007)',
  '(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-ntqry=><~]))',
].join('|');
const ANSI_RE = new RegExp(ANSI_PATTERN, 'g');

export function stripAnsi(str) {
  return str.replace(ANSI_RE, '');
}
