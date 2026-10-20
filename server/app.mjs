import express from 'express';
import multer from 'multer';
import { randomUUID } from 'node:crypto';
import { existsSync, renameSync, rmSync, readdirSync, statfsSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './store.mjs';
import { StreamController, QUALITY } from './encoder.mjs';
import { inspectVideo, makeThumbnail, checkEncoder } from './media.mjs';
import { YoutubeImporter, checkYoutubeDownloader, cleanupYoutubeWork } from './youtube.mjs';
import { normalizeYouTubeUrl } from '../shared/youtube.mjs';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const MB = 1024 ** 2, GB = 1024 ** 3;
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
let downloaderCheck;

export function validateSettings(body, current, videos) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw fail('Send valid stream settings.');
  const next = { ...current };
  if ('source' in body && !['upload', 'youtube'].includes(body.source)) throw fail('Choose an uploaded video or a YouTube link.');
  next.source = body.source ?? next.source ?? 'upload';
  if ('youtubeMode' in body && !['direct', 'download'].includes(body.youtubeMode)) throw fail('Choose direct streaming or download first.');
  next.youtubeMode = body.youtubeMode ?? next.youtubeMode ?? 'direct';
  if ('youtubeUrl' in body) {
    if (typeof body.youtubeUrl !== 'string') throw fail('Enter a YouTube video link.');
    next.youtubeUrl = body.youtubeUrl.trim();
  }
  next.youtubeUrl ??= '';
  if (next.youtubeUrl && next.source === 'youtube') {
    try { next.youtubeUrl = normalizeYouTubeUrl(next.youtubeUrl); }
    catch (error) { throw fail(error.message); }
  }
  if (next.source === 'youtube' && !next.youtubeUrl) throw fail('Paste a YouTube video link first.');
  if ('name' in body) {
    if (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 120) throw fail('Stream name must be between 1 and 120 characters.');
    next.name = body.name.trim();
  }
  if ('videoId' in body) {
    if (body.videoId !== null && !videos.some(v => v.id === body.videoId)) throw fail('That video is no longer in your library.');
    next.videoId = body.videoId;
  }
  if ('quality' in body) {
    if (!Object.hasOwn(QUALITY, body.quality)) throw fail('Choose 720p or 1080p quality.');
    next.quality = body.quality;
  }
  if ('loop' in body) {
    if (typeof body.loop !== 'boolean') throw fail('Loop must be on or off.');
    next.loop = body.loop;
  }
  if ('endAt' in body) next.endAt = body.endAt;
  if (next.endAt !== null) {
    if (typeof next.endAt !== 'string' || !Number.isFinite(Date.parse(next.endAt)) || Date.parse(next.endAt) <= Date.now()) {
      throw fail('Choose an end time in the future, or clear it to stream without a time limit.');
    }
    next.endAt = new Date(next.endAt).toISOString();
  }
  if (body.streamKey !== undefined && (typeof body.streamKey !== 'string' || !/^[a-zA-Z0-9_-]{8,160}$/.test(body.streamKey.trim()))) {
    throw fail('Paste a valid YouTube stream key (letters, numbers, dashes, and underscores).');
  }
  return next;
}

