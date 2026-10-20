import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../server/store.mjs';
import { StreamController } from '../server/encoder.mjs';
import { YoutubeImporter, youtubeError } from '../server/youtube.mjs';
import { normalizeYouTubeUrl } from '../shared/youtube.mjs';
import { temporaryDirectory, makeFixture, FakeEncoder } from './helpers.mjs';

const canonical = 'https://www.youtube.com/watch?v=jNQXAC9IVRw';
const abortError = () => Object.assign(new Error('Cancelled'), { name: 'AbortError' });

test('YouTube URLs normalize to one safe video URL and strip playlist/tracking parameters', () => {
  for (const value of [canonical + '&list=some-playlist&t=20', 'youtu.be/jNQXAC9IVRw?si=tracking', 'https://m.youtube.com/watch?v=jNQXAC9IVRw', 'https://www.youtube.com/shorts/jNQXAC9IVRw', 'https://www.youtube.com/live/jNQXAC9IVRw']) {
    assert.equal(normalizeYouTubeUrl(value), canonical);
  }
});

test('arbitrary hosts, credentials, ports, playlists and invalid IDs cannot become download targets', () => {
  for (const value of ['http://127.0.0.1/video', 'file:///private/video', 'https://youtube.com.attacker.example/watch?v=jNQXAC9IVRw', 'https://youtube.com@127.0.0.1/watch?v=jNQXAC9IVRw', 'https://user:password@youtube.com/watch?v=jNQXAC9IVRw', 'https://youtube.com:444/watch?v=jNQXAC9IVRw', 'https://youtube.com/playlist?list=123', 'https://youtube.com/watch?v=bad', '--exec malicious']) {
    assert.throws(() => normalizeYouTubeUrl(value));
  }
});

test('a downloaded video is validated, previewed, stored, and reused without downloading again', async t => {
  const directory = temporaryDirectory(t), store = new Store(directory);
  const fixture = join(directory, 'fixture.mp4'); await makeFixture(fixture, true);
  const importer = new YoutubeImporter(store, { getBudget: () => 1024 ** 2 });
  let calls = 0;
  importer.run = async (args, { onLine } = {}) => {
    calls += 1;
    assert.equal(args.at(-1), canonical);
    assert.ok(args.includes('--ignore-config'));
    if (args.includes('--dump-single-json')) return JSON.stringify({ title: 'My source video', duration: 0.8, is_live: false });
    onLine('SL_PROGRESS:{"downloaded_bytes":30,"total_bytes":100}');
    copyFileSync(fixture, join(args[args.indexOf('--paths') + 1], 'source.mp4'));
    return '';
  };
  const progress = [];
  const video = await importer.prepare('https://youtu.be/jNQXAC9IVRw', { onProgress: value => progress.push(value) });
  assert.equal(video.sourceUrl, canonical);
  assert.equal(video.sourceType, 'youtube');
  assert.equal(video.hasAudio, true);
  assert.ok(existsSync(join(store.uploads, video.file)));
  assert.ok(existsSync(join(store.thumbnails, video.thumbnail)));
  assert.deepEqual(readdirSync(store.incoming), []);
  assert.ok(progress.some(value => value.percent === 30));
  assert.equal((await importer.prepare(canonical)).id, video.id);
  assert.equal(calls, 2);
});

test('currently-live sources are rejected before downloading and temporary storage is cleaned', async t => {
  const store = new Store(temporaryDirectory(t));
  const importer = new YoutubeImporter(store, { getBudget: () => 1024 ** 2 });
  let calls = 0;
  importer.run = async () => { calls += 1; return JSON.stringify({ title: 'Live', duration: 100, is_live: true }); };
  await assert.rejects(importer.prepare(canonical), /recorded YouTube video/);
  assert.equal(calls, 1);
  assert.equal(store.state.videos.length, 0);
  assert.deepEqual(readdirSync(store.incoming), []);
});

test('oversized downloads are rejected and their files are removed', async t => {
  const directory = temporaryDirectory(t), store = new Store(directory);
  const fixture = join(directory, 'fixture.mp4'); await makeFixture(fixture, true);
  const importer = new YoutubeImporter(store, { getBudget: () => 1024 ** 2 });
  importer.run = async args => {
    if (args.includes('--dump-single-json')) return JSON.stringify({ title: 'Too big', duration: 0.8, filesize: 2 * 1024 ** 2 });
    throw new Error('The oversized video must not be downloaded.');
  };
  await assert.rejects(importer.prepare(canonical), /size limit/);
  assert.deepEqual(readdirSync(store.incoming), []);
  assert.deepEqual(readdirSync(store.uploads), []);
});

