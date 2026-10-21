import test from 'node:test';
import assert from 'node:assert/strict';
import { previewFailure, safeDiagnostic } from '../server/diagnostics.mjs';
import { youtubeError } from '../server/youtube.mjs';

test('YouTube resolver failures keep their actual cause instead of becoming generic frame failures', () => {
  const verification = previewFailure(youtubeError(new Error('Sign in to confirm you are not a bot')));
  assert.equal(verification.code, 'YOUTUBE_VERIFICATION');
  assert.match(verification.message, /verification/);
  const obsolete = previewFailure(youtubeError(new Error('yt-dlp: error: no such option: --js-runtimes')));
  assert.equal(obsolete.code, 'YOUTUBE_UPDATE');
  assert.match(obsolete.message, /setup:youtube/);
  const format = previewFailure(youtubeError(new Error('Requested format is not available')));
  assert.equal(format.code, 'YOUTUBE_FORMAT');
  const privateVideo = previewFailure(youtubeError(new Error('Private video')));
  assert.equal(privateVideo.code, 'YOUTUBE_RESTRICTED');
});

test('decoder, TLS, HTTP and missing executable errors have distinct actionable diagnostics', () => {
  for (const [message, code] of [
    ['Server returned 403 Forbidden', 'MEDIA_ACCESS_DENIED'],
    ['HTTP error 429 Too Many Requests', 'MEDIA_RATE_LIMITED'],
    ['https: Protocol not found', 'FFMPEG_HTTPS'],
    ['gnutls_handshake() failed: The TLS connection was non-properly terminated', 'MEDIA_TLS'],
    ['Decoder av1 not found', 'MEDIA_DECODER'],
    ['Unknown encoder mjpeg', 'FFMPEG_FEATURE'],
    ['Connection timed out', 'PREVIEW_TIMEOUT'],
    ['Network is unreachable', 'MEDIA_NETWORK'],
  ]) assert.equal(previewFailure(Object.assign(new Error('Command failed'), { stderr: message })).code, code, message);
  assert.equal(previewFailure(Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })).code, 'FFMPEG_MISSING');
  assert.equal(previewFailure(Object.assign(new Error('permission denied'), { code: 'EACCES' })).code, 'FFMPEG_EXECUTION');
  assert.equal(previewFailure(new Error('cancelled'), { aborted: true }).code, 'PREVIEW_TIMEOUT');
});

test('diagnostics strip signed addresses, ANSI escape codes and the destination stream key', () => {
  const key = 'private-stream-key-123';
  const detail = `\x1b[31mHTTP error 403 for https://rr1.googlevideo.com/video?sig=SECRET&token=PRIVATE\x1b[0m\nrtmps://ingest.example/live/${key}\nkey ${key}`;
  const failure = previewFailure(Object.assign(new Error('Command failed'), { stderr: detail }), { key });
  assert.equal(failure.code, 'MEDIA_ACCESS_DENIED');
  assert.doesNotMatch(JSON.stringify(failure), /SECRET|PRIVATE|googlevideo|ingest\.example|private-stream-key|\u001b/);
  assert.ok(safeDiagnostic('x'.repeat(5000)).length <= 1600);
  const resolved = previewFailure(youtubeError(new Error('HTTP Error 403: https://rr1.googlevideo.com/video?sig=HIDDEN')));
  assert.doesNotMatch(JSON.stringify(resolved), /HIDDEN|googlevideo/);
});