export async function createApplication(options = {}) {
  const store = options.store ?? new Store(resolve(process.env.DATA_DIR || join(projectRoot, 'data')));
  const encoderAvailable = options.encoderAvailable ?? await checkEncoder();
  const controller = options.controller ?? new StreamController(store, { encoderAvailable });
  const youtubeAvailable = options.youtubeAvailable ?? await (downloaderCheck ??= checkYoutubeDownloader());
  const maxUploadBytes = Math.floor(Number(process.env.MAX_UPLOAD_GB || 5) * GB);
  const maxStorageBytes = Math.floor(Number(process.env.MAX_STORAGE_GB || 20) * GB);
  if (!Number.isFinite(maxUploadBytes) || !Number.isFinite(maxStorageBytes) || maxUploadBytes <= 0 || maxStorageBytes <= 0) {
    throw new Error('MAX_UPLOAD_GB and MAX_STORAGE_GB must be positive numbers.');
  }
  // Incoming uploads are never part of the library. Remove incomplete uploads on boot.
  for (const name of readdirSync(store.incoming)) {
    if (/^[a-f0-9-]{36}\.(mp4|mov|mkv|webm|avi)$/i.test(name)) rmSync(join(store.incoming, name), { force: true });
  }
  cleanupYoutubeWork(store.incoming);
  let uploadInProgress = false;
  const youtubeImporter = options.youtubeImporter ?? new YoutubeImporter(store, { getBudget: () => {
    const used = store.state.videos.reduce((total, video) => total + video.size, 0);
    const disk = statfsSync(store.directory);
    const free = Number(disk.bavail) * Number(disk.bsize);
    // Reserve room for video + audio and FFmpeg's merged output.
    return Math.floor(Math.min(maxUploadBytes, maxStorageBytes - used, (free - 100 * MB) / 2));
  } });
  controller.youtubeAvailable = youtubeAvailable;
  controller.resolveSource = options.resolveYoutube ?? controller.resolveSource ?? ((url, options) => options.mode === 'download' ? youtubeImporter.prepare(url, options) : youtubeImporter.resolve(url, options));
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    // A local studio should only answer local Host headers (also prevents DNS rebinding).
    const bindHost = process.env.HOST || '127.0.0.1';
    if (!['0.0.0.0', '::'].includes(bindHost) && !['localhost', '127.0.0.1', '[::1]', '::1', bindHost].includes(req.hostname)) {
      return next(fail('Use the local address printed by the streaming server.', 421));
    }
    res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'DENY' });
    if (process.env.NODE_ENV === 'production') {
      res.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
    }
    next();
  });
  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      if (req.get('sec-fetch-site') === 'cross-site') return next(fail('Requests must come from this app.', 403));
      const origin = req.get('origin');
      if (origin) {
        try {
          if (new URL(origin).host !== req.get('host')) return next(fail('Requests must come from this app.', 403));
        } catch { return next(fail('Invalid request origin.', 403)); }
      }
    }
    next();
  });
  app.use(express.json({ limit: '16kb' }));

  const publicVideo = v => ({
    id: v.id, name: v.name, size: v.size, duration: v.duration, width: v.width, height: v.height,
    hasAudio: v.hasAudio, createdAt: v.createdAt,
    sourceType: v.sourceType || 'upload', sourceUrl: v.sourceUrl || null,
    url: `/media/video/${v.id}`, thumbnailUrl: v.thumbnail ? `/media/thumbnail/${v.id}` : null,
  });
  const state = () => ({
    settings: { ...store.state.settings, keySet: Boolean(store.state.encryptedKey) },
    videos: store.state.videos.map(publicVideo),
    stream: controller.snapshot(), events: store.state.events,
    youtube: { available: youtubeAvailable },
    storage: { used: store.state.videos.reduce((total, v) => total + v.size, 0), limit: maxStorageBytes, maxUpload: maxUploadBytes },
    serverTime: new Date().toISOString(),
  });
  function saveSettings(body) {
    if (controller.busy) throw fail('Stop the current stream before changing settings.', 409);
    const settings = validateSettings(body, store.state.settings, store.state.videos);
    if (body.streamKey !== undefined) store.setKey(body.streamKey.trim());
    store.state.settings = settings;
    store.save();
  }

  app.get('/api/state', (_req, res) => res.json(state()));
  app.put('/api/settings', (req, res) => { saveSettings(req.body); res.json(state()); });
  app.post('/api/stream/start', (req, res) => {
    if (controller.busy) throw fail('A stream is already running or stopping.', 409);
    if (uploadInProgress && (req.body?.source ?? store.state.settings.source) === 'youtube') throw fail('Wait for the current video upload to finish before starting from a YouTube link.', 409);
    if (!controller.encoderAvailable) throw fail('FFmpeg is unavailable. Install FFmpeg or use the Docker setup.', 503);
    saveSettings(req.body);
    controller.start();
    res.status(202).json(state());
  });
  app.post('/api/stream/stop', async (_req, res) => {
    await controller.stop();
    res.json(state());
  });

  app.post('/api/videos', async (req, res, next) => {
    if (!encoderAvailable) return next(fail('FFmpeg is unavailable. Install FFmpeg or use Docker before uploading.', 503));
    if (uploadInProgress) return next(fail('Another video is being uploaded. Please wait for it to finish.', 409));
    if (controller.preparation) return next(fail('Wait for the YouTube video to finish preparing, or cancel it before uploading.', 409));
    const used = store.state.videos.reduce((total, v) => total + v.size, 0);
    const fs = statfsSync(store.directory);
    const free = Number(fs.bavail) * Number(fs.bsize);
    const remaining = Math.min(maxStorageBytes - used, free - 100 * MB);
    if (remaining < MB) return next(fail('Server storage is full. Delete a video or increase disk space.', 507));
    uploadInProgress = true;
    let incomingPath, finalPath, thumbnailPath;
    const storage = multer.diskStorage({
      destination: store.incoming,
      filename(_req, file, callback) {
        const extension = extname(file.originalname).toLowerCase();
        if (!['.mp4', '.mov', '.mkv', '.webm', '.avi'].includes(extension)) return callback(fail('Upload an MP4, MOV, MKV, WebM, or AVI video.'));
        const name = `${randomUUID()}${extension}`;
        incomingPath = join(store.incoming, name);
        callback(null, name);
      },
    });
    const receive = multer({ storage, limits: { fileSize: Math.min(maxUploadBytes, remaining), files: 1, fields: 0, parts: 1 } }).single('video');
    try {
      await new Promise((resolveUpload, reject) => receive(req, res, error => error ? reject(error) : resolveUpload()));
      if (!req.file) throw fail('Choose a video to upload.');
      let info;
      try { info = await inspectVideo(req.file.path); }
      catch (error) { throw fail(error.status ? error.message : 'This file could not be read as a video. Try exporting it as MP4.'); }
      const id = randomUUID();
      finalPath = join(store.uploads, req.file.filename);
      renameSync(req.file.path, finalPath);
      thumbnailPath = join(store.thumbnails, `${id}.jpg`);
      let thumbnail = `${id}.jpg`;
      try { await makeThumbnail(finalPath, thumbnailPath, info.duration); }
      catch { thumbnail = null; rmSync(thumbnailPath, { force: true }); }
      if (res.destroyed) throw fail('Upload was cancelled.');
      const name = basename(req.file.originalname.replaceAll('\\', '/')).slice(0, 240);
      const video = { id, name, file: req.file.filename, thumbnail, size: req.file.size, createdAt: new Date().toISOString(), ...info };
      store.state.videos.unshift(video);
      if (!store.state.settings.videoId && !controller.busy) store.state.settings.videoId = id;
      store.event(`Uploaded “${name}”.`);
      res.status(201).json({ ...state(), uploadedVideoId: id });
    } catch (error) {
      for (const path of [incomingPath, finalPath, thumbnailPath]) {
        if (path) { try { rmSync(path, { force: true }); } catch {} }
      }
      if (error instanceof multer.MulterError) {
        next(fail(error.code === 'LIMIT_FILE_SIZE'
          ? `Upload exceeds the available storage or the ${Math.round(maxUploadBytes / GB)} GB file limit.`
          : 'Upload one video at a time using the video field.', error.code === 'LIMIT_FILE_SIZE' ? 413 : 400));
      } else next(error);
    } finally { uploadInProgress = false; }
  });

  app.delete('/api/videos/:id', (req, res) => {
    const video = store.state.videos.find(v => v.id === req.params.id);
    if (!video) throw fail('Video not found.', 404);
    if (controller.busy && store.state.settings.videoId === video.id) throw fail('Stop the stream before deleting its video.', 409);
    // Update the library first so a failed file removal never leaves a broken selectable video.
    store.state.videos = store.state.videos.filter(v => v.id !== video.id);
    if (store.state.settings.videoId === video.id) store.state.settings.videoId = null;
    store.event(`Deleted “${video.name}”.`);
    rmSync(join(store.uploads, video.file), { force: true });
    if (video.thumbnail) rmSync(join(store.thumbnails, video.thumbnail), { force: true });
    res.json(state());
  });
  app.get('/media/:kind/:id', (req, res) => {
    const video = store.state.videos.find(v => v.id === req.params.id);
    if (!video || !['video', 'thumbnail'].includes(req.params.kind)) throw fail('Media not found.', 404);
    const thumbnail = req.params.kind === 'thumbnail';
    if (thumbnail && !video.thumbnail) throw fail('Thumbnail not found.', 404);
    const path = join(thumbnail ? store.thumbnails : store.uploads, thumbnail ? video.thumbnail : video.file);
    if (!existsSync(path)) throw fail('This file is missing from server storage.', 404);
    res.set('Cache-Control', 'private, max-age=3600');
    res.sendFile(path);
  });
  app.use('/api', (_req, _res, next) => next(fail('API endpoint not found.', 404)));
  const dist = join(projectRoot, 'dist');
  if (existsSync(dist)) {
    app.use(express.static(dist, { maxAge: '1h', index: false }));
    app.get('/{*path}', (_req, res) => { res.set('Cache-Control', 'no-cache'); res.sendFile(join(dist, 'index.html')); });
  } else app.get('/', (_req, res) => res.type('text').send('StreamLoop API is running. Open http://localhost:5173 for the development UI, or run npm run build.'));

  app.use((error, _req, res, _next) => {
    if (res.headersSent || res.destroyed) return;
    const status = error.status || (error.type === 'entity.parse.failed' ? 400 : 500);
    res.status(status).json({ error: status >= 500 && status !== 503 && status !== 507 ? 'The server could not complete this request. Check disk space and try again.' : error.message });
  });
  if (options.recover !== false) controller.recover();
  return { app, store, controller };
}