test('cancelling the downloader terminates its process and removes listeners/timers', async () => {
  const child = new FakeEncoder();
  const importer = new YoutubeImporter(null, { spawnProcess: () => child });
  const abort = new AbortController();
  const result = importer.run(['--version'], { signal: abort.signal });
  abort.abort();
  await assert.rejects(result, { name: 'AbortError' });
  assert.equal(child.closed, true);
});

function sourceController(t, resolveSource) {
  const store = new Store(temporaryDirectory(t));
  store.setKey('test-youtube-stream-key');
  Object.assign(store.state.settings, { source: 'youtube', youtubeUrl: canonical, youtubeMode: 'download' });
  const children = [];
  const controller = new StreamController(store, {
    encoderAvailable: true, youtubeAvailable: true,
    resolveSource: (url, options) => resolveSource(store, url, options),
    spawn: () => { const child = new FakeEncoder(); children.push(child); return child; },
  });
  t.after(() => controller.shutdown());
  return { store, controller, children };
}

test('Start returns immediately in preparing state, then automatically launches the encoder', async t => {
  let ready;
  const { store, controller, children } = sourceController(t, (store, _url, { onProgress }) => new Promise(resolveSource => {
    ready = () => { const video = { id: 'imported', file: 'imported.mp4', hasAudio: true }; store.state.videos.push(video); resolveSource(video); };
    onProgress({ phase: 'downloading', percent: 50, title: 'Source' });
  }));
  controller.start();
  assert.equal(controller.status, 'preparing');
  assert.equal(children.length, 0);
  await new Promise(resolveNext => setImmediate(resolveNext));
  assert.equal(controller.snapshot().preparation.percent, 50);
  ready(); await controller.preparation;
  assert.equal(store.state.settings.videoId, 'imported');
  assert.equal(children.length, 1);
  children[0].progress();
  assert.equal(controller.status, 'streaming');
  assert.equal(controller.snapshot().preparation, null);
  await controller.stop();
});

test('Stop during preparation cancels the source and never starts an encoder', async t => {
  let cancelled = false;
  const { store, controller, children } = sourceController(t, (_store, _url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => { cancelled = true; reject(abortError()); }, { once: true });
  }));
  controller.start();
  await new Promise(resolveNext => setImmediate(resolveNext));
  await controller.stop();
  assert.equal(cancelled, true);
  assert.equal(store.state.desiredRunning, false);
  assert.equal(controller.status, 'idle');
  assert.equal(children.length, 0);
});

test('preparation failure clears resume intent and exposes an actionable error', async t => {
  const { store, controller, children } = sourceController(t, () => { throw new Error('This YouTube video is private or unavailable.'); });
  controller.start(); await controller.preparation;
  assert.equal(controller.status, 'error');
  assert.match(controller.reason, /private or unavailable/);
  assert.equal(store.state.desiredRunning, false);
  assert.equal(children.length, 0);
});

test('a server restart resumes YouTube preparation even before a local source exists', async t => {
  const { store, controller, children } = sourceController(t, store => {
    const video = { id: 'resumed', file: 'resumed.mp4', hasAudio: true }; store.state.videos.push(video); return video;
  });
  store.state.desiredRunning = true;
  controller.recover(); await controller.preparation;
  assert.equal(children.length, 1);
  assert.equal(store.state.settings.videoId, 'resumed');
  await controller.stop();
});

test('a scheduled stop cancels YouTube preparation', async t => {
  const { store, controller, children } = sourceController(t, (_store, _url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(abortError()), { once: true })));
  controller.start(); await new Promise(resolveNext => setImmediate(resolveNext));
  store.state.settings.endAt = new Date(Date.now() - 1000).toISOString();
  controller.tick(); await new Promise(resolveNext => setImmediate(resolveNext));
  assert.equal(controller.status, 'idle');
  assert.equal(store.state.desiredRunning, false);
  assert.equal(children.length, 0);
});

test('provider diagnostics are translated without leaking signed media URLs', () => {
  const translated = youtubeError(new Error('HTTP Error 403: https://media.example/video?signature=secret-value'));
  assert.doesNotMatch(translated.message, /signature|secret-value|media.example/);
  assert.match(youtubeError(new Error('Sign in to confirm you are not a bot')).message, /verification/);
});

