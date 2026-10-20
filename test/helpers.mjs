import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ffmpeg } from '../server/media.mjs';

export const execute = promisify(execFile);
export function temporaryDirectory(t) {
  const directory = mkdtempSync(join(tmpdir(), 'streamloop-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}
export class FakeEncoder extends EventEmitter {
  constructor() {
    super();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.closed = false;
    this.stdin = new Writable({ write: (_chunk, _encoding, callback) => { callback(); queueMicrotask(() => this.finish(0)); } });
  }
  progress(seconds = 2) { this.stdout.write(`fps=30\nbitrate=4000.0kbits/s\nout_time_us=${seconds * 1e6}\nspeed=1.00x\nprogress=continue\n`); }
  finish(code = 1) { if (!this.closed) { this.closed = true; this.emit('close', code); } }
  kill() { this.finish(1); }
}
export async function makeFixture(path, audio = false) {
  const args = ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30'];
  if (audio) args.push('-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100');
  args.push('-t', '0.8', '-c:v', 'libx264', '-threads', '2', '-pix_fmt', 'yuv420p');
  if (audio) args.push('-c:a', 'aac');
  args.push('-y', path);
  await execute(ffmpeg, args, { timeout: 20000, windowsHide: true });
}
