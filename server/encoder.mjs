import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { ffmpeg } from './media.mjs';

export const YOUTUBE_INGEST = 'rtmps://a.rtmps.youtube.com:443/live2/';
export const QUALITY = {
  '720p': { width: 1280, height: 720, bitrate: 4000 },
  '1080p': { width: 1920, height: 1080, bitrate: 6000 },
};

export function buildEncoderArgs({ settings, video, input, output, threads = 2 }) {
  const { width, height, bitrate } = QUALITY[settings.quality];
  const args = ['-hide_banner', '-loglevel', 'warning', '-nostats', '-progress', 'pipe:1'];
  if (video.remote) {
    for (const source of video.inputs) {
      args.push('-re', '-rw_timeout', '15000000', '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5',
        '-protocol_whitelist', 'https,http,tls,tcp,crypto');
      const headers = Object.entries(source.headers || {}).map(([name, value]) => `${name}: ${value}\r\n`).join('');
      if (headers) args.push('-headers', headers);
      args.push('-i', source.url);
    }
  } else {
    if (settings.loop) args.push('-stream_loop', '-1');
    args.push('-re', '-protocol_whitelist', 'file,pipe', '-i', input);
  }
  if (!video.hasAudio) args.push('-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo');
  const audioInput = video.hasAudio ? (video.remote ? video.audioInput : 0) : (video.remote ? video.inputs.length : 1);
  args.push(
    '-map', '0:v:0', '-map', `${audioInput}:a:0`,
    '-vf', `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,format=yuv420p`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-profile:v', 'high',
    '-threads', String(threads), '-b:v', `${bitrate}k`, '-minrate', `${bitrate}k`, '-maxrate', `${bitrate}k`,
    '-bufsize', `${bitrate * 2}k`, '-g', '60', '-keyint_min', '60', '-sc_threshold', '0',
    '-x264-params', 'nal-hrd=cbr:force-cfr=1',
    '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2',
    '-af', 'aresample=async=1:first_pts=0,apad', '-shortest',
    '-rw_timeout', '15000000', '-f', 'flv', '-flvflags', 'no_duration_filesize', output,
  );
  return args;
}