const directMetadata = (signature = 'private-token') => ({
  title: 'Direct source', duration: 90, is_live: false,
  requested_formats: [
    { url: `https://rr1.googlevideo.com/videoplayback?signature=${signature}`, vcodec: 'avc1', acodec: 'none', width: 1280, height: 720, http_headers: { 'User-Agent': 'test-agent', Referer: 'https://www.youtube.com/', Cookie: 'do-not-forward', Origin: 'bad\r\nInjected: header' } },
    { url: 'https://rr2.googlevideo.com/audio?signature=private-audio', vcodec: 'none', acodec: 'mp4a' },
  ],
});

test('direct resolution only reads metadata and never creates files or checks disk space', async t => {
  const store = new Store(temporaryDirectory(t));
  const importer = new YoutubeImporter(store, { getBudget: () => { throw new Error('Direct mode must not need disk space'); } });
  let calls = 0;
  importer.run = async args => {
    calls++;
    assert.ok(args.includes('--skip-download'));
    assert.ok(args.includes('--dump-single-json'));
    assert.equal(args.at(-1), canonical);
    assert.equal(args.includes('--output'), false);
    return JSON.stringify(directMetadata());
  };
  const source = await importer.resolve(canonical);
  assert.equal(source.remote, true);
  assert.equal(source.hasAudio, true);
  assert.equal(source.audioInput, 1);
  assert.equal(source.inputs.length, 2);
  assert.deepEqual(source.inputs[0].headers, { 'User-Agent': 'test-agent', Referer: 'https://www.youtube.com/' });
  assert.equal(calls, 1);
  assert.deepEqual(store.state.videos, []);
  assert.deepEqual(readdirSync(store.incoming), []);
  assert.deepEqual(readdirSync(store.uploads), []);
  assert.doesNotMatch(JSON.stringify(store.state), /signature|private-token/);
});

test('direct resolution handles combined video/audio and rejects unsafe media URLs', async t => {
  const importer = new YoutubeImporter(new Store(temporaryDirectory(t)));
  importer.run = async () => JSON.stringify({ title: 'Combined', duration: 1, url: 'https://rr1.googlevideo.com/video', vcodec: 'avc1', acodec: 'mp4a' });
  const combined = await importer.resolve(canonical);
  assert.equal(combined.inputs.length, 1);
  assert.equal(combined.audioInput, 0);
  assert.equal(combined.hasAudio, true);
  for (const url of ['http://127.0.0.1/private', 'file:///private', 'https://googlevideo.com.attacker.example/secret', 'https://user:secret@rr1.googlevideo.com/video', 'https://rr1.googlevideo.com:444/video']) {
    const metadata = directMetadata(); metadata.requested_formats[0].url = url;
    importer.run = async () => JSON.stringify(metadata);
    await assert.rejects(importer.resolve(canonical), /Could not prepare/);
  }
});

test('direct looping and retries resolve fresh URLs without caching or leaking addresses', async t => {
  let resolutions = 0;
  const { store, controller, children } = sourceController(t, (_store, _url, { mode }) => {
    assert.equal(mode, 'direct');
    resolutions++;
    return { remote: true, title: 'Direct video', duration: 1, hasAudio: true, audioInput: 0, inputs: [{ url: `https://rr1.googlevideo.com/video?signature=private-${resolutions}` }] };
  });
  store.state.settings.youtubeMode = 'direct';
  controller.retryBase = 10;
  controller.start(); await controller.preparation;
  assert.equal(children.length, 1);
  assert.equal(store.state.settings.videoId, null);
  assert.deepEqual(store.state.videos, []);
  children[0].progress(); children[0].finish(0);
  await controller.preparation;
  assert.equal(resolutions, 2);
  assert.equal(children.length, 2);
  assert.equal(controller.attempt, 0);
  children[1].stderr.write('HTTP failure https://rr1.googlevideo.com/video?signature=private-2');
  children[1].finish(1);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(resolutions, 3);
  assert.equal(children.length, 3);
  assert.doesNotMatch(JSON.stringify(controller.snapshot()), /googlevideo|signature|private-/);
  assert.doesNotMatch(JSON.stringify(store.state), /googlevideo|signature|private-/);
  store.state.settings.loop = false;
  children[2].finish(0);
  assert.equal(controller.status, 'finished');
  assert.equal(store.state.desiredRunning, false);
});
