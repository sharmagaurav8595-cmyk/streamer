import { mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createApplication } from '../server/app.mjs';
import { Store } from '../server/store.mjs';
import { makeFixture } from './helpers.mjs';
import { FakeEncoder } from './helpers.mjs';
import { copyFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { StreamController } from '../server/encoder.mjs';
import { YoutubeImporter } from '../server/youtube.mjs';
import { makeThumbnail } from '../server/media.mjs';

mkdirSync(resolve('.tools'), { recursive: true });
process.env.NODE_ENV = 'production';
await makeFixture(resolve('.tools/browser-fixture.mp4'), true);
await makeThumbnail(resolve('.tools/browser-fixture.mp4'), resolve('.tools/browser-preview.jpg'), 0.8);
// A valid MP4 free-space atom makes a large fixture without a long encode.
const padding = Buffer.alloc(32 * 1024 * 1024 + 8);
padding.writeUInt32BE(padding.length);
padding.write('free', 4);
writeFileSync(resolve('.tools/browser-large-fixture.mp4'), Buffer.concat([
  readFileSync(resolve('.tools/browser-fixture.mp4')), padding,
]));
const directory = mkdtempSync(join(tmpdir(), 'streamloop-browser-'));
const store = new Store(directory);
const youtubeImporter = new YoutubeImporter(store, { getBudget: () => 100 * 1024 ** 2 });
youtubeImporter.run = async (args, { signal, onLine } = {}) => {
  if (args.at(-1).includes('unavailable')) throw new Error('Video unavailable');
  if (args.includes('--dump-single-json')) {
    await delay(1500, null, { signal });
    return JSON.stringify({ title: 'YouTube source fixture', duration: 0.8, is_live: false,
      url: 'https://test.googlevideo.com/videoplayback?signature=browser-private', vcodec: 'avc1', acodec: 'mp4a', width: 320, height: 180 });
  }
  await delay(750, null, { signal });
  onLine('SL_PROGRESS:{"downloaded_bytes":42,"total_bytes":100}');
  await delay(750, null, { signal });
  copyFileSync(resolve('.tools/browser-fixture.mp4'), join(args[args.indexOf('--paths') + 1], 'source.mp4'));
  return '';
};
const testController = new StreamController(store, { encoderAvailable: true, spawn: () => {
  const child = new FakeEncoder();
  queueMicrotask(() => child.progress());
  return child;
} });
const { app, controller } = await createApplication({ store, controller: testController, youtubeImporter, youtubeAvailable: true,
  previewYoutube: async (_url, { signal }) => {
    await delay(100, null, { signal });
    return { name: 'YouTube source frame', width: 960, height: 540, duration: 0.8, thumbnailUrl: `data:image/jpeg;base64,${readFileSync(resolve('.tools/browser-preview.jpg')).toString('base64')}` };
  },
});
const server = app.listen(3100, '127.0.0.1');
async function stop() {
  await controller.shutdown();
  server.closeAllConnections();
  server.close();
  rmSync(directory, { recursive: true, force: true });
  process.exit(0);
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
