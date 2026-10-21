import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { buildEncoderArgs } from '../server/encoder.mjs';
import { inspectVideo, ffmpeg, ffprobe } from '../server/media.mjs';
import { temporaryDirectory, makeFixture, execute } from './helpers.mjs';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { prepareBranding } from '../server/branding.mjs';

for (const audio of [false, true]) {
  test(`real FFmpeg loops ${audio ? 'video with audio' : 'silent video with generated audio'} into YouTube-compatible H.264/AAC`, { timeout: 30000 }, async t => {
    const directory = temporaryDirectory(t);
    const input = join(directory, 'input.mp4'), output = join(directory, 'output.flv');
    await makeFixture(input, audio);
    const video = await inspectVideo(input);
    const args = buildEncoderArgs({ settings: { quality: '720p', loop: true, layout: 'horizontal', frameFit: 'contain' }, video, input, output });
    args.splice(-1, 0, '-t', '2.2');
    await execute(ffmpeg, args, { timeout: 20000, windowsHide: true });
    const { stdout } = await execute(ffprobe, ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', output], { windowsHide: true });
    const result = JSON.parse(stdout);
    const encodedVideo = result.streams.find(stream => stream.codec_type === 'video');
    const encodedAudio = result.streams.find(stream => stream.codec_type === 'audio');
    assert.equal(encodedVideo.codec_name, 'h264');
    assert.equal(encodedVideo.width, 1280);
    assert.equal(encodedVideo.height, 720);
    assert.equal(encodedVideo.pix_fmt, 'yuv420p');
    assert.equal(encodedAudio.codec_name, 'aac');
    assert.equal(encodedAudio.sample_rate, '44100');
    assert.ok(Number(result.format.duration) > 2, 'The 0.8-second input must repeat to produce over 2 seconds.');
    // Decode all frames as well: a valid header alone does not prove the repeated stream is playable.
    await execute(ffmpeg, ['-v', 'error', '-i', output, '-f', 'null', '-'], { timeout: 10000, windowsHide: true });
  });
}

test('real FFmpeg reads remote video and separate audio directly over HTTP', { timeout: 30000 }, async t => {
  const directory = temporaryDirectory(t), fixture = join(directory, 'remote.mp4'), output = join(directory, 'direct.flv');
  await makeFixture(fixture, true);
  const bytes = readFileSync(fixture);
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({ url: request.url, agent: request.headers['user-agent'] });
    const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range || '');
    const start = range ? Number(range[1]) : 0;
    const end = range?.[2] ? Math.min(Number(range[2]), bytes.length - 1) : bytes.length - 1;
    response.writeHead(range ? 206 : 200, { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1, ...(range ? { 'Content-Range': `bytes ${start}-${end}/${bytes.length}` } : {}) });
    response.end(bytes.subarray(start, end + 1));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const video = { remote: true, hasAudio: true, audioInput: 1, inputs: [
    { url: `${base}/video`, headers: { 'User-Agent': 'streamloop-test' } },
    { url: `${base}/audio`, headers: { 'User-Agent': 'streamloop-test' } },
  ] };
  const settings = { quality: '720p', loop: true, overlayEnabled: true };
  const args = buildEncoderArgs({ settings, video, output, branding: prepareBranding(settings, directory) });
  assert.equal(args.includes('-stream_loop'), false, 'Remote loops must refresh the URL, rather than reuse an expired address');
  await execute(ffmpeg, args, { timeout: 20000, windowsHide: true });
  const { stdout } = await execute(ffprobe, ['-v', 'error', '-show_streams', '-of', 'json', output], { windowsHide: true });
  const result = JSON.parse(stdout);
  assert.ok(result.streams.some(stream => stream.codec_type === 'audio' && stream.codec_name === 'aac'));
  assert.ok(result.streams.some(stream => stream.codec_type === 'video' && stream.width === 720 && stream.height === 1280 && stream.display_aspect_ratio === '9:16'));
  assert.ok(requests.some(request => request.url === '/video' && request.agent === 'streamloop-test'));
  assert.ok(requests.some(request => request.url === '/audio'));
  await execute(ffmpeg, ['-v', 'error', '-i', output, '-f', 'null', '-'], { timeout: 10000, windowsHide: true });
});

