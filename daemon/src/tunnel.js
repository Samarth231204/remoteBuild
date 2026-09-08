import { spawn } from 'node:child_process';

const TRYCLOUDFLARE_URL_RE = /https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/;

export function checkCloudflaredInstalled() {
  try {
    const result = spawn('cloudflared', ['--version']);
    return new Promise((resolve) => {
      result.on('error', () => resolve(false));
      result.on('exit', (code) => resolve(code === 0));
    });
  } catch {
    return Promise.resolve(false);
  }
}

// Starts a Cloudflare "quick tunnel" pointed at the local daemon port.
// Resolves with the public https URL once cloudflared prints it.
export function startTunnel(localPort) {
  return new Promise((resolve, reject) => {
    const proc = spawn('cloudflared', [
      'tunnel',
      '--url',
      `http://localhost:${localPort}`,
      '--no-autoupdate',
    ]);

    let resolved = false;
    const timeout = setTimeout(() => {
      if (!resolved) {
        proc.kill();
        reject(new Error('Timed out waiting for cloudflared to establish a tunnel'));
      }
    }, 30_000);

    const onData = (data) => {
      const text = data.toString();
      const match = text.match(TRYCLOUDFLARE_URL_RE);
      if (match && !resolved) {
        resolved = true;
        clearTimeout(timeout);
        resolve({ url: match[0], process: proc });
      }
    };

    // cloudflared logs its startup info (including the URL) to stderr.
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);

    proc.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });

    proc.on('exit', (code) => {
      if (!resolved) {
        clearTimeout(timeout);
        reject(new Error(`cloudflared exited before establishing a tunnel (code ${code})`));
      }
    });
  });
}
