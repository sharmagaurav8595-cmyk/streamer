import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request } from 'node:http';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../server/store.mjs';
import { StreamController } from '../server/encoder.mjs';
import { createApplication, validateSettings } from '../server/app.mjs';
import { FakeEncoder, makeFixture, temporaryDirectory } from './helpers.mjs';

async function serverFor(t, options = {}) {
  const directory = temporaryDirectory(t);
  const store = new Store(directory);
  const controller = new StreamController(store, { encoderAvailable: true, spawn: () => new FakeEncoder() });
  const { app } = await createApplication({ store, controller, encoderAvailable: true, recover: false, ...options });
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { await controller.shutdown(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { directory, store, controller, base };
}

test('settings validate before mutation; API never returns a saved stream key', async t => {
  const { store, base } = await serverFor(t);
  const key = 'testing-key-987654321';
  const save = await fetch(`${base}/api/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Test stream', streamKey: key }) });
  assert.equal(save.status, 200);
  const body = await save.text();
  assert.equal(body.includes(key), false);
  assert.equal(JSON.parse(body).settings.keySet, true);
  const invalid = await fetch(`${base}/api/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Should not be saved', streamKey: 'bad/key' }) });
  assert.equal(invalid.status, 400);
  assert.equal(store.state.settings.name, 'Test stream');
  const crossOrigin = await fetch(`${base}/api/stream/stop`, { method: 'POST', headers: { origin: 'https://unrelated.example' } });
  assert.equal(crossOrigin.status, 403);
  const invalidHost = await new Promise((resolveStatus, reject) => {
    const req = request(`${base}/api/state`, { headers: { Host: 'unrelated.example' } }, res => { res.resume(); resolveStatus(res.statusCode); });
    req.on('error', reject);
    req.end();
  });
  assert.equal(invalidHost, 421);
  assert.equal((await fetch(`${base}/api/health`)).status, 200);
});

test('real upload is probed, previewed, range-served, protected while streaming, and deleted', async t => {
  const { directory, base, store } = await serverFor(t);
  const fixture = join(directory, 'fixture.mp4'); await makeFixture(fixture, true);
  const form = new FormData(); form.append('video', new Blob([readFileSync(fixture)], { type: 'video/mp4' }), 'test-video.mp4');
  const response = await fetch(`${base}/api/videos`, { method: 'POST', body: form });
  const uploaded = await response.json();
  assert.equal(response.status, 201, JSON.stringify(uploaded));
  const video = uploaded.videos[0];
  assert.equal(video.name, 'test-video.mp4');
  assert.equal(video.hasAudio, true);
  assert.equal(video.width, 320);
  assert.ok(video.thumbnailUrl);
  const range = await fetch(base + video.url, { headers: { Range: 'bytes=0-99' } });
  assert.equal(range.status, 206);
  assert.equal((await range.arrayBuffer()).byteLength, 100);
  assert.equal((await fetch(base + video.thumbnailUrl)).status, 200);
  const start = await fetch(`${base}/api/stream/start`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...uploaded.settings, streamKey: 'test-stream-key-12345' }) });
  assert.equal(start.status, 202);
  assert.equal((await fetch(`${base}/api/videos/${video.id}`, { method: 'DELETE' })).status, 409);
  assert.equal((await fetch(`${base}/api/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ loop: false }) })).status, 409);
  assert.equal((await fetch(`${base}/api/stream/stop`, { method: 'POST' })).status, 200);
  const deleted = await fetch(`${base}/api/videos/${video.id}`, { method: 'DELETE' });
  assert.equal(deleted.status, 200);
  assert.equal(store.state.videos.length, 0);
  assert.equal(readdirSync(store.uploads).length, 0);
  assert.equal(readdirSync(store.thumbnails).length, 0);
});

test('an invalid video is rejected without leaving an uploaded file', async t => {
  const { base, store } = await serverFor(t);
  const form = new FormData(); form.append('video', new Blob(['This is not a video']), 'invalid.mp4');
  assert.equal((await fetch(`${base}/api/videos`, { method: 'POST', body: form })).status, 400);
  assert.equal(store.state.videos.length, 0);
  assert.equal(readdirSync(store.incoming).length, 0);
  assert.equal(readdirSync(store.uploads).length, 0);
});

test('invalid schedule, quality, and loop types are rejected', () => {
  const initial = { name: 'Test', loop: true, endAt: null, quality: '720p', videoId: null };
  for (const change of [{ endAt: 'yesterday' }, { endAt: new Date(Date.now() - 5000).toISOString() }, { quality: '4K' }, { loop: 'true' }, { videoId: '../../file' }, { youtubeMode: 'unknown' }, { layout: 'square' }, { frameFit: 'stretch' }]) {
    assert.throws(() => validateSettings(change, initial, []));
  }
});

test('vertical framing is the default; format choices persist and invalid values cannot mutate them', async t => {
  const { base, store } = await serverFor(t);
  const initial = await (await fetch(`${base}/api/state`)).json();
  assert.equal(initial.settings.layout, 'vertical');
  assert.equal(initial.settings.frameFit, 'cover');
  assert.equal(initial.stream.output.width, 720);
  assert.equal(initial.stream.output.height, 1280);
  const response = await fetch(`${base}/api/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ quality: '1080p', layout: 'vertical', frameFit: 'contain' }) });
  assert.equal(response.status, 200);
  const saved = await response.json();
  assert.equal(saved.stream.output.width, 1080);
  assert.equal(saved.stream.output.height, 1920);
  assert.equal(new Store(store.directory).state.settings.frameFit, 'contain');
  const invalid = await fetch(`${base}/api/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ layout: 'horizontal', frameFit: 'stretch' }) });
  assert.equal(invalid.status, 400);
  assert.equal(store.state.settings.layout, 'vertical');
});

test('custom overlay settings persist and reject unsafe or invalid input without partial writes', async t => {
  const { base, store } = await serverFor(t);
  const settings = { overlayEnabled: true, overlayName: "Gaurav's Gaming 100%", followText: 'FOLLOW @GAURAV', subscribeText: 'SUBSCRIBE NOW' };
  const saved = await fetch(`${base}/api/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(settings) });
  assert.equal(saved.status, 200);
  const state = await saved.json();
  assert.equal(state.features.streamOverlay, true);
  assert.equal(state.settings.overlayName, settings.overlayName);
  assert.equal(new Store(store.directory).state.settings.subscribeText, settings.subscribeText);
  for (const invalid of [{ overlayEnabled: 'yes' }, { overlayName: '' }, { followText: 'bad\nline' }, { subscribeText: 'x'.repeat(29) }, { overlayName: 'bad\u0000name' }]) {
    const response = await fetch(`${base}/api/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ overlayName: 'Do not save', ...invalid }) });
    assert.equal(response.status, 400);
    assert.equal(store.state.settings.overlayName, settings.overlayName);
  }
});

test('crop settings persist and invalid ranges cannot partially overwrite the saved framing', async t => {
  const { base, store } = await serverFor(t);
  const settings = { videoZoom: 1.75, videoPositionX: 12, videoPositionY: 88, sourceTrimTop: 27, sourceTrimBottom: 23 };
  const response = await fetch(`${base}/api/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(settings) });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).features.videoFraming, true);
  const saved = new Store(store.directory).state.settings;
  for (const [key, value] of Object.entries(settings)) assert.equal(saved[key], value);
  for (const invalid of [{ videoZoom: 0.5 }, { videoZoom: 4 }, { videoPositionX: -1 }, { videoPositionY: 101 }, { videoZoom: '2' }, { sourceTrimTop: -1 }, { sourceTrimBottom: 46 }, { sourceTrimTop: 45, sourceTrimBottom: 45 }]) {
    const failed = await fetch(`${base}/api/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ videoPositionX: 90, ...invalid }) });
    assert.equal(failed.status, 400);
    assert.equal(store.state.settings.videoPositionX, 12);
  }
});

test('YouTube frame previews normalize URLs, reuse the image and never save the source video', async t => {
  let calls = 0;
  const { base, store } = await serverFor(t, { youtubeAvailable: true, previewYoutube: async url => {
    calls++;
    assert.equal(url, 'https://www.youtube.com/watch?v=jNQXAC9IVRw');
    return { thumbnailUrl: 'data:image/jpeg;base64,/9j/', width: 960, height: 540, name: 'Source', privateUrl: 'hidden-signature' };
  } });
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await fetch(`${base}/api/youtube/preview`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ youtubeUrl: 'https://youtu.be/jNQXAC9IVRw?t=10' }) });
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.equal(JSON.parse(text).previewOnly, true);
    assert.equal(text.includes('hidden-signature'), false);
  }
  assert.equal(calls, 1);
  assert.deepEqual(store.state.videos, []);
  assert.deepEqual(readdirSync(store.incoming), []);
  assert.equal(store.state.desiredRunning, false);
  const invalid = await fetch(`${base}/api/youtube/preview`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ youtubeUrl: 'http://127.0.0.1/private' }) });
  assert.equal(invalid.status, 400);
});

test('YouTube start is asynchronous, saves a canonical URL, and Stop cancels preparation', async t => {
  let cancelled = false;
  const { base, store } = await serverFor(t, {
    youtubeAvailable: true,
    resolveYoutube: (_url, { signal, onProgress }) => new Promise((_resolve, reject) => {
      onProgress({ phase: 'downloading', percent: 25, title: 'Test video' });
      signal.addEventListener('abort', () => { cancelled = true; reject(Object.assign(new Error('Cancelled'), { name: 'AbortError' })); }, { once: true });
    }),
  });
  const key = 'youtube-source-test-key';
  const response = await fetch(`${base}/api/stream/start`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source: 'youtube', youtubeUrl: 'https://youtu.be/jNQXAC9IVRw?t=10', streamKey: key }) });
  assert.equal(response.status, 202);
  const text = await response.text();
  assert.equal(text.includes(key), false);
  assert.equal(JSON.parse(text).stream.status, 'preparing');
  assert.equal(store.state.settings.youtubeUrl, 'https://www.youtube.com/watch?v=jNQXAC9IVRw');
  assert.equal(store.state.desiredRunning, true);
  const pending = await (await fetch(`${base}/api/state`)).json();
  assert.equal(pending.stream.preparation.percent, 25);
  const stopped = await fetch(`${base}/api/stream/stop`, { method: 'POST' });
  assert.equal(stopped.status, 200);
  assert.equal(cancelled, true);
  assert.equal(store.state.desiredRunning, false);
});

test('YouTube sources reject non-YouTube URLs; an inactive draft does not block file streaming', () => {
  const initial = { name: 'Test', loop: true, endAt: null, quality: '720p', videoId: null, source: 'upload', youtubeUrl: '' };
  assert.throws(() => validateSettings({ source: 'youtube', youtubeUrl: 'http://127.0.0.1/admin' }, initial, []));
  assert.throws(() => validateSettings({ source: 'youtube', youtubeUrl: '' }, initial, []));
  assert.throws(() => validateSettings({ source: 'unknown' }, initial, []));
  assert.equal(validateSettings({ source: 'upload', youtubeUrl: 'an unfinished draft' }, initial, []).source, 'upload');
});