export function redact(value, key = '') {
  let clean = String(value);
  if (key) clean = clean.split(key).join('[hidden]');
  return clean.replace(/rtmps?:\/\/[^\s'"\]]+/gi, '[YouTube ingest]').replace(/https?:\/\/[^\s'"\]]+/gi, '[media address]').slice(-1200);
}

export class StreamController {
  constructor(store, options = {}) {
    this.store = store;
    this.spawn = options.spawn ?? spawn;
    this.retryBase = options.retryBase ?? 3000;
    this.maxRetries = options.maxRetries ?? 10;
    this.encoderAvailable = options.encoderAvailable ?? false;
    this.youtubeAvailable = options.youtubeAvailable ?? false;
    this.resolveSource = options.resolveSource;
    this.preparation = null;
    this.preparationAbort = null;
    this.preparationProgress = null;
    this.remoteSource = null;
    this.child = null;
    this.retryTimer = null;
    this.killTimer = null;
    this.closing = false;
    this.status = 'idle';
    this.reason = 'Ready when you are';
    this.startedAt = null;
    this.attempt = 0;
    this.metrics = {};
    this.monitor = setInterval(() => this.tick(), 1000);
    this.monitor.unref();
  }

  get busy() { return this.store.state.desiredRunning || Boolean(this.child) || Boolean(this.preparation) || this.status === 'stopping'; }

  snapshot() {
    return {
      status: this.status, reason: this.reason, startedAt: this.startedAt,
      attempt: this.attempt, metrics: this.metrics, encoderAvailable: this.encoderAvailable,
      desiredRunning: this.store.state.desiredRunning,
      preparation: this.preparationProgress,
      source: this.remoteSource ? { direct: true, title: this.remoteSource.title, duration: this.remoteSource.duration } : null,
    };
  }

  recover() {
    if (!this.store.state.desiredRunning) return;
    const { endAt, videoId } = this.store.state.settings;
    if (endAt && Date.parse(endAt) <= Date.now()) {
      this.store.state.desiredRunning = false;
      this.store.event('Scheduled end time passed while the server was offline. Stream stays stopped.');
      return;
    }
    const youtubeSource = this.store.state.settings.source === 'youtube';
    if (!this.encoderAvailable || (youtubeSource ? !this.youtubeAvailable : !this.store.state.videos.some(v => v.id === videoId)) || !this.store.getKey()) {
      this.store.state.desiredRunning = false;
      this.status = 'error';
      this.reason = 'Could not resume. Check the encoder, selected video, and stream key.';
      this.store.event(this.reason, 'error');
      return;
    }
    this.startedAt = youtubeSource ? null : new Date().toISOString();
    this.store.event('Server restarted. Resuming the saved stream from the beginning.');
    this.prepareOrLaunch();
  }

  start() {
    if (this.busy) throw Object.assign(new Error('A stream is already running or stopping.'), { status: 409 });
    if (!this.encoderAvailable) throw Object.assign(new Error('FFmpeg is unavailable. Install FFmpeg or use the Docker setup.'), { status: 503 });
    const { settings, videos } = this.store.state;
    if (settings.source === 'youtube') {
      if (!this.youtubeAvailable || !this.resolveSource) throw Object.assign(new Error('YouTube support is not installed. Run npm run setup:youtube and restart the app.'), { status: 503 });
      if (!settings.youtubeUrl) throw Object.assign(new Error('Paste a YouTube video link first.'), { status: 400 });
    } else if (!videos.some(v => v.id === settings.videoId)) throw Object.assign(new Error('Choose an uploaded video first.'), { status: 400 });
    if (!this.store.getKey()) throw Object.assign(new Error('Add your YouTube stream key first.'), { status: 400 });
    this.store.state.desiredRunning = true;
    this.remoteSource = null;
    this.startedAt = settings.source === 'youtube' ? null : new Date().toISOString();
    this.attempt = 0;
    this.store.event(settings.source === 'youtube' ? 'Preparing your YouTube source video…' : 'Stream started. Connecting to YouTube…');
    this.prepareOrLaunch();
  }

  prepareOrLaunch() {
    if (this.store.state.settings.source !== 'youtube') return this.launch();
    const direct = this.store.state.settings.youtubeMode !== 'download';
    this.status = 'preparing';
    this.reason = direct ? 'Opening your YouTube video for direct streaming. No file is saved.' : 'Preparing your YouTube video. Streaming will start automatically.';
    this.metrics = {};
    this.preparationProgress = { phase: direct ? 'connecting' : 'resolving', percent: null, title: 'Checking your YouTube video…' };
    const abort = new AbortController();
    this.preparationAbort = abort;
    const work = Promise.resolve().then(() => this.resolveSource(this.store.state.settings.youtubeUrl, {
      signal: abort.signal,
      mode: direct ? 'direct' : 'download',
      onProgress: progress => {
        if (abort.signal.aborted || this.closing || !this.store.state.desiredRunning) return;
        this.preparationProgress = progress;
        this.reason = direct ? 'Opening your YouTube video for direct streaming. No file is saved.' : progress.phase === 'downloading' ? 'Downloading your YouTube video. Streaming starts when it is ready.' : 'Preparing your YouTube video. Streaming will start automatically.';
      },
    })).then(video => {
      if (abort.signal.aborted || this.closing || !this.store.state.desiredRunning) return;
      this.remoteSource = video.remote ? video : null;
      if (!video.remote) this.store.state.settings.videoId = video.id;
      this.store.save();
      this.preparationProgress = null;
      this.startedAt ??= new Date().toISOString();
      this.store.event(video.remote ? 'Direct source connected. Sending video to YouTube without saving a file.' : 'Source video is ready. Connecting to YouTube…');
      this.launch();
    }).catch(error => {
      if (abort.signal.aborted || this.closing || !this.store.state.desiredRunning) return;
      this.store.state.desiredRunning = false;
      this.status = 'error';
      this.reason = redact(error.message || 'Could not prepare the YouTube video.', this.store.getKey());
      this.store.event(this.reason, 'error');
    }).finally(() => {
      if (this.preparation === work) {
        this.preparation = null;
        this.preparationAbort = null;
        this.preparationProgress = null;
      }
    });
    this.preparation = work;
  }

  launch() {
    if (this.closing || !this.store.state.desiredRunning || this.child) return;
    if (this.store.state.settings.endAt && Date.parse(this.store.state.settings.endAt) <= Date.now()) {
      void this.stop('Scheduled end time reached.');
      return;
    }
    this.status = 'connecting';
    this.reason = 'Connecting to YouTube. Confirm the preview in YouTube Studio.';
    this.metrics = {};
    this.lastProgressAt = Date.now();
    this.connectedAt = null;
    this.forcedFailure = null;
    const { settings, videos } = this.store.state;
    const video = this.remoteSource || videos.find(v => v.id === settings.videoId);
    const key = this.store.getKey();
    const args = buildEncoderArgs({ settings, video, input: video.remote ? undefined : join(this.store.uploads, video.file), output: YOUTUBE_INGEST + key });
    let child;
    try {
      child = this.spawn(ffmpeg, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch (error) {
      this.handleExit(1, redact(error.message, key));
      return;
    }
    this.child = child;
    let buffer = '';
    let errors = '';
    let finished = false;
    const finish = (code, error) => {
      if (finished) return;
      finished = true;
      clearTimeout(this.killTimer);
      this.killTimer = null;
      this.child = null;
      this.handleExit(code, this.forcedFailure || error || errors.trim());
    };
    child.stdout.on('data', chunk => {
      buffer += chunk.toString();
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop();
      for (const line of lines) {
        const index = line.indexOf('=');
        if (index < 0) continue;
        const field = line.slice(0, index), value = line.slice(index + 1).trim();
        if (field === 'out_time_us' || field === 'out_time_ms') this.metrics.outputSeconds = Number(value) / 1e6;
        if (field === 'fps') this.metrics.fps = Number(value) || 0;
        if (field === 'speed') this.metrics.speed = value;
        if (field === 'bitrate') this.metrics.bitrate = value;
        if (field === 'progress') {
          this.lastProgressAt = Date.now();
          if (this.metrics.outputSeconds > 0 && this.status === 'connecting' && !this.forcedFailure) {
            this.status = 'streaming';
            this.reason = 'Encoder is sending video. Check YouTube Studio to confirm the broadcast is live.';
            this.connectedAt = Date.now();
            this.store.event('Encoder is sending video to YouTube.');
          }
        }
      }
    });
    child.stderr.on('data', chunk => { errors = (errors + chunk.toString()).slice(-4000); });
    // A missing binary emits error followed by close; process close is the single completion point.
    child.on('error', error => { errors = error.message; });
    child.stdin.on('error', () => {});
    child.on('close', code => finish(code, null));
  }

  handleExit(code, detail) {
    if (this.closing) return;
    if (!this.store.state.desiredRunning) {
      this.status = 'idle';
      this.metrics = {};
      return;
    }
    if (code === 0 && !this.store.state.settings.loop && !this.forcedFailure) {
      this.store.state.desiredRunning = false;
      this.status = 'finished';
      this.reason = 'Video finished. Stream stopped.';
      this.store.event(this.reason);
      return;
    }
    if (code === 0 && this.remoteSource && this.store.state.settings.loop && !this.forcedFailure) {
      this.store.event('Source video finished. Opening a fresh direct connection to repeat it.');
      this.prepareOrLaunch();
      return;
    }
    if (this.connectedAt && Date.now() - this.connectedAt > 60000) this.attempt = 0;
    this.attempt += 1;
    if (this.attempt > this.maxRetries) {
      this.store.state.desiredRunning = false;
      this.status = 'error';
      this.reason = `Could not connect after ${this.maxRetries} retries. Check your YouTube stream key, network, and server resources, then start again.`;
      this.store.event(this.reason, 'error');
      if (detail) this.store.event(redact(detail, this.store.getKey()), 'error');
      return;
    }
    const delay = Math.min(this.retryBase * 2 ** (this.attempt - 1), 60000);
    this.status = 'reconnecting';
    this.reason = `Connection interrupted. Retry ${this.attempt}/${this.maxRetries} in ${Math.ceil(delay / 1000)}s.`;
    this.store.event(this.reason, 'warning');
    if (detail) this.store.event(redact(detail, this.store.getKey()), 'warning');
    this.retryTimer = setTimeout(() => { this.retryTimer = null; this.prepareOrLaunch(); }, delay);
  }

  tick() {
    if (!this.store.state.desiredRunning || this.closing) return;
    const { endAt } = this.store.state.settings;
    if (endAt && Date.parse(endAt) <= Date.now()) {
      void this.stop('Scheduled end time reached.');
      return;
    }
    if (this.child && !this.forcedFailure && Date.now() - this.lastProgressAt > 60000) {
      this.forcedFailure = 'Encoder stopped making progress for 60 seconds.';
      this.reason = 'Encoder stalled. Restarting the connection…';
      this.terminate();
    }
  }

  terminate() {
    const child = this.child;
    if (!child || this.killTimer) return;
    if (child.stdin.writable) child.stdin.write('q\n');
    this.killTimer = setTimeout(() => { if (this.child === child) child.kill('SIGKILL'); }, 5000);
  }

  async stop(reason = 'Stream stopped by you.') {
    this.store.state.desiredRunning = false;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.reason = reason;
    this.store.event(reason);
    if (this.preparation) {
      this.status = 'stopping';
      this.preparationAbort.abort();
      await this.preparation;
      this.preparationProgress = null;
    }
    const child = this.child;
    if (child) {
      this.status = 'stopping';
      const done = new Promise(resolve => child.once('close', resolve));
      this.terminate();
      await done;
    } else this.status = 'idle';
    this.metrics = {};
    this.remoteSource = null;
  }

  async shutdown() {
    this.closing = true;
    clearInterval(this.monitor);
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    if (this.preparation) {
      this.preparationAbort.abort();
      await this.preparation;
    }
    if (this.child) {
      const done = new Promise(resolve => this.child.once('close', resolve));
      this.terminate();
      await done;
    }
  }
}
