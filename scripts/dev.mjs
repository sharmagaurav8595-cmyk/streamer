import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

export function supportedNode(version) {
  const [major, minor] = version.split('.').map(Number);
  return major > 22 || (major === 22 && minor >= 12);
}

// Wait for this backend's listen callback, rather than an HTTP port that may
// belong to an older process. A failed API must never leave an orphaned UI.
export function launchDevelopment({ directory = root, environment = process.env, spawnProcess = spawn, startupTimeout = 45000, log = console } = {}) {
  return new Promise(resolveDone => {
    const children = new Set();
    let backend, frontend, closing = false, exitCode = 0, startupTimer, killTimer;
    const onSignal = () => stop(0);
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);

    function complete() {
      if (!closing || children.size) return;
      clearTimeout(startupTimer);
      clearTimeout(killTimer);
      process.removeListener('SIGINT', onSignal);
      process.removeListener('SIGTERM', onSignal);
      resolveDone(exitCode);
    }
    function stop(code) {
      if (closing) return;
      closing = true;
      exitCode = code;
      clearTimeout(startupTimer);
      for (const child of children) {
        if (child === backend && child.connected) {
          child.send({ type: 'streamloop:shutdown' }, error => { if (error) child.kill('SIGTERM'); });
        } else child.kill('SIGTERM');
      }
      killTimer = setTimeout(() => { for (const child of children) child.kill('SIGKILL'); }, 10000);
      killTimer.unref();
      complete();
    }
    function start(name, args, options) {
      const child = spawnProcess(process.execPath, args, { cwd: directory, windowsHide: true, ...options });
      children.add(child);
      child.on('error', error => {
        log.error(`${name} could not start: ${error.message}`);
        stop(1);
      });
      child.once('close', (code, signal) => {
        children.delete(child);
        if (!closing) {
          log.error(`${name} stopped (${signal || `exit code ${code}`}). Fix the error printed above, then run npm run dev again.`);
          stop(code || 1);
        }
        complete();
      });
      return child;
    }
    try {
      log.log('Starting the streaming backend. Waiting for it to be ready...');
      backend = start('Backend', [join(directory, 'server', 'index.mjs')], {
        env: { ...environment }, stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
      });
      backend.on('message', message => {
        if (closing || frontend || message?.type !== 'streamloop:ready') return;
        clearTimeout(startupTimer);
        log.log(`Backend ready at ${message.origin}. Starting the studio...`);
        try {
          frontend = start('Studio', [join(directory, 'node_modules', 'vite', 'bin', 'vite.js')], {
            env: { ...environment, STREAMLOOP_API_TARGET: message.origin }, stdio: 'inherit',
          });
        } catch (error) { log.error(`Studio could not start: ${error.message}`); stop(1); }
      });
      startupTimer = setTimeout(() => {
        log.error('Backend did not become ready within 45 seconds. Check the backend error above. To run it by itself: npm run server');
        stop(1);
      }, startupTimeout);
    } catch (error) { log.error(`Backend could not start: ${error.message}`); stop(1); }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!supportedNode(process.versions.node)) {
    console.error(`Node ${process.versions.node} is too old. Install Node 22.12 or newer, then run npm install and npm run dev.`);
    process.exitCode = 1;
  } else {
    try {
      // Resolve .env relative to the project, even when started from elsewhere.
      try { process.loadEnvFile(join(root, '.env')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      process.exitCode = await launchDevelopment();
    } catch (error) { console.error(error.message); process.exitCode = 1; }
  }
}
