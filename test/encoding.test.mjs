import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { buildEncoderArgs } from '../server/encoder.mjs';
import { inspectVideo, ffmpeg, ffprobe } from '../server/media.mjs';
import { temporaryDirectory, makeFixture, execute } from './helpers.mjs';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';

for (const audio of [false, true]) {
  test(`real FFmpeg loops ${audio ? 'video with audio' : 'silent video with generated audio'} into YouTube-compatible H.264/AAC`, { timeout: 30000 }, async t => {
    const directory = temporaryDirectory(t);
    const input = join(directory, 'input.mp4'), output = join(directory, 'output.flv');
    await makeFixture(input, audio);
    const video = await inspectVideo(input);
    const args = buildEncoderArgs({ settings: { quality: '720p', loop: true }, video, input, output });
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
  const args = buildEncoderArgs({ settings: { quality: '720p', loop: true }, video, output });
  assert.equal(args.includes('-stream_loop'), false, 'Remote loops must refresh the URL, rather than reuse an expired address');
  await execute(ffmpeg, args, { timeout: 20000, windowsHide: true });
  const { stdout } = await execute(ffprobe, ['-v', 'error', '-show_streams', '-of', 'json', output], { windowsHide: true });
  const result = JSON.parse(stdout);
  assert.ok(result.streams.some(stream => stream.codec_type === 'audio' && stream.codec_name === 'aac'));
  assert.ok(result.streams.some(stream => stream.codec_type === 'video' && stream.width === 1280));
  assert.ok(requests.some(request => request.url === '/video' && request.agent === 'streamloop-test'));
  assert.ok(requests.some(request => request.url === '/audio'));
  await execute(ffmpeg, ['-v', 'error', '-i', output, '-f', 'null', '-'], { timeout: 10000, windowsHide: true });
});
