import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, renameSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { normalizeYouTubeUrl } from '../shared/youtube.mjs';
import { ffmpeg, inspectVideo, makeThumbnail } from './media.mjs';
import { MediaSourceError } from './diagnostics.mjs';

const execute = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const localBinary = join(root, '.tools', 'youtube', process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
export const youtubeBinary = process.env.YT_DLP_PATH || (existsSync(localBinary) ? localBinary : 'yt-dlp');
const format = 'bv*[height<=1080][vcodec^=avc1]+ba[ext=m4a]/b[height<=1080][ext=mp4]/b[height<=1080]';
const aborted = () => Object.assign(new Error('YouTube video preparation cancelled.'), { name: 'AbortError' });
const baseOptions = () => [
  '--ignore-config', '--no-playlist', '--no-cache-dir', '--no-colors',
  '--js-runtimes', `node:${process.execPath}`, '--socket-timeout', '20',
  '--retries', '3', '--fragment-retries', '3', '--extractor-retries', '2',
];

function directInput(item, metadata) {
  const address = new URL(item.url);
  if (address.protocol !== 'https:' || address.username || address.password || (address.port && address.port !== '443') ||
    !['googlevideo.com', 'youtube.com'].some(domain => address.hostname === domain || address.hostname.endsWith(`.${domain}`))) {
    throw new Error('Unsupported YouTube media address.');
  }
  const headers = Object.fromEntries(Object.entries(item.http_headers || metadata.http_headers || {}).filter(([name, value]) =>
    /^(user-agent|referer|origin|accept)$/i.test(name) && typeof value === 'string' && value.length <= 4096 && !/[\r\n\0]/.test(value)));
  return { url: address.href, headers };
}

export async function checkYoutubeDownloader() {
  try { await execute(youtubeBinary, ['--version'], { timeout: 15000, windowsHide: true }); return true; }
  catch { return false; }
}

export function youtubeError(error) {
  const message = String(error?.message || error);
  if (error?.name === 'AbortError' || error instanceof MediaSourceError) return error;
  const fail = (code, text) => new MediaSourceError(code, text, error?.stderr || message);
  if (/ENOENT|not recognized|not found.*yt-dlp/i.test(message)) return fail('YOUTUBE_MISSING', 'YouTube support is not installed. Run npm run setup:youtube and restart the app.');
  if (/no such option|unrecognized (option|argument)|unsupported.*js.runtime|no supported javascript|challenge solving failed|signature extraction failed|n challenge/i.test(message)) return fail('YOUTUBE_UPDATE', 'This YouTube downloader or its JavaScript support needs updating. Run npm run setup:youtube, then restart the app.');
  if (/sign in|sign-in|bot|captcha|confirm your age|cookies/i.test(message)) return fail('YOUTUBE_VERIFICATION', 'YouTube requires verification for this video. Try another public video or upload the video file.');
  if (/requested format.*not available|no playable.*format/i.test(message)) return fail('YOUTUBE_FORMAT', 'YouTube did not offer a playable format on this computer. Run npm run setup:youtube and restart, or upload an MP4 file.');
  if (/private|members.only|unavailable|removed|not available|geo.restrict|copyright/i.test(message)) return fail('YOUTUBE_RESTRICTED', 'This YouTube video is private, unavailable, or restricted. Use an accessible public recorded video.');
  if (/max.filesize|larger than|max.file.size|storage|disk space/i.test(message)) return fail('YOUTUBE_STORAGE', 'This video exceeds the available storage or video size limit. Use a smaller video or free some space.');
  if (/\blive\b|upcoming|scheduled/i.test(message)) return fail('YOUTUBE_LIVE', 'Use a recorded YouTube video. Currently-live and scheduled broadcasts are not supported as sources.');
  if (/timed? ?out|ECONN|network|HTTP Error|403|429/i.test(message)) return fail('YOUTUBE_NETWORK', 'YouTube could not deliver this video. Check your connection, try again, or upload the video file.');
  return fail('YOUTUBE_SOURCE', 'Could not prepare this YouTube video. Try another public recorded video, or run npm run setup:youtube to update the downloader.');
}

function removeWorkDirectory(directory, incoming) {
  const target = resolve(directory);
  if (dirname(target) !== resolve(incoming) || !/^youtube-[a-zA-Z0-9]+$/.test(basename(target))) throw new Error('Invalid YouTube temporary directory.');
  rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
}

export function cleanupYoutubeWork(incoming) {
  for (const entry of readdirSync(incoming, { withFileTypes: true })) {
    if (entry.isDirectory() && /^youtube-[a-zA-Z0-9]+$/.test(entry.name)) removeWorkDirectory(join(incoming, entry.name), incoming);
  }
}

export class YoutubeImporter {
  constructor(store, { getBudget, spawnProcess = spawn } = {}) {
    this.store = store;
    this.getBudget = getBudget;
    this.spawn = spawnProcess;
  }

  run(args, { signal, onLine, timeout = 60000, collect = false, monitor } = {}) {
    return new Promise((resolveRun, reject) => {
      if (signal?.aborted) return reject(aborted());
      const child = this.spawn(youtubeBinary, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      let stdout = '', stderr = '', pending = '', failure;
      let completed = false;
      const terminate = () => {
        if (completed) return;
        if (process.platform === 'win32' && Number.isInteger(child.pid)) {
          // yt-dlp can spawn FFmpeg while merging; stop this owned process tree too.
          execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => { if (!completed) child.kill('SIGKILL'); });
        } else child.kill('SIGKILL');
      };
      const cancel = () => { failure ||= aborted(); terminate(); };
      signal?.addEventListener('abort', cancel, { once: true });
      const timer = setTimeout(() => { failure = new Error('YouTube video preparation timed out.'); terminate(); }, timeout);
      const diskTimer = monitor ? setInterval(() => {
        try { monitor(); } catch (error) { failure = error; terminate(); }
      }, 1000) : null;
      child.stdout.on('data', chunk => {
        const text = chunk.toString();
        if (collect) {
          stdout += text;
          if (stdout.length > 16 * 1024 * 1024) { failure = new Error('YouTube returned too much metadata.'); terminate(); }
        }
        pending += text;
        const lines = pending.split(/\r?\n/); pending = lines.pop();
        for (const line of lines) onLine?.(line);
      });
      child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-6000); });
      child.on('error', error => { failure = error; });
      child.on('close', code => {
        completed = true;
        clearTimeout(timer); clearInterval(diskTimer);
        signal?.removeEventListener('abort', cancel);
        if (signal?.aborted) return reject(aborted());
        if (failure || code !== 0) return reject(failure || new Error(stderr || `yt-dlp exited with code ${code}`));
        resolveRun(stdout);
      });
    });
  }

  async resolve(value, { signal, onProgress = () => {} } = {}) {
    const sourceUrl = normalizeYouTubeUrl(value);
    try {
      onProgress({ phase: 'connecting', percent: null, title: 'Opening a direct connection to YouTube…' });
      const metadata = JSON.parse(await this.run([
        ...baseOptions(), '--format', format, '--skip-download', '--dump-single-json', '--', sourceUrl,
      ], { signal, collect: true, timeout: 90000 }));
      if (signal?.aborted) throw aborted();
      if (metadata.is_live || metadata.is_upcoming || ['is_live', 'is_upcoming', 'post_live'].includes(metadata.live_status)) throw new Error('Live or scheduled video.');
      if (!Number.isFinite(metadata.duration) || metadata.duration <= 0) throw new Error('Video unavailable.');
      const formats = metadata.requested_formats || [metadata];
      const picture = formats.find(item => item.url && item.vcodec && item.vcodec !== 'none');
      if (!picture) throw new Error('No playable YouTube video format.');
      const audio = picture.acodec && picture.acodec !== 'none' ? picture : formats.find(item => item.url && item.acodec && item.acodec !== 'none');
      const inputs = [directInput(picture, metadata)];
      if (audio && audio !== picture) inputs.push(directInput(audio, metadata));
      return {
        remote: true, sourceUrl, title: String(metadata.title || 'YouTube video').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 220),
        duration: metadata.duration, width: picture.width || metadata.width, height: picture.height || metadata.height,
        hasAudio: Boolean(audio), audioInput: audio && audio !== picture ? 1 : 0, inputs,
      };
    } catch (error) { throw youtubeError(error); }
  }

  async prepare(value, { signal, onProgress = () => {} } = {}) {
    const sourceUrl = normalizeYouTubeUrl(value);
    const cached = this.store.state.videos.find(video => video.sourceUrl === sourceUrl && existsSync(join(this.store.uploads, video.file)));
    if (cached) return cached;
    const directory = mkdtempSync(join(this.store.incoming, 'youtube-'));
    let finalPath, thumbnailPath, committed = false;
    const baseArgs = [...baseOptions(), '--format', format];
    try {
      onProgress({ phase: 'resolving', percent: null, title: 'Checking your YouTube video…' });
      const budget = this.getBudget();
      if (budget < 1024 ** 2) throw new Error('Not enough disk space.');
      const metadata = JSON.parse(await this.run([...baseArgs, '--skip-download', '--dump-single-json', '--', sourceUrl], { signal, collect: true, timeout: 90000 }));
      if (metadata.is_live || metadata.is_upcoming || ['is_live', 'is_upcoming', 'post_live'].includes(metadata.live_status)) throw new Error('Live or scheduled video.');
      if (!Number.isFinite(metadata.duration) || metadata.duration <= 0) throw new Error('Video unavailable.');
      const knownSize = metadata.filesize || metadata.requested_formats?.reduce((sum, item) => sum + (item.filesize || 0), 0);
      if (knownSize > budget) throw new Error('Video larger than max-filesize.');
      const title = String(metadata.title || 'YouTube video').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 220);
      onProgress({ phase: 'downloading', percent: 0, title });
      const streamCount = metadata.requested_formats?.length || 1;
      const finishedFiles = new Set();
      await this.run([
        ...baseArgs, '--ffmpeg-location', ffmpeg, '--max-filesize', String(budget),
        '--merge-output-format', 'mp4', '--restrict-filenames', '--newline',
        '--progress', '--progress-delta', '0.5', '--progress-template', 'download:SL_PROGRESS:%(progress)j',
        '--paths', directory, '--output', 'source.%(ext)s', '--', sourceUrl,
      ], {
        signal, timeout: 30 * 60 * 1000,
        onLine: line => {
          if (!line.startsWith('SL_PROGRESS:')) return;
          try {
            const progress = JSON.parse(line.slice('SL_PROGRESS:'.length));
            const downloaded = Number(progress.downloaded_bytes) || 0;
            const total = Number(progress.total_bytes || progress.total_bytes_estimate) || 0;
            const name = progress.filename || 'source';
            if (progress.status === 'finished') finishedFiles.add(name);
            const fraction = finishedFiles.has(name) ? 0 : total > 0 ? Math.min(1, downloaded / total) : null;
            const percent = fraction == null ? null : Math.min(99, Math.round((finishedFiles.size + fraction) / streamCount * 100));
            onProgress({ phase: 'downloading', title, percent, downloadedBytes: downloaded, totalBytes: total || null });
          } catch {}
        },
        monitor: () => {
          const bytes = readdirSync(directory, { withFileTypes: true }).filter(entry => entry.isFile()).reduce((sum, entry) => {
            try { return sum + statSync(join(directory, entry.name)).size; } catch { return sum; }
          }, 0);
          if (bytes > budget * 2 || this.getBudget() < 1024 ** 2) throw new Error('Video exceeds available disk space or max-filesize.');
        },
      });
      if (signal?.aborted) throw aborted();
      onProgress({ phase: 'processing', percent: null, title });
      const file = readdirSync(directory).find(name => /^source\.(mp4|mkv|webm|mov)$/i.test(name));
      if (!file) throw new Error('Video unavailable or larger than max-filesize.');
      const input = join(directory, file);
      const size = statSync(input).size;
      if (size > budget || size > this.getBudget()) throw new Error('Video exceeds available storage or max-filesize.');
      const info = await inspectVideo(input, { signal });
      if (signal?.aborted) throw aborted();
      const id = randomUUID();
      const filename = `${id}${extname(file).toLowerCase()}`;
      finalPath = join(this.store.uploads, filename);
      thumbnailPath = join(this.store.thumbnails, `${id}.jpg`);
      renameSync(input, finalPath);
      let thumbnail = `${id}.jpg`;
      try { await makeThumbnail(finalPath, thumbnailPath, info.duration, { signal }); }
      catch { thumbnail = null; rmSync(thumbnailPath, { force: true }); }
      if (signal?.aborted) throw aborted();
      const video = { id, name: `${title}${extname(file).toLowerCase()}`, file: filename, thumbnail, size, ...info, sourceUrl, sourceType: 'youtube', createdAt: new Date().toISOString() };
      this.store.state.videos.unshift(video);
      this.store.event(`YouTube video ready: “${title}”.`);
      committed = true;
      return video;
    } catch (error) { throw youtubeError(error); }
    finally {
      if (!committed) for (const path of [finalPath, thumbnailPath]) if (path) rmSync(path, { force: true });
      removeWorkDirectory(directory, this.store.incoming);
    }
  }
}
