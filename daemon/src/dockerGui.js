import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const IMAGE_TAG = 'remotebuild-gui:latest';
const DOCKERFILE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'docker-gui');

export function isDockerAvailable() {
  const result = spawnSync('docker', ['info']);
  return result.status === 0;
}

export function generateVncPassword() {
  // x11vnc's classic VNC auth truncates to 8 chars; keep it short and simple.
  return randomBytes(4).toString('hex');
}

function isImageBuilt() {
  const result = spawnSync('docker', ['image', 'inspect', IMAGE_TAG]);
  return result.status === 0;
}

// Builds the GUI container image if it isn't already built. Blocking —
// only happens once per machine (subsequent daemon runs reuse the image).
export function buildImageIfNeeded() {
  return new Promise((resolve, reject) => {
    if (isImageBuilt()) {
      resolve(false); // already built
      return;
    }

    console.log('Building remoteBuild GUI container image (first run only, ~1-2 min)...');
    const proc = spawn('docker', ['build', '-t', IMAGE_TAG, DOCKERFILE_DIR]);
    proc.stdout.on('data', (d) => process.stdout.write(d));
    proc.stderr.on('data', (d) => process.stdout.write(d));
    proc.on('error', reject);
    proc.on('exit', (code) => {
      if (code === 0) resolve(true);
      else reject(new Error(`docker build exited with code ${code}`));
    });
  });
}

// Starts a container from the built image, exposing noVNC on `port`, and
// resolves once it reports being ready. `appCmd` is the GUI command to run
// inside the container (the closed IDE tool, once installed there — a
// lightweight stand-in by default).
export function startContainer({ port, password, appCmd, containerName }) {
  return new Promise((resolve, reject) => {
    spawnSync('docker', ['rm', '-f', containerName]); // clean up any stale container from a prior run

    const args = [
      'run',
      '-d',
      '--name',
      containerName,
      '-p',
      `${port}:6080`,
      '-e',
      `VNC_PASSWORD=${password}`,
    ];
    if (appCmd) args.push('-e', `GUI_APP_CMD=${appCmd}`);
    args.push(IMAGE_TAG);

    const result = spawnSync('docker', args);
    if (result.status !== 0) {
      reject(new Error(`docker run failed: ${result.stderr?.toString() || 'unknown error'}`));
      return;
    }

    const containerId = result.stdout.toString().trim();

    // Poll the container's logs for the websockify readiness line rather
    // than a fixed sleep — startup time varies by machine.
    const deadline = Date.now() + 20_000;
    const poll = () => {
      const logs = spawnSync('docker', ['logs', containerName]);
      const text = (logs.stdout?.toString() || '') + (logs.stderr?.toString() || '');
      if (/proxying from/i.test(text)) {
        resolve({ containerId, containerName });
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error('Timed out waiting for GUI container to become ready'));
        return;
      }
      setTimeout(poll, 500);
    };
    poll();
  });
}

export function stopContainer(containerName) {
  spawnSync('docker', ['rm', '-f', containerName]);
}
