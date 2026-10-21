import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { framingDefaults, videoFraming } from '../shared/framing.mjs';
import { prepareBranding } from '../server/branding.mjs';
import { buildEncoderArgs } from '../server/encoder.mjs';
import { ffmpeg, inspectVideo, captureRemotePreview } from '../server/media.mjs';
import { temporaryDirectory, execute, makeFixture } from './helpers.mjs';

test('framing defaults preserve the centred picture and reject non-finite internal values', () => {
  assert.deepEqual(videoFraming(), framingDefaults);
  assert.deepEqual(videoFraming({ videoZoom: NaN, videoPositionX: Infinity, videoPositionY: '100' }), framingDefaults);
});

for (const frameFit of ['cover', 'contain']) {
  test(`real encoded ${frameFit} video zooms and pans inside stationary banners`, { timeout: 30000 }, async t => {
    const directory = temporaryDirectory(t), input = join(directory, 'quadrants.mp4');
    await execute(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=360x360:r=30,drawbox=x=180:y=0:w=180:h=180:color=green:t=fill,drawbox=x=0:y=180:w=180:h=180:color=blue:t=fill,drawbox=x=180:y=180:w=180:h=180:color=yellow:t=fill',
      '-t', '0.5', '-c:v', 'libx264', '-threads', '2', '-y', input], { windowsHide: true, timeout: 10000 });
    const video = await inspectVideo(input);
    const frames = [];
    for (const position of [0, 100]) {
      const settings = { quality: '720p', loop: false, frameFit, overlayEnabled: true, overlayName: 'CROP TEST', videoZoom: 2, videoPositionX: position, videoPositionY: position };
      const branding = prepareBranding(settings, directory), output = join(directory, `crop-${position}.flv`);
      const args = buildEncoderArgs({ settings, video, input, output, branding });
      await execute(ffmpeg, args, { windowsHide: true, timeout: 10000 });
      const pixels = (await execute(ffmpeg, ['-v', 'error', '-i', output, '-vf', 'scale=90:160', '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'], { windowsHide: true, timeout: 10000, encoding: 'buffer', maxBuffer: 100000 })).stdout;
      frames.push(pixels);
    }
    const pixel = (bytes, x, y) => [...bytes.subarray((y * 90 + x) * 3, (y * 90 + x) * 3 + 3)];
    const topLeft = pixel(frames[0], 45, 78), bottomRight = pixel(frames[1], 45, 78);
    assert.ok(topLeft[0] > 180 && topLeft[1] < 50 && topLeft[2] < 50, 'Top-left focus should show the red quadrant.');
    assert.ok(bottomRight[0] > 180 && bottomRight[1] > 180 && bottomRight[2] < 50, 'Bottom-right focus should show the yellow quadrant.');
    for (const [x, y] of [[5, 8], [45, 5], [5, 154], [45, 155]]) {
      const first = pixel(frames[0], x, y), second = pixel(frames[1], x, y);
      assert.ok(first.every((value, index) => Math.abs(value - second[index]) < 18), 'Video adjustments must not zoom or move the banners.');
    }
  });
}

test('one remote video frame is decoded into a JPEG without creating a library file', { timeout: 20000 }, async t => {
  const directory = temporaryDirectory(t), fixture = join(directory, 'source.mp4');
  await makeFixture(fixture);
  const bytes = readFileSync(fixture);
  const server = createServer((request, response) => {
    const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range || '');
    const start = range ? Number(range[1]) : 0, end = range?.[2] ? Number(range[2]) : bytes.length - 1;
    response.writeHead(range ? 206 : 200, { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1,
      ...(range ? { 'Content-Range': `bytes ${start}-${end}/${bytes.length}` } : {}) });
    response.end(bytes.subarray(start, end + 1));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const preview = await captureRemotePreview({ inputs: [{ url: `http://127.0.0.1:${server.address().port}/video?signature=private`, headers: { 'User-Agent': 'StreamLoop test' } }] });
  assert.equal(preview.width, 960);
  assert.equal(preview.height, 540);
  assert.match(preview.thumbnailUrl, /^data:image\/jpeg;base64,/);
  assert.doesNotMatch(JSON.stringify(preview), /signature|private|127\.0\.0\.1/);
});

test('source top/bottom crop removes old baked-in banners before the new overlay is applied', { timeout: 20000 }, async t => {
  const directory = temporaryDirectory(t), input = join(directory, 'old-banners.mp4'), output = join(directory, 'clean.flv');
  await execute(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=green:s=360x640:r=30,drawbox=x=0:y=0:w=iw:h=160:color=red:t=fill,drawbox=x=0:y=480:w=iw:h=160:color=blue:t=fill',
    '-t', '0.5', '-c:v', 'libx264', '-threads', '2', '-y', input], { windowsHide: true, timeout: 10000 });
  const settings = { quality: '720p', loop: false, overlayEnabled: true, sourceTrimTop: 25, sourceTrimBottom: 25 };
  const video = await inspectVideo(input), branding = prepareBranding(settings, directory);
  await execute(ffmpeg, buildEncoderArgs({ settings, video, input, output, branding }), { windowsHide: true, timeout: 10000 });
  const pixels = (await execute(ffmpeg, ['-v', 'error', '-i', output, '-vf', 'scale=90:160', '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'], { windowsHide: true, timeout: 10000, encoding: 'buffer', maxBuffer: 100000 })).stdout;
  for (const row of [28, 78, 126]) {
    const pixel = (row * 90 + 45) * 3;
    assert.ok(pixels[pixel] < 40 && pixels[pixel + 1] > 80 && pixels[pixel + 2] < 40, 'Only the original green video should remain in the content window.');
  }
});
