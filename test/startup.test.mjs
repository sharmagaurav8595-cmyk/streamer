import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchDevelopment, supportedNode } from '../scripts/dev.mjs';
import { temporaryDirectory } from './helpers.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

function fixture(t, backend, frontend = 'throw new Error("Frontend must not start");') {
  const directory = temporaryDirectory(t), logs = [], started = [];
  mkdirSync(join(directory, 'server'), { recursive: true });
  mkdirSync(join(directory, 'node_modules', 'vite', 'bin'), { recursive: true });
  writeFileSync(join(directory, 'server', 'index.mjs'), backend);
  writeFileSync(join(directory, 'node_modules', 'vite', 'bin', 'vite.js'), frontend);
  return {
    directory, logs, started,
    options: {
      directory, startupTimeout: 5000,
      log: { log: message => logs.push(message), error: message => logs.push(message) },
      spawnProcess(command, args, options) {
        started.push(args[0]);
        const ipc = Array.isArray(options.stdio) && options.stdio.includes('ipc');
        const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe', ...(ipc ? ['ipc'] : [])] });
        child.stdout.on('data', value => logs.push(value.toString()));
        child.stderr.on('data', value => logs.push(value.toString()));
        t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
        return child;
      },
    },
  };
}

test('startup enforces the supported Node version before spawning the app', () => {
  for (const version of ['18.20.8', '20.19.0', '22.11.0']) assert.equal(supportedNode(version), false);
  for (const version of ['22.12.0', '22.23.1', '24.0.0']) assert.equal(supportedNode(version), true);
});

test('a crashing backend exposes its error and never starts a disconnected frontend', { timeout: 15000 }, async t => {
  const { options, logs, started } = fixture(t, 'throw new Error("Missing source file in this ZIP");');
  assert.equal(await launchDevelopment(options), 1);
  assert.equal(started.length, 1);
  assert.match(logs.join('\n'), /Missing source file in this ZIP/);
  assert.match(logs.join('\n'), /Backend stopped.*exit code 1/);
});

test('the real Vite proxy uses the address of this backend, including a non-default port', { timeout: 15000 }, async t => {
  const evidence = join(temporaryDirectory(t), 'connection.json');
  const backend = `
    import { createServer } from 'node:http';
    const server = createServer((req, res) => { res.setHeader('Content-Type', 'application/json'); res.end('{"ok":true}'); });
    server.listen(0, '127.0.0.1', () => process.send({ type: 'streamloop:ready', origin: 'http://127.0.0.1:' + server.address().port }));
    process.on('message', message => { if (message.type === 'streamloop:shutdown') server.close(() => process.exit(0)); });
  `;
  const frontend = `
    (async () => {
      const { writeFileSync } = await import('node:fs');
      const { default: config } = await import(${JSON.stringify(new URL('../vite.config.mjs', import.meta.url).href)});
      const rule = config.server.proxy['/api'];
      const health = await (await fetch(rule.target + '/api/health')).json();
      writeFileSync(${JSON.stringify(evidence)}, JSON.stringify({ target: rule.target, mediaTarget: config.server.proxy['/media'].target, changeOrigin: rule.changeOrigin, health }));
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `;
  const { options, logs, started } = fixture(t, backend, frontend);
  // A frontend that exits also shuts down its owned backend.
  assert.equal(await launchDevelopment(options), 1);
  assert.equal(started.length, 2);
  const result = JSON.parse(readFileSync(evidence, 'utf8'));
  assert.match(result.target, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.notEqual(result.target, 'http://127.0.0.1:3000');
  assert.equal(result.mediaTarget, result.target);
  assert.equal(result.changeOrigin, false, 'Keep browser Origin checks working for uploads.');
  assert.equal(result.health.ok, true);
  assert.match(logs.join('\n'), /Backend ready/);
});

test('a backend that never becomes ready times out without launching Vite', { timeout: 15000 }, async t => {
  const { options, started, logs } = fixture(t, `
    setInterval(() => {}, 1000);
    process.on('message', message => { if (message.type === 'streamloop:shutdown') process.exit(0); });
  `);
  assert.equal(await launchDevelopment({ ...options, startupTimeout: 250 }), 1);
  assert.equal(started.length, 1);
  assert.match(logs.join('\n'), /Backend did not become ready/);
});

test('a synchronous launch failure does not leave signal listeners behind', async () => {
  const before = process.listenerCount('SIGTERM');
  const code = await launchDevelopment({ spawnProcess() { throw new Error('spawn denied'); }, log: { log() {}, error() {} } });
  assert.equal(code, 1);
  assert.equal(process.listenerCount('SIGTERM'), before);
});

async function actualBackend(t, port = 0) {
  const directory = temporaryDirectory(t);
  const child = spawn(process.execPath, [join(root, 'server', 'index.mjs')], {
    cwd: root, windowsHide: true,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: directory },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk.toString(); });
  child.stderr.on('data', chunk => { output += chunk.toString(); });
  const closed = once(child, 'close');
  t.after(async () => {
    if (child.exitCode === null && child.connected) child.send({ type: 'streamloop:shutdown' });
    const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
    await closed;
    clearTimeout(timer);
  });
  return { child, closed, directory, output: () => output };
}

test('the actual API announces readiness after listening and shuts down through IPC', { timeout: 45000 }, async t => {
  const { child, closed, directory } = await actualBackend(t);
  const [message] = await once(child, 'message', { signal: AbortSignal.timeout(30000) });
  assert.equal(message.type, 'streamloop:ready');
  assert.equal((await (await fetch(message.origin + '/api/health')).json()).ok, true);
  child.send({ type: 'streamloop:shutdown' });
  assert.equal((await closed)[0], 0);
  assert.equal(JSON.parse(readFileSync(join(directory, 'state.json'), 'utf8')).desiredRunning, false);
});

test('an occupied backend port reports the actual problem without claiming readiness', { timeout: 45000 }, async t => {
  const occupied = createServer();
  occupied.listen(0, '127.0.0.1');
  await once(occupied, 'listening');
  t.after(() => new Promise(resolveClose => occupied.close(resolveClose)));
  const { child, closed, output } = await actualBackend(t, occupied.address().port);
  let ready = false;
  child.on('message', () => { ready = true; });
  assert.equal((await closed)[0], 1);
  assert.equal(ready, false);
  assert.match(output(), /port \d+ is already in use/);
});
