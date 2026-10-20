import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../server/store.mjs';
import { StreamController, redact } from '../server/encoder.mjs';
import { temporaryDirectory, FakeEncoder } from './helpers.mjs';

const key = 'test-key-12345678';
function setup(t, options = {}) {
  const store = new Store(temporaryDirectory(t));
  store.setKey(key);
  store.state.videos = [{ id: 'video-1', file: 'fixture.mp4', hasAudio: true }];
  store.state.settings.videoId = 'video-1';
  store.save();
  const children = [];
  const controller = new StreamController(store, { encoderAvailable: true, ...options, spawn: (_command, args) => {
    const child = new FakeEncoder(); child.args = args; children.push(child); return child;
  } });
  t.after(() => controller.shutdown());
  return { store, controller, children };
}

test('stream key is encrypted on disk and survives a store reload', t => {
  const directory = temporaryDirectory(t);
  const store = new Store(directory);
  store.setKey(key); store.save();
  assert.equal(readFileSync(join(directory, 'state.json'), 'utf8').includes(key), false);
  assert.equal(new Store(directory).getKey(), key);
  assert.equal(redact(`Could not publish rtmps://example.com/live/${key}`, key).includes(key), false);
});

test('one encoder runs independently of browser connections and manual stop clears saved intent', async t => {
  const { store, controller, children } = setup(t);
  controller.start();
  assert.equal(controller.snapshot().status, 'connecting');
  assert.throws(() => controller.start(), /already running/);
  children[0].progress();
  assert.equal(controller.snapshot().status, 'streaming');
  assert.equal(controller.snapshot().metrics.outputSeconds, 2);
  assert.equal(store.state.desiredRunning, true);
  assert.equal(children[0].args.at(-1), `rtmps://a.rtmps.youtube.com:443/live2/${key}`);
  await controller.stop();
  assert.equal(controller.snapshot().status, 'idle');
  assert.equal(new Store(store.directory).state.desiredRunning, false);
});

test('a broken connection retries, but manual stop cancels a pending retry', async t => {
  const { controller, children } = setup(t, { retryBase: 20 });
  controller.start(); children[0].finish(1);
  assert.equal(controller.snapshot().status, 'reconnecting');
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(children.length, 2);
  children[1].progress(); children[1].finish(1);
  await controller.stop();
  await new Promise(resolve => setTimeout(resolve, 70));
  assert.equal(children.length, 2);
  assert.equal(controller.snapshot().status, 'idle');
});

test('retry exhaustion stops intent and strips keys from persisted diagnostics', t => {
  const { controller, store, children } = setup(t, { maxRetries: 0 });
  controller.start();
  children[0].stderr.write(`publish error: rtmps://a.rtmps.youtube.com:443/live2/${key}`);
  children[0].finish(1);
  assert.equal(controller.status, 'error');
  assert.equal(store.state.desiredRunning, false);
  assert.equal(JSON.stringify(store.state.events).includes(key), false);
  assert.equal(JSON.stringify(controller.snapshot()).includes(key), false);
});

test('scheduled end stops even while reconnecting', async t => {
  const { controller, store, children } = setup(t);
  controller.start(); children[0].finish(1);
  store.state.settings.endAt = new Date(Date.now() - 1000).toISOString();
  controller.tick();
  assert.equal(store.state.desiredRunning, false);
  assert.equal(controller.retryTimer, null);
  assert.equal(controller.status, 'idle');
});

test('a single playback completes without reconnecting', t => {
  const { controller, store, children } = setup(t);
  store.state.settings.loop = false;
  controller.start(); children[0].finish(0);
  assert.equal(controller.status, 'finished');
  assert.equal(store.state.desiredRunning, false);
  assert.equal(controller.retryTimer, null);
});

test('server shutdown preserves active intent, restart resumes, expired schedules stay stopped', async t => {
  const { controller, store } = setup(t);
  controller.start();
  await controller.shutdown();
  assert.equal(new Store(store.directory).state.desiredRunning, true);
  const spawned = [];
  const recovered = new StreamController(new Store(store.directory), { encoderAvailable: true, spawn: () => { const child = new FakeEncoder(); spawned.push(child); return child; } });
  t.after(() => recovered.shutdown());
  recovered.recover();
  assert.equal(spawned.length, 1);
  await recovered.shutdown();
  const expired = new Store(store.directory);
  expired.state.settings.endAt = new Date(Date.now() - 1000).toISOString(); expired.save();
  const noResume = new StreamController(expired, { encoderAvailable: true, spawn: () => { throw new Error('Must not resume an expired stream.'); } });
  t.after(() => noResume.shutdown());
  noResume.recover();
  assert.equal(expired.state.desiredRunning, false);
});

test('a stalled encoder is terminated before reconnecting', async t => {
  const { controller, children } = setup(t, { retryBase: 10000 });
  controller.start();
  controller.lastProgressAt = Date.now() - 61000;
  controller.tick();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(children[0].closed, true);
  assert.equal(controller.status, 'reconnecting');
});
