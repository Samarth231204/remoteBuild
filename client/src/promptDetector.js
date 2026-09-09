// Heuristic detector for interactive permission/confirmation prompts in CLI
// agent output, so the phone can offer a one-tap Approve/Deny instead of the
// user hunting for the right arrow-key taps on raw terminal output.
//
// Two shapes are handled, both observed from real Claude Code CLI sessions
// and common to CLI agents generally:
//
//   A) Inline yes/no, e.g.: "Do you want to proceed? (y/n)"
//      -> Approve = "y\r", Deny = "n\r"
//
//   B) Arrow-key menu with a cursor marker (❯ or >) next to the selected
//      option, e.g.:
//        ❯ No, exit
//          Yes, I trust this folder
//      -> Approve/Deny are computed as "however many arrow presses move the
//         cursor from its current line to the Yes/No line, then Enter" —
//         this works regardless of which option happens to be the default.

const CURSOR_RE = /^\s*(❯|>)\s*/;
const YES_RE = /^(?:\d+\.\s*)?yes\b/i;
const NO_RE = /^(?:\d+\.\s*)?no\b/i;

export function detectPermissionPrompt(tailText) {
  if (!tailText) return null;

  const lines = tailText
    .split('\n')
    .map((l) => l.replace(/\r/g, ''))
    .filter((l) => l.trim().length > 0);
  const recent = lines.slice(-15);

  const inlineWindow = recent.slice(-3).join(' ');
  if (/\(\s*y\s*\/\s*n\s*\)\s*$/i.test(inlineWindow)) {
    return {
      kind: 'inline',
      approveKeys: 'y\r',
      denyKeys: 'n\r',
      matchedText: inlineWindow.trim(),
    };
  }

  const optionLines = [];
  for (const line of recent) {
    const stripped = line.replace(CURSOR_RE, '').trim();
    if (!stripped || stripped.length > 80) continue;
    if (YES_RE.test(stripped) || NO_RE.test(stripped)) {
      optionLines.push({ text: stripped, selected: CURSOR_RE.test(line) });
    }
  }

  if (optionLines.length >= 2) {
    const selectedIdx = optionLines.findIndex((o) => o.selected);
    const yesIdx = optionLines.findIndex((o) => YES_RE.test(o.text));
    const noIdx = optionLines.findIndex((o) => NO_RE.test(o.text));

    if (selectedIdx !== -1 && yesIdx !== -1 && noIdx !== -1) {
      const keysTo = (targetIdx) => {
        const delta = targetIdx - selectedIdx;
        if (delta === 0) return '\r';
        const key = delta > 0 ? '\x1b[B' : '\x1b[A';
        return key.repeat(Math.abs(delta)) + '\r';
      };

      return {
        kind: 'menu',
        approveKeys: keysTo(yesIdx),
        denyKeys: keysTo(noIdx),
        matchedText: optionLines.map((o) => o.text).join(' / '),
      };
    }
  }

  return null;
}