for (const example of [
  { quality: '720p', frameFit: 'cover', source: '320x180', width: 720, height: 1280, name: 'landscape video fills the vertical frame with a centre crop' },
  { quality: '720p', frameFit: 'contain', source: '320x180', width: 720, height: 1280, name: 'landscape video fits inside the vertical frame with black bars' },
  { quality: '1080p', frameFit: 'cover', source: '180x320', width: 1080, height: 1920, name: 'native portrait video stays vertical at full HD' },
]) {
  test(`real encoded output: ${example.name}`, { timeout: 30000 }, async t => {
    const directory = temporaryDirectory(t), input = join(directory, 'framing.mp4'), output = join(directory, 'vertical.flv');
    await execute(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i',
      `color=c=green:s=${example.source}:r=30,drawbox=x=0:y=0:w=iw/3:h=ih:color=red:t=fill,drawbox=x=iw*2/3:y=0:w=iw/3:h=ih:color=blue:t=fill`,
      '-t', '0.5', '-c:v', 'libx264', '-threads', '2', '-pix_fmt', 'yuv420p', '-y', input], { timeout: 10000, windowsHide: true });
    const video = await inspectVideo(input);
    const args = buildEncoderArgs({ settings: { quality: example.quality, loop: false, frameFit: example.frameFit }, video, input, output });
    await execute(ffmpeg, args, { timeout: 15000, windowsHide: true });
    const { stdout } = await execute(ffprobe, ['-v', 'error', '-show_streams', '-of', 'json', output], { windowsHide: true });
    const streams = JSON.parse(stdout).streams;
    const picture = streams.find(stream => stream.codec_type === 'video');
    assert.equal(picture.width, example.width);
    assert.equal(picture.height, example.height);
    assert.equal(picture.sample_aspect_ratio, '1:1');
    assert.equal(picture.display_aspect_ratio, '9:16');
    assert.equal(picture.r_frame_rate, '30/1');
    assert.equal(picture.codec_name, 'h264');
    assert.ok(streams.some(stream => stream.codec_type === 'audio' && stream.codec_name === 'aac'));
    const decoded = await execute(ffmpeg, ['-v', 'error', '-i', output, '-vf', 'scale=90:160', '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'], { encoding: 'buffer', maxBuffer: 100000, timeout: 10000, windowsHide: true });
    const pixel = (x, y) => [...decoded.stdout.subarray((y * 90 + x) * 3, (y * 90 + x) * 3 + 3)];
    const green = rgb => rgb[1] > 75 && rgb[0] < 45 && rgb[2] < 45;
    const black = rgb => rgb.every(value => value < 20);
    assert.ok(green(pixel(45, 80)), 'The centre of the source must stay in the centre of the output.');
    if (example.frameFit === 'contain') {
      assert.ok(black(pixel(45, 5)) && black(pixel(45, 155)), 'Full-video mode must add black bars above and below the picture.');
      assert.ok(pixel(5, 80)[0] > 150 && pixel(85, 80)[2] > 150, 'Full-video mode must preserve both source edges.');
    } else if (example.source === '320x180') {
      assert.ok(green(pixel(5, 80)) && green(pixel(85, 80)) && green(pixel(45, 5)), 'Fill mode must crop the side strips and fill the canvas.');
    } else {
      assert.ok(pixel(5, 80)[0] > 150 && pixel(85, 80)[2] > 150, 'An existing 9:16 source must retain both edges.');
    }
    await execute(ffmpeg, ['-v', 'error', '-i', output, '-f', 'null', '-'], { timeout: 10000, windowsHide: true });
  });
}
