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
    const args = [
      'tunnel',
      '--url',
      `http://localhost:${localPort}`,
      '--no-autoupdate',
    ];
    // QUIC (cloudflared's default transport) runs over UDP, which some
    // networks throttle or block, causing an endless "control stream
    // encountered a failure" retry loop that never stabilizes. HTTP/2 runs
    // over plain TCP and works everywhere QUIC doesn't.
    if (process.env.REMOTEBUILD_TUNNEL_PROTOCOL) {
      args.push('--protocol', process.env.REMOTEBUILD_TUNNEL_PROTOCOL);
    }
    const proc = spawn('cloudflared', args);

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
