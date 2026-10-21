import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { previewFailure, safeDiagnostic } from '../server/diagnostics.mjs';
import { normalizeYouTubeUrl } from '../shared/youtube.mjs';

const execute = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));

// This command uses the same binaries, resolver and JPEG decoder as the app.
// It does not read stream keys, publish a stream, or save a source video.
export async function diagnoseYoutube(value, log = console) {
  const url = normalizeYouTubeUrl(value);
  const { ffmpeg, ffprobe, captureRemotePreview } = await import('../server/media.mjs');
  const { youtubeBinary, YoutubeImporter } = await import('../server/youtube.mjs');
  log.log(`Platform: ${process.platform}/${process.arch}; Node ${process.versions.node}`);
  for (const [name, path] of [['FFmpeg', ffmpeg], ['FFprobe', ffprobe], ['yt-dlp', youtubeBinary]]) {
    log.log(`${name}: ${path}`);
    try {
      const { stdout } = await execute(path, [name === 'yt-dlp' ? '--version' : '-version'], { timeout: 15000, windowsHide: true });
      log.log(stdout.trim().split(/\r?\n/)[0]);
    } catch (error) {
      log.error(`${name} cannot run: ${safeDiagnostic(error.stderr || error.message)}`);
      return false;
    }
  }
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 45000);
  try {
    log.log('1/2 Resolving the public YouTube source...');
    const source = await new YoutubeImporter(null).resolve(url, { signal: abort.signal });
    log.log(`Source resolved: ${source.width} x ${source.height}; ${source.inputs.length} media input(s).`);
    log.log('2/2 Reading one frame with FFmpeg (no video file saved)...');
    const frame = await captureRemotePreview(source, { signal: abort.signal });
    log.log(`PASS: decoded ${frame.width} x ${frame.height} JPEG. No broadcast started.`);
    return true;
  } catch (error) {
    const failure = previewFailure(error, { aborted: abort.signal.aborted });
    log.error(`FAIL [${failure.code}]: ${failure.message}`);
    if (failure.detail) log.error(failure.detail);
    return false;
  } finally { clearTimeout(timer); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    try { process.loadEnvFile(join(root, '.env')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!process.argv[2]) throw new Error('Usage: npm run diagnose:youtube -- "https://www.youtube.com/watch?v=VIDEO_ID"');
    process.exitCode = await diagnoseYoutube(process.argv[2]) ? 0 : 1;
  } catch (error) { console.error(safeDiagnostic(error.message)); process.exitCode = 1; }
}
