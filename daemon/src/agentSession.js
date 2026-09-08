import pty from 'node-pty';

// Keep enough recent output to redraw a reconnecting client's screen without
// replaying an unbounded amount of history.
const SCROLLBACK_LIMIT_CHARS = 200_000;

export class AgentSession {
  constructor({ cmd, args = [], cwd, cols, rows, onData, onExit }) {
    this.buffer = '';
    this.exited = false;

    this.proc = pty.spawn(cmd, args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env: process.env,
    });

    this.proc.onData((data) => {
      this.buffer += data;
      if (this.buffer.length > SCROLLBACK_LIMIT_CHARS) {
        this.buffer = this.buffer.slice(this.buffer.length - SCROLLBACK_LIMIT_CHARS);
      }
      onData(data);
    });

    this.proc.onExit(({ exitCode, signal }) => {
      this.exited = true;
      onExit({ exitCode, signal });
    });
  }

  write(data) {
    if (!this.exited) this.proc.write(data);
  }

  resize(cols, rows) {
    if (!this.exited && cols > 0 && rows > 0) this.proc.resize(cols, rows);
  }

  kill() {
    if (!this.exited) this.proc.kill();
  }
}
