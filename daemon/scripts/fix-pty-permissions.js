// npm sometimes drops the executable bit on node-pty's prebuilt unix
// spawn-helper binary during install, which makes every pty.spawn() call
// fail with "posix_spawnp failed" at runtime with no useful stack trace.
// Restore it here so a fresh `npm install` always works.
import { chmodSync, existsSync } from 'node:fs';

const candidates = [
  'node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper',
  'node_modules/node-pty/prebuilds/darwin-x64/spawn-helper',
  'node_modules/node-pty/prebuilds/linux-arm64/spawn-helper',
  'node_modules/node-pty/prebuilds/linux-x64/spawn-helper',
];

for (const path of candidates) {
  if (existsSync(path)) {
    chmodSync(path, 0o755);
    console.log(`fix-pty-permissions: chmod +x ${path}`);
  }
}
