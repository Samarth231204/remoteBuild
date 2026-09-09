import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

export function isCodeServerInstalled() {
  const result = spawnSync('which', ['code-server']);
  return result.status === 0;
}

export function generatePassword() {
  return randomBytes(12).toString('hex');
}

// Starts code-server bound to 127.0.0.1:port, authenticated with a
// one-time-generated password passed via env (never written to
// code-server's own config file), serving `workspaceDir`. Resolves once
// code-server reports it's actually listening.
export function startCodeServer({ port, workspaceDir, password }) {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      'code-server',
      [
        '--bind-addr',
        `127.0.0.1:${port}`,
        '--auth',
        'password',
        '--disable-telemetry',
        '--disable-update-check',
        workspaceDir,
      ],
      { env: { ...process.env, PASSWORD: password } },
    );

    let resolved = false;
    const timeout = setTimeout(() => {
      if (!resolved) {
        proc.kill();
        reject(new Error('Timed out waiting for code-server to start'));
      }
    }, 20_000);

    const onData = (data) => {
      const text = data.toString();
      if (!resolved && /HTTP server listening/i.test(text)) {
        resolved = true;
        clearTimeout(timeout);
        resolve(proc);
      }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);

    proc.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });

    proc.on('exit', (code) => {
      if (!resolved) {
        clearTimeout(timeout);
        reject(new Error(`code-server exited before starting (code ${code})`));
      }
    });
  });
}
