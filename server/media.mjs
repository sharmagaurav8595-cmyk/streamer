import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const require = createRequire(import.meta.url);
const execute = promisify(execFile);

function binary(environmentName, packageName, fallback) {
  if (process.env[environmentName]) return process.env[environmentName];
  try { return require(packageName).path; } catch { return fallback; }
}

export const ffmpeg = binary('FFMPEG_PATH', '@ffmpeg-installer/ffmpeg', 'ffmpeg');
export const ffprobe = binary('FFPROBE_PATH', '@ffprobe-installer/ffprobe', 'ffprobe');

export async function checkEncoder() {
  try {
    await Promise.all([
      execute(ffmpeg, ['-version'], { timeout: 10000, windowsHide: true }),
      execute(ffprobe, ['-version'], { timeout: 10000, windowsHide: true }),
    ]);
    return true;
  } catch { return false; }
}

export async function inspectVideo(path, { signal } = {}) {
  const { stdout } = await execute(ffprobe, [
    '-v', 'error', '-protocol_whitelist', 'file,pipe',
    '-show_format', '-show_streams', '-of', 'json', path,
  ], { timeout: 30000, maxBuffer: 1024 * 1024, windowsHide: true, signal });
  const { streams = [], format = {} } = JSON.parse(stdout);
  const video = streams.find(s => s.codec_type === 'video' && !s.disposition?.attached_pic);
  const allowed = ['mov', 'mp4', 'matroska', 'webm', 'avi'];
  if (!video || !format.format_name?.split(',').some(name => allowed.includes(name))) {
    throw new Error('Please upload a valid MP4, MOV, MKV, WebM, or AVI video.');
  }
  const duration = Number(format.duration ?? video.duration);
  if (!Number.isFinite(duration) || duration <= 0 || !video.width || !video.height) {
    throw new Error('This video has no readable duration or dimensions. Try exporting it as MP4.');
  }
  if (video.width > 7680 || video.height > 7680) throw new Error('Videos up to 8K are supported.');
  return {
    duration, width: video.width, height: video.height,
    hasAudio: streams.some(s => s.codec_type === 'audio'),
    codec: video.codec_name,
  };
}

export async function makeThumbnail(input, output, duration, { signal } = {}) {
  await execute(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-protocol_whitelist', 'file,pipe',
    '-ss', String(Math.min(2, duration / 4)), '-i', input,
    '-frames:v', '1', '-vf', 'scale=960:-2', '-threads', '2', '-q:v', '4', '-y', output,
  ], { timeout: 30000, maxBuffer: 1024 * 1024, windowsHide: true, signal });
}

export async function captureRemotePreview(source, { signal } = {}) {
  const input = source.inputs[0];
  const headers = Object.entries(input.headers || {}).map(([name, value]) => `${name}: ${value}\r\n`).join('');
  const args = ['-hide_banner', '-loglevel', 'error', '-rw_timeout', '15000000', '-protocol_whitelist', 'https,http,tls,tcp,crypto'];
  if (headers) args.push('-headers', headers);
  args.push('-i', input.url, '-an', '-frames:v', '1', '-vf', 'scale=trunc(iw*sar/2)*2:ih,setsar=1,scale=960:-2', '-threads', '2', '-q:v', '3', '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1');
  const { stdout } = await execute(ffmpeg, args, { encoding: 'buffer', timeout: 20000, maxBuffer: 2 * 1024 ** 2, windowsHide: true, signal });
  // This is FFmpeg's own JPEG output; read its frame dimensions before returning it.
  for (let offset = 2; offset + 9 < stdout.length;) {
    if (stdout[offset] !== 0xff) break;
    const marker = stdout[offset + 1], length = stdout.readUInt16BE(offset + 2);
    if (marker === 0xc0 || marker === 0xc2) return { width: stdout.readUInt16BE(offset + 7), height: stdout.readUInt16BE(offset + 5), thumbnailUrl: `data:image/jpeg;base64,${stdout.toString('base64')}` };
    if (length < 2) break;
    offset += length + 2;
  }
  throw new Error('The video frame could not be read.');
}
