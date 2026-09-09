import { spawnSync } from 'node:child_process';

// Adding a new CLI agent should be exactly this: one entry, no other code
// changes. Availability is checked at runtime (not assumed), so the client
// can show which agents are actually usable on this machine.
export const ADAPTERS = [
  { id: 'claude', label: 'Claude Code', cmd: 'claude', args: [] },
  { id: 'codex', label: 'Codex CLI', cmd: 'codex', args: [] },
  { id: 'opencode', label: 'OpenCode', cmd: 'opencode', args: [] },
  { id: 'gemini', label: 'Gemini CLI', cmd: 'gemini', args: [] },
  { id: 'shell', label: 'Plain Shell (debug)', cmd: process.env.SHELL || '/bin/bash', args: [] },
];

export function isCommandAvailable(cmd) {
  if (cmd.startsWith('/')) return true; // absolute path — trust it exists
  const result = spawnSync('which', [cmd]);
  return result.status === 0;
}

export function listAdaptersWithAvailability() {
  return ADAPTERS.map((a) => ({
    id: a.id,
    label: a.label,
    available: isCommandAvailable(a.cmd),
  }));
}

export function getAdapter(id) {
  return ADAPTERS.find((a) => a.id === id);
}
