import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync, readFileSync } from 'node:fs';
import { prepareBranding } from '../server/branding.mjs';
import { buildEncoderArgs } from '../server/encoder.mjs';
import { ffmpeg, ffprobe, inspectVideo } from '../server/media.mjs';
import { brandingLayout } from '../shared/branding.mjs';
import { outputFrame } from '../shared/output.mjs';
import { temporaryDirectory, execute } from './helpers.mjs';
import { glyphIndex, fontForText, latinFont, devanagariFont } from '../server/fonts.mjs';

test('the encoder font contains the actual English letters; script-only font must not silently substitute boxes', () => {
  assert.equal(glyphIndex(devanagariFont, 'N'.codePointAt(0)), 0, 'This reproduces the original wrong-font cause.');
  const text = 'NOT THE BOSS FOLLOW ME SUBSCRIBE NOW LIKE | COMMENT | SHARE';
  assert.equal(fontForText(text), latinFont);
  for (const character of text) assert.notEqual(glyphIndex(latinFont, character.codePointAt(0)), 0, `Missing glyph: ${character}`);
  assert.throws(() => fontForText('\u{1f600}'), /cannot display/);
});

test('real encoded names have distinct letter shapes rather than repeated missing-glyph boxes', { timeout: 30000 }, async t => {
  const directory = temporaryDirectory(t), input = join(directory, 'input.mp4');
  await execute(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=green:s=320x180:r=30', '-t', '0.5', '-c:v', 'libx264', '-threads', '2', '-y', input], { windowsHide: true, timeout: 10000 });
  const video = await inspectVideo(input), masks = [];
  for (const name of ['NNNNNNNN', 'MMMMMMMM']) {
    const settings = { quality: '720p', loop: false, overlayEnabled: true, overlayName: name };
    const output = join(directory, `${name}.flv`), branding = prepareBranding(settings, directory);
    await execute(ffmpeg, buildEncoderArgs({ settings, video, input, output, branding }), { windowsHide: true, timeout: 10000 });
    const { stdout } = await execute(ffmpeg, ['-v', 'error', '-i', output, '-vf', 'crop=720:70:0:80,format=gray', '-frames:v', '1', '-f', 'rawvideo', 'pipe:1'], { windowsHide: true, timeout: 10000, encoding: 'buffer', maxBuffer: 100000 });
    masks.push(Buffer.from(stdout.map(value => value > 210 ? 1 : 0)));
  }
  assert.equal(masks[0].equals(masks[1]), false, 'Different letters must not render as the same missing-glyph rectangle.');
});

test('banner geometry leaves an even-sized video window at both qualities and orientations', () => {
  for (const quality of ['720p', '1080p']) for (const layout of ['vertical', 'horizontal']) {
    const frame = outputFrame({ quality, layout });
    const branding = brandingLayout(frame, { overlayEnabled: true, overlayName: 'My channel' });
    assert.equal(branding.top + branding.bottom + branding.contentHeight, frame.height);
    assert.equal(branding.contentHeight % 2, 0);
    assert.ok(branding.contentHeight > frame.height / 2);
    assert.ok(branding.lines.every(line => line.y >= 0 && line.y + line.fontSize < frame.height));
  }
});

for (const audio of [false, true]) {
  test(`real FFmpeg burns editable banners into video ${audio ? 'with source audio' : 'with generated audio'}`, { timeout: 30000 }, async t => {
    const directory = join(temporaryDirectory(t), "Bhai's studio");
    mkdirSync(directory);
    const input = join(directory, 'green.mp4'), output = join(directory, 'branded.flv');
    const sourceArgs = ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=green:s=320x180:r=30'];
    if (audio) sourceArgs.push('-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100');
    sourceArgs.push('-t', '0.6', '-c:v', 'libx264', '-threads', '2', '-pix_fmt', 'yuv420p');
    if (audio) sourceArgs.push('-c:a', 'aac');
    sourceArgs.push('-y', input);
    await execute(ffmpeg, sourceArgs, { windowsHide: true, timeout: 10000 });
    const settings = { quality: '720p', loop: false, overlayEnabled: true,
      overlayName: "Bhai's: [LIVE], 100% \\ #1", followText: 'FOLLOW GAURAV', subscribeText: 'JOIN %{localtime}' };
    const branding = prepareBranding(settings, directory);
    assert.equal(readFileSync(join(directory, 'branding', 'subscribe.txt'), 'utf8'), settings.subscribeText);
    const video = await inspectVideo(input);
    const args = buildEncoderArgs({ settings, video, input, output, branding });
    const graph = args[args.indexOf('-filter_complex') + 1];
    assert.doesNotMatch(graph, /Bhai's:|FOLLOW GAURAV|JOIN %/);
    assert.ok(graph.includes('expansion=none'));
    await execute(ffmpeg, args, { windowsHide: true, timeout: 15000 });
    const metadata = JSON.parse((await execute(ffprobe, ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', output], { windowsHide: true })).stdout);
    assert.ok(metadata.streams.some(stream => stream.codec_type === 'video' && stream.width === 720 && stream.height === 1280));
    assert.ok(metadata.streams.some(stream => stream.codec_type === 'audio' && stream.codec_name === 'aac'));
    assert.ok(Number(metadata.format.duration) < 2, 'The looping banner image must not keep the encoder running after video EOF.');
    const pixels = (await execute(ffmpeg, ['-v', 'error', '-i', output, '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'], { windowsHide: true, timeout: 10000, encoding: 'buffer', maxBuffer: 4 * 1024 ** 2 })).stdout;
    const centre = (640 * 720 + 360) * 3;
    assert.ok(pixels[centre] < 35 && pixels[centre + 1] > 85 && pixels[centre + 2] < 35, 'The middle video must remain visible.');
    for (const line of branding.lines) {
      let whitePixels = 0;
      for (let y = line.y; y < Math.min(1280, line.y + line.fontSize * 1.5); y++) for (let x = 20; x < 700; x++) {
        const offset = (Math.floor(y) * 720 + x) * 3;
        if (pixels[offset] > 200 && pixels[offset + 1] > 200 && pixels[offset + 2] > 200) whitePixels++;
      }
      assert.ok(whitePixels > 30, `Expected readable ${line.key} text burned into the stream.`);
    }
    await execute(ffmpeg, ['-v', 'error', '-i', output, '-f', 'null', '-'], { windowsHide: true, timeout: 10000 });
  });
}
