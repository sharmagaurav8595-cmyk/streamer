import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import {
  Activity, ArrowDownToLine, ArrowRight, ArrowUpRight, Check, CheckCircle2,
  ChevronDown, ChevronRight, CircleHelp, Clock3, Cloud, CloudUpload, ExternalLink,
  Eye, EyeOff, Film, FolderOpen, HardDrive, Infinity as InfinityIcon, KeyRound,
  Link2, Loader2, Play, Plus, Radio, RefreshCw, Save, Server, ShieldCheck,
  Square, Trash2, Video, Waves, Wifi, X, Youtube,
} from 'lucide-react';
import { normalizeYouTubeUrl } from '../shared/youtube.mjs';
import { outputFrame } from '../shared/output.mjs';
import { brandingDefaults, brandingLayout } from '../shared/branding.mjs';
import { BrandingLayer, BrandingSettings } from './Branding.jsx';
import FramingControls from './FramingControls.jsx';
import { framingDefaults, videoFraming, sourceCropPreview } from '../shared/framing.mjs';

const activeStatuses = ['preparing', 'connecting', 'streaming', 'reconnecting', 'stopping'];
const statusLabels = { idle: 'Ready to stream', preparing: 'Preparing YouTube video', connecting: 'Connecting', streaming: 'Sending to YouTube', reconnecting: 'Reconnecting', stopping: 'Stopping', finished: 'Stream finished', error: 'Needs attention' };
const localHost = ['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname);

export function formatBytes(value = 0) {
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(0)} KB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  return `${(value / 1024 ** 3).toFixed(2)} GB`;
}
export function formatDuration(seconds = 0) {
  const value = Math.max(0, Math.floor(seconds));
  return `${Math.floor(value / 3600).toString().padStart(2, '0')}:${Math.floor(value / 60 % 60).toString().padStart(2, '0')}:${(value % 60).toString().padStart(2, '0')}`;
}
function localDate(value) {
  if (!value) return '';
  const date = new Date(value);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}T${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}
async function api(path, options = {}) {
  const { timeoutMs = 15000, ...requestOptions } = options;
  const response = await fetch(`/api${path}`, {
    ...requestOptions, headers: { 'Content-Type': 'application/json', ...options.headers }, signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
  });
  let body;
  try { body = await response.json(); }
  catch { throw new Error('Could not reach the streaming server. Check that it is running.'); }
  if (!response.ok) throw Object.assign(new Error(body.error || 'This request could not be completed.'), { code: body.code, detail: body.detail });
  return body;
}

function Dialog({ title, subtitle, onClose, children, wide = false }) {
  const ref = useRef(null);
  const id = useId();
  useEffect(() => { ref.current?.showModal(); }, []);
  return <dialog ref={ref} className={`dialog ${wide ? 'dialog-wide' : ''}`} aria-labelledby={id} onCancel={onClose} onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
    <div className="dialog-header"><div><h2 id={id}>{title}</h2>{subtitle && <p>{subtitle}</p>}</div><button className="icon-button" onClick={onClose} aria-label="Close dialog"><X size={20} /></button></div>
    {children}
  </dialog>;
}

function EmptyVideo({ onUpload, disabled, limit, dragOver, onDragOver, onDragLeave, onDrop }) {
  return <button type="button" className={`upload-zone ${dragOver ? 'drag-over' : ''}`} onClick={onUpload} disabled={disabled}
    onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}>
    <span className="upload-art"><span className="art-film art-back"><Film size={28} /></span><span className="art-film art-front"><Play size={25} fill="currentColor" /></span><span className="art-cloud"><CloudUpload size={22} /></span></span>
    <strong>Drop a video. Go live.</strong><span>Drag & drop your video here, or <b>browse files</b></span>
    <small>MP4, MOV, MKV, WebM, AVI · up to {formatBytes(limit)}</small>
  </button>;
}

function UploadProgress({ upload, onCancel }) {
  return <div className="upload-progress" role="status">
    <div className="progress-icon"><CloudUpload size={28} /></div><strong>{upload.percent >= 100 ? 'Getting your video ready…' : 'Uploading to your server…'}</strong>
    <span className="truncate">{upload.name}</span><div className="progress-track"><div style={{ width: `${upload.percent}%` }} /></div>
    <div className="progress-foot"><span>{upload.percent >= 100 ? 'Checking video & creating preview' : `${upload.percent}% uploaded · keep this tab open`}</span><button className="text-button" onClick={onCancel}>Cancel</button></div>
  </div>;
}

function YoutubePreparation({ progress, onCancel }) {
  const phase = progress?.phase || 'resolving';
  const percent = progress?.percent;
  return <div className="upload-progress youtube-preparation" role="status">
    <div className="progress-icon"><Youtube size={28} /></div>
    <strong>{phase === 'connecting' ? 'Opening your YouTube video…' : phase === 'resolving' ? 'Checking your YouTube video…' : phase === 'downloading' ? 'Downloading your YouTube video…' : 'Preparing your video preview…'}</strong>
    <span className="truncate">{progress?.title || 'Streaming will start automatically when the video is ready.'}</span>
    <div className={`progress-track ${percent == null ? 'indeterminate' : ''}`} role="progressbar" aria-label="YouTube video preparation" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent ?? undefined}><div style={{ width: `${percent ?? 35}%` }} /></div>
    <div className="progress-foot"><span>{phase === 'connecting' ? 'Direct connection · no video file saved' : phase === 'downloading' && percent != null ? `${percent}% · preparing on your server` : 'You can close this tab. Preparation continues.'}</span><button className="text-button" onClick={onCancel}>Cancel</button></div>
  </div>;
}

function VideoPreview({ video, frame, settings, playing, onPlay, onStop, onError, playbackError }) {
  const branding = brandingLayout(frame, settings);
  const framing = videoFraming(settings);
  const sourceCrop = sourceCropPreview({ ...frame, height: branding.enabled ? branding.contentHeight : frame.height }, video, settings);
  return <div className={`video-preview ${frame.layout === 'vertical' ? 'vertical-output' : ''} ${branding.enabled ? 'branding-enabled' : ''}`} style={{ aspectRatio: `${frame.width} / ${frame.height}`, '--preview-fit': frame.frameFit, '--video-top': `${branding.top / frame.height * 100}%`, '--video-height': `${branding.contentHeight / frame.height * 100}%`, '--banner-bottom': `${branding.bottom / frame.height * 100}%` }} role="group" aria-label={video ? 'Stream layout preview' : 'Stream overlay preview'}>
    <div className="video-window" style={{ '--video-focus': `${framing.videoPositionX}% ${framing.videoPositionY}%`, '--video-zoom': framing.videoZoom }}>
    <div className={sourceCrop ? 'source-crop-frame' : 'uncropped-frame'} style={{ ...sourceCrop?.frame, '--source-image-height': sourceCrop?.image.height, '--source-image-top': sourceCrop?.image.top }}>
    {video && !video.previewOnly && playing && !playbackError
      ? <video key={video.id} controls autoPlay playsInline preload="metadata" poster={video.thumbnailUrl || undefined} onError={onError}><source src={video.url} /></video>
      : <>
        {video?.thumbnailUrl ? <img src={video.thumbnailUrl} alt={`Preview of ${video.name}`} /> : <div className="preview-placeholder"><Film size={52} />{!video && <small>Your video appears here</small>}</div>}
      </>}
    </div>
    </div>
    {video && !video.previewOnly && !playing && !playbackError && <button className="preview-play" onClick={onPlay} aria-label={video.sourceType === 'youtube' ? 'Play YouTube video preview' : 'Play uploaded video preview'}><Play size={25} fill="currentColor" /></button>}
    {playing && onStop && <button className="preview-stop" onClick={onStop} aria-label="Stop source preview"><Square size={11} fill="currentColor" /> Stop preview</button>}
    {playbackError && <div className="preview-error"><Video size={28} /><span>This format cannot be previewed in your browser.<br />The server can still stream it.</span><a href={video.url} download className="preview-download"><ArrowDownToLine size={15} /> Download original</a></div>}
    {branding.enabled && <BrandingLayer frame={frame} settings={settings} />}
    {video && <span className="video-duration">{formatDuration(video.duration)}</span>}
  </div>;
}

export default function App() {
  const [data, setData] = useState(null);
  const [form, setForm] = useState(null);
  const [streamKey, setStreamKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [page, setPage] = useState('studio');
  const [dialog, setDialog] = useState(null);
  const [connected, setConnected] = useState(true);
  const [initialError, setInitialError] = useState('');
  const [busy, setBusy] = useState('');
  const [upload, setUpload] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const [toast, setToast] = useState(null);
  const [now, setNow] = useState(Date.now());
  const [playing, setPlaying] = useState(false);
  const [playbackError, setPlaybackError] = useState(false);
  const [youtubePreview, setYoutubePreview] = useState(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState('');
  const previewAbort = useRef(null);
  const fileInput = useRef(null);
  const xhrRef = useRef(null);
  const toastTimer = useRef(null);
  const initialized = useRef(false);

  const notify = useCallback((message, error = false) => {
    clearTimeout(toastTimer.current);
    setToast({ message, error });
    toastTimer.current = setTimeout(() => setToast(null), error ? 8500 : 4000);
  }, []);
  const acceptState = useCallback(next => {
    setData(next);
    setConnected(true);
    setInitialError('');
    if (!initialized.current) {
      initialized.current = true;
      setForm(next.settings);
    }
  }, []);
  const refresh = useCallback(async () => {
    try { acceptState(await api('/state')); }
    catch (error) { setConnected(false); setInitialError(error.message); }
  }, [acceptState]);
  useEffect(() => {
    let disposed = false, timer;
    async function poll() {
      try { const next = await api('/state'); if (!disposed) acceptState(next); }
      catch (error) { if (!disposed) { setConnected(false); setInitialError(error.message); } }
      if (!disposed) timer = setTimeout(poll, 3000);
    }
    void poll();
    const clock = setInterval(() => setNow(Date.now()), 1000);
    return () => { disposed = true; clearTimeout(timer); clearInterval(clock); };
  }, [acceptState]);
  useEffect(() => { setPlaying(false); setPlaybackError(false); }, [form?.videoId, form?.source, form?.youtubeUrl]);
  useEffect(() => {
    previewAbort.current?.abort(); setYoutubePreview(null); setPreviewError(''); setPreviewLoading(false);
  }, [form?.youtubeUrl, form?.source]);
  useEffect(() => () => { clearTimeout(toastTimer.current); xhrRef.current?.abort(); previewAbort.current?.abort(); }, []);

  const stream = data?.stream;
  const running = stream && (activeStatuses.includes(stream.status) || stream.desiredRunning);
  const locked = Boolean(running || busy);
  const youtubeSource = form?.source === 'youtube';
  const directYoutube = youtubeSource && form?.youtubeMode !== 'download';
  let normalizedYoutubeUrl = '', youtubeUrlError = '';
  if (form?.youtubeUrl?.trim()) {
    try { normalizedYoutubeUrl = normalizeYouTubeUrl(form.youtubeUrl); }
    catch (error) { youtubeUrlError = error.message; }
  }
  const selectedVideo = directYoutube ? null : data?.videos.find(video => youtubeSource ? video.sourceUrl === normalizedYoutubeUrl : video.id === form?.videoId);
  const sourcePreview = youtubePreview?.sourceUrl === normalizedYoutubeUrl ? youtubePreview : null;
  const keyReady = Boolean(data?.settings.keySet || streamKey.trim());
  const dirty = Boolean(data && form && (streamKey || ['name', 'videoId', 'quality', 'loop', 'endAt', 'source', 'youtubeUrl', 'youtubeMode', 'layout', 'frameFit', 'overlayEnabled', 'overlayName', 'followText', 'subscribeText', 'videoZoom', 'videoPositionX', 'videoPositionY', 'sourceTrimTop', 'sourceTrimBottom'].some(key => form[key] !== data.settings[key])));
  const frame = outputFrame(form || {});
  const qualityFrame = quality => outputFrame({ ...form, quality });
  const elapsed = stream?.startedAt ? (now - new Date(stream.startedAt).getTime()) / 1000 : 0;
  const sourceReady = youtubeSource ? Boolean(normalizedYoutubeUrl && data?.youtube?.available) : Boolean(selectedVideo);
  const overlayValues = { ...brandingDefaults, ...form };
  const brandingReady = !overlayValues.overlayEnabled || Boolean(overlayValues.overlayName?.trim() && overlayValues.followText?.trim() && overlayValues.subscribeText?.trim());
  const canStart = connected && sourceReady && keyReady && brandingReady && stream?.encoderAvailable && !busy && !upload && !previewLoading;
  const change = (key, value) => setForm(previous => ({ ...previous, [key]: value }));
  const selectVideo = id => setForm(previous => ({ ...previous, source: 'upload', videoId: id }));
  const chooseFile = () => fileInput.current?.click();

  async function loadYoutubeFrame() {
    if (!normalizedYoutubeUrl || previewLoading) return;
    const abort = new AbortController();
    previewAbort.current?.abort(); previewAbort.current = abort;
    setPreviewLoading(true); setPreviewError('');
    try {
      const preview = await api('/youtube/preview', { method: 'POST', body: JSON.stringify({ youtubeUrl: normalizedYoutubeUrl }), timeoutMs: 55000, signal: abort.signal });
      if (!abort.signal.aborted) setYoutubePreview(preview);
    } catch (error) { if (!abort.signal.aborted) setPreviewError({ message: error.message, code: error.code, detail: error.detail }); }
    finally { if (previewAbort.current === abort) setPreviewLoading(false); }
  }

  async function command(path, action, method = 'POST') {
    setBusy(action);
    try {
      const payload = { ...form };
      if (streamKey.trim()) payload.streamKey = streamKey.trim();
      const next = await api(path, { method, body: JSON.stringify(path.endsWith('/stop') ? {} : payload) });
      acceptState(next);
      setForm(next.settings);
      setStreamKey('');
      setShowKey(false);
      notify(action === 'save' ? 'Settings saved on your server.' : action === 'start' ? next.stream.status === 'preparing' ? directYoutube ? 'Opening a direct connection. No video file will be saved.' : 'Preparing your YouTube video. Streaming will start automatically.' : 'Connecting to YouTube. Check your YouTube Studio preview.' : 'Stream stopped.');
    } catch (error) { notify(error.message, true); }
    finally { setBusy(''); }
  }

  function uploadVideo(file) {
    if (!file || upload) return;
    if (!/\.(mp4|mov|mkv|webm|avi)$/i.test(file.name)) return notify('Choose an MP4, MOV, MKV, WebM, or AVI video.', true);
    if (file.size > data.storage.maxUpload) return notify(`Maximum file size is ${formatBytes(data.storage.maxUpload)}.`, true);
    if (file.size + data.storage.used > data.storage.limit) return notify('Not enough storage. Delete a video first.', true);
    const xhr = new XMLHttpRequest();
    xhrRef.current = xhr;
    setUpload({ name: file.name, percent: 0 });
    xhr.open('POST', '/api/videos');
    xhr.upload.onprogress = event => { if (event.lengthComputable) setUpload({ name: file.name, percent: Math.min(100, Math.round(event.loaded / event.total * 100)) }); };
    xhr.onload = () => {
      try {
        const next = JSON.parse(xhr.responseText);
        if (xhr.status < 200 || xhr.status >= 300) throw new Error(next.error || 'Upload failed.');
        acceptState(next);
        if (!running) selectVideo(next.uploadedVideoId);
        notify('Video uploaded. It is now stored on your server.');
      } catch (error) { notify(error.message || 'Upload failed. Please try again.', true); }
    };
    xhr.onerror = () => notify('Upload interrupted. Check your connection and try again.', true);
    xhr.onabort = () => notify('Upload cancelled.');
    xhr.onloadend = () => { setUpload(null); xhrRef.current = null; if (fileInput.current) fileInput.current.value = ''; };
    const body = new FormData();
    body.append('video', file);
    xhr.send(body);
  }
  function drop(event) {
    event.preventDefault(); setDragOver(false);
    if (locked || upload) return;
    if (event.dataTransfer.files.length > 1) return notify('Upload one video at a time.', true);
    uploadVideo(event.dataTransfer.files[0]);
  }
  async function deleteVideo(video) {
    if (!window.confirm(`Delete “${video.name}” from your server? This cannot be undone.`)) return;
    setBusy(`delete-${video.id}`);
    try {
      const next = await api(`/videos/${video.id}`, { method: 'DELETE' });
      acceptState(next);
      if (form.videoId === video.id) change('videoId', null);
      notify('Video deleted.');
    } catch (error) { notify(error.message, true); }
    finally { setBusy(''); }
  }

  function libraryContent(chooser = false) {
    return <>
      {upload && <UploadProgress upload={upload} onCancel={() => xhrRef.current?.abort()} />}
      {data.videos.length ? <div className={`video-grid ${chooser ? 'chooser-grid' : ''}`}>
        {data.videos.map(video => <article className={`library-video ${form.videoId === video.id ? 'is-selected' : ''}`} key={video.id}>
          <button className="library-select" disabled={locked} onClick={() => { selectVideo(video.id); if (chooser) setDialog(null); else { setPage('studio'); notify('Video selected. Start streaming when you are ready.'); } }} aria-label={`Select ${video.name}`}>
            <div className="library-thumbnail">{video.thumbnailUrl ? <img src={video.thumbnailUrl} alt="" /> : <Film size={40} />}<span className="video-duration">{formatDuration(video.duration)}</span>{form.videoId === video.id && <span className="selected-tick"><Check size={14} /></span>}</div>
            <div className="library-video-info"><strong title={video.name}>{video.name}</strong><span>{video.width} × {video.height}<i />{formatBytes(video.size)}</span></div>
          </button>
          <div className="library-video-footer"><span>{form.videoId === video.id ? <><span className="dot purple" /> Selected video</> : <><Video size={13} /> Ready to stream</>}</span><button className="icon-button delete-button" onClick={() => deleteVideo(video)} disabled={Boolean(busy) || (running && data.settings.videoId === video.id)} aria-label={`Delete ${video.name}`}><Trash2 size={15} /></button></div>
        </article>)}
      </div> : !upload && <EmptyVideo onUpload={chooseFile} disabled={!stream.encoderAvailable || Boolean(upload)} limit={data.storage.maxUpload} dragOver={dragOver} onDragOver={e => { e.preventDefault(); setDragOver(true); }} onDragLeave={() => setDragOver(false)} onDrop={drop} />}
    </>;
  }

  return <div className="app-shell">
    <aside className="sidebar">
      <a className="brand" href="#studio" onClick={() => setPage('studio')} aria-label="StreamLoop studio"><span className="brand-mark"><Radio size={23} strokeWidth={2.2} /></span><span>Stream<span className="brand-accent">Loop</span><small>YOUR PERSONAL STUDIO</small></span></a>
      <span className="nav-label">WORKSPACE</span>
      <nav aria-label="Main navigation"><button className={`nav-item ${page === 'studio' ? 'active' : ''}`} onClick={() => setPage('studio')}><Radio size={20} /> Stream studio <ChevronRight className="nav-arrow" size={15} /></button><button className={`nav-item ${page === 'videos' ? 'active' : ''}`} onClick={() => setPage('videos')}><FolderOpen size={20} /> Video library <span className="nav-count">{data?.videos.length ?? 0}</span></button></nav>
      <div className="sidebar-bottom"><div className="sidebar-tip"><div className="tip-heading"><Cloud size={18} /><span>Made to keep going</span></div><p>Your video streams from your server, even after you close this tab.</p><button onClick={() => setDialog('guide')}>See how it works <ArrowUpRight size={14} /></button></div><button className="nav-item help-nav" onClick={() => setDialog('guide')}><CircleHelp size={19} /> Quick start guide <ArrowUpRight size={15} /></button><div className="workspace-profile"><span className="profile-avatar">G</span><div><strong>Gaurav’s studio</strong><span>Personal workspace</span></div><ShieldCheck size={17} /></div></div>
    </aside>
    <div className="main-shell">
      <header className="topbar"><div className="breadcrumb"><span>Workspace</span><ChevronRight size={14} /><strong>{page === 'studio' ? 'Stream studio' : 'Video library'}</strong></div><div className="topbar-right"><span className={`server-pill ${!connected ? 'offline' : ''}`}><span className={`dot ${connected ? 'green' : 'red'}`} />{connected ? 'Server connected' : 'Server disconnected'}</span><a href="https://studio.youtube.com" target="_blank" rel="noreferrer" className="studio-link">YouTube Studio <ArrowUpRight size={15} /></a></div></header>
      {!data || !form ? <main className="loading-page">{initialError ? <><Server size={36} /><h2>Let’s connect your server</h2><p>{initialError}</p><p>Start the app with <code>npm run dev</code>, then try again.</p><button className="button primary" onClick={refresh}><RefreshCw size={16} /> Try again</button></> : <><Loader2 className="spin" size={32} /><p>Opening your studio…</p></>}</main> : <>
        <main className="main-content">
          {!connected && <div className="notice error-notice" role="alert"><Wifi size={19} /><div><strong>Streaming backend is unreachable</strong><p>Check the terminal running npm run dev. If the backend stopped, run npm run server to see its error, then restart the app. Stream status is unavailable.</p></div><button className="text-button" onClick={refresh}>Retry</button></div>}
          {!stream.encoderAvailable && <div className="notice error-notice" role="alert"><Server size={19} /><div><strong>FFmpeg is not installed</strong><p>Use the Docker setup, or install FFmpeg and FFprobe, then restart the server.</p></div></div>}
          <div className="page-heading"><div><div className="eyebrow"><span className="tiny-line" /> {page === 'studio' ? 'UPLOAD. LOOP. GO LIVE.' : 'YOUR CONTENT, READY TO GO.'}</div><h1>{page === 'studio' ? <>Your stream, <span>on repeat.</span></> : <>Your video <span>library.</span></>}</h1><p>{page === 'studio' ? 'Turn a pre-recorded video into an always-on YouTube live stream.' : 'Upload once. Stream whenever you want. All files stay on your server.'}</p></div><button className="button secondary guide-button" onClick={() => setDialog('guide')}><CircleHelp size={16} /> How it works</button></div>
          {page === 'studio' ? <>
            <div className="cloud-banner"><span className="cloud-banner-icon"><Cloud size={22} /></span><div><strong>Your browser can rest. Your server keeps streaming.</strong><p>{localHost ? 'Running locally? Keep this computer and the backend on. Deploy to a VPS for 24/7 streaming.' : 'Once your upload finishes, you can close this tab. Keep your streaming server running.'}</p></div><span className="server-tag"><Server size={13} /> Server powered</span></div>
            <section className="studio-card" aria-label="Stream setup">
              <div className="card-header"><div><span className="card-icon"><Radio size={18} /></span><h2>Stream setup</h2><span className="small-label">ONE VIDEO. ENDLESS POSSIBILITIES.</span></div><span className={`status-badge ${stream.status}`}><span className={`dot ${stream.status === 'streaming' ? 'green' : stream.status === 'error' ? 'red' : 'purple'}`} />{statusLabels[stream.status] || stream.status}</span></div>
              <div className="setup-columns">
                <div className="settings-column"><div className="section-label"><span>01</span> Stream details</div>
                  <label className="field"><span>Stream name <span className="optional">only visible to you</span></span><input value={form.name} onChange={e => change('name', e.target.value)} disabled={locked} placeholder="e.g. My 24/7 gaming stream" maxLength={120} /></label>
                  <label className="field"><span>Platform</span><div className="platform-field"><span className="youtube-icon"><Youtube size={21} fill="currentColor" /></span><span>YouTube Live</span><span className="connected-tag">RTMPS</span><ChevronDown size={15} /></div></label>
                  <div className="field"><label htmlFor="stream-key" className="field-label">Stream key <a href="https://studio.youtube.com" target="_blank" rel="noreferrer">Find your key <ArrowUpRight size={12} /></a></label><div className="key-input"><KeyRound size={16} /><input id="stream-key" aria-label="Stream key" type={showKey ? 'text' : 'password'} autoComplete="new-password" spellCheck={false} value={streamKey} onChange={e => setStreamKey(e.target.value)} disabled={locked} placeholder={data.settings.keySet ? '••••••••••••••••••••  (saved)' : 'Paste your YouTube stream key'} /><button className="icon-button" disabled={locked} onClick={() => setShowKey(value => !value)} aria-label={showKey ? 'Hide stream key' : 'Show stream key'}>{showKey ? <EyeOff size={17} /> : <Eye size={17} />}</button></div><span className="field-hint"><ShieldCheck size={12} /> {data.settings.keySet ? 'Key saved securely. Paste a new key to replace it.' : 'Encrypted on your server. No YouTube login needed here.'}</span></div>
                  <label className="field"><span>Output format</span><div className="select-wrap"><select aria-label="Output format" value={form.layout || 'vertical'} onChange={e => change('layout', e.target.value)} disabled={locked}><option value="vertical">Vertical 9:16 — Reels / Shorts style</option><option value="horizontal">Horizontal 16:9 — widescreen</option></select><ChevronDown size={15} /></div></label>
                  <label className="field"><span>Video framing</span><div className="select-wrap"><select aria-label="Video framing" value={form.frameFit || 'cover'} onChange={e => change('frameFit', e.target.value)} disabled={locked}><option value="cover">Fill frame — centre crop</option><option value="contain">Fit full video — black bars</option></select><ChevronDown size={15} /></div><span className="field-hint">{frame.frameFit === 'cover' ? 'Fills the frame without stretching. Edges outside the frame are cropped.' : 'Keeps the whole picture without stretching. Empty space is filled with black.'}</span></label>
                  <FramingControls settings={form} disabled={locked || !data.features?.videoFraming} onChange={change} onReset={() => setForm(previous => ({ ...previous, ...framingDefaults }))} />
                  <label className="field"><span>Streaming quality</span><div className="select-wrap"><select aria-label="Streaming quality" value={form.quality} onChange={e => change('quality', e.target.value)} disabled={locked}><option value="720p">HD · {qualityFrame('720p').width} × {qualityFrame('720p').height} · 4 Mbps</option><option value="1080p">Full HD · {qualityFrame('1080p').width} × {qualityFrame('1080p').height} · 6 Mbps</option></select><ChevronDown size={15} /></div></label>
                  <div className="output-summary" role="status" aria-label="Outgoing video format"><Video size={16} /><span><strong>{frame.width} × {frame.height} · {frame.aspectRatio}</strong><small>{frame.layout === 'vertical' ? 'Vertical output to YouTube' : 'Horizontal output to YouTube'} · 30 fps</small></span></div>
                  <BrandingSettings settings={form} disabled={locked} available={data.features?.streamOverlay === true} onChange={change} />
                  <div className="loop-row"><span className="loop-icon"><InfinityIcon size={21} /></span><div><strong>Loop video</strong><span>{form.loop ? 'Play again when the video ends' : 'Stop when the video finishes'}</span></div><button type="button" role="switch" aria-checked={form.loop} aria-label="Loop video" className={`toggle ${form.loop ? 'on' : ''}`} onClick={() => change('loop', !form.loop)} disabled={locked}><span /></button></div>
                  <div className="end-time-heading"><label htmlFor="end-time">Stop automatically <span className="optional">optional</span></label>{form.endAt && !locked && <button className="text-button" onClick={() => change('endAt', null)}>Clear</button>}</div><div className="end-time-input"><Clock3 size={16} /><input id="end-time" type="datetime-local" aria-label="Stream end time" value={localDate(form.endAt)} min={localDate(new Date(now + 60000).toISOString())} onChange={e => change('endAt', e.target.value ? new Date(e.target.value).toISOString() : null)} disabled={locked} /></div><p className="field-hint time-hint">{form.endAt ? `Your timezone: ${Intl.DateTimeFormat().resolvedOptions().timeZone}` : 'Leave empty to stream without a time limit.'}</p>
                </div>
                <div className="video-column"><div className="video-section-heading"><div className="section-label"><span>02</span> Your video</div>{data.videos.length > 0 && !youtubeSource && <button className="text-button" onClick={() => setDialog('choose')} disabled={locked}><RefreshCw size={13} /> Change video</button>}</div>
                  <div className="source-tabs" role="tablist" aria-label="Video source"><button id="source-upload" role="tab" aria-selected={!youtubeSource} aria-controls="source-panel" className={!youtubeSource ? 'selected' : ''} disabled={locked || Boolean(upload)} onClick={() => change('source', 'upload')}><CloudUpload size={16} /> Upload video</button><button id="source-youtube" role="tab" aria-selected={youtubeSource} aria-controls="source-panel" className={youtubeSource ? 'selected' : ''} disabled={locked || Boolean(upload)} onClick={() => change('source', 'youtube')}><Youtube size={17} /> YouTube link</button></div>
                  <div id="source-panel" role="tabpanel" aria-labelledby={youtubeSource ? 'source-youtube' : 'source-upload'}>
                  {youtubeSource && <div className="youtube-source-input"><label className="field"><span>YouTube video link</span><div className="key-input"><Link2 size={17} /><input aria-label="YouTube video link" type="url" value={form.youtubeUrl || ''} placeholder="https://www.youtube.com/watch?v=…" disabled={locked} onChange={event => change('youtubeUrl', event.target.value)} spellCheck={false} /></div></label>{youtubeUrlError && <p className="source-error" role="alert">{youtubeUrlError}</p>}<p className="field-hint">Public recorded videos · watch links, Shorts & youtu.be</p><label className="field youtube-mode"><span>Playback mode</span><div className="select-wrap"><select aria-label="YouTube playback mode" value={form.youtubeMode || 'direct'} disabled={locked} onChange={event => change('youtubeMode', event.target.value)}><option value="direct">Direct stream — no file saved</option><option value="download">Download first — save a copy</option></select><ChevronDown size={15} /></div></label>{data.features?.videoFraming && <div className="source-preview-actions"><button type="button" className="text-button" disabled={!normalizedYoutubeUrl || previewLoading || !connected} onClick={loadYoutubeFrame}>{previewLoading ? <Loader2 size={13} className="spin" /> : <Film size={13} />} {previewLoading ? 'Loading video frame...' : sourcePreview ? 'Reload video frame' : 'Load video frame'}</button><small>One still frame for cropping. No video file is saved.</small></div>}{previewError && <div className="source-error preview-diagnostic" role="alert"><p>{previewError.message}</p>{previewError.detail && <details><summary>Technical details{previewError.code ? ` ? ${previewError.code}` : ""}</summary><pre>{previewError.detail}</pre></details>}</div>}{!data.youtube?.available && <div className="source-install-note"><strong>YouTube link support needs a one-time setup.</strong><span>Run <code>npm run setup:youtube</code>, then restart the app.</span></div>}</div>}
                  {stream.status === 'preparing' ? <YoutubePreparation progress={stream.preparation} onCancel={() => command('/stream/stop', 'stop')} /> : upload ? <UploadProgress upload={upload} onCancel={() => xhrRef.current?.abort()} /> : selectedVideo ? <div className="selected-video"><VideoPreview video={selectedVideo} frame={frame} settings={form} playing={playing} onStop={() => setPlaying(false)} onPlay={() => setPlaying(true)} playbackError={playbackError} onError={() => setPlaybackError(true)} /><div className="selected-video-info"><span className="file-icon"><Film size={20} /></span><div><strong title={selectedVideo.name}>{selectedVideo.name}</strong><span>{formatBytes(selectedVideo.size)}<i />{selectedVideo.width} × {selectedVideo.height}<i />{selectedVideo.hasAudio ? 'With audio' : 'Silent audio added'}</span></div><span className="video-ready"><CheckCircle2 size={17} /></span></div></div> : youtubeSource ? <div className="youtube-source-empty"><span><Youtube size={31} /></span><strong>{directYoutube ? running && stream.source?.direct ? 'Streaming directly from YouTube' : 'Stream without saving a video file.' : 'A link is all you need.'}</strong><p>{directYoutube && running && stream.source?.title ? stream.source.title : <>Paste your video link, add a stream key, and click <b>Start streaming</b>.</>}</p><small>{directYoutube ? 'Video and audio flow straight to your stream. Only a small memory buffer is used.' : 'Your video is saved on this device first, then streaming starts automatically.'}</small>{directYoutube && normalizedYoutubeUrl && <a className="text-button source-watch" href={normalizedYoutubeUrl} target="_blank" rel="noreferrer">Watch source on YouTube <ArrowUpRight size={12} /></a>}</div> : <EmptyVideo onUpload={chooseFile} disabled={locked || !stream.encoderAvailable} limit={data.storage.maxUpload} dragOver={dragOver} onDragOver={e => { e.preventDefault(); setDragOver(true); }} onDragLeave={() => setDragOver(false)} onDrop={drop} />}
                  {(form.overlayEnabled || sourcePreview) && !selectedVideo && !upload && stream.status !== 'preparing' && <div className="branding-demo"><VideoPreview video={sourcePreview} frame={frame} settings={form} /><p>{sourcePreview ? 'Still frame for crop adjustment' : 'Overlay preview'} · check the source video in YouTube Studio once connected.</p></div>}
                  {selectedVideo && !upload && !youtubeSource && <button className="upload-another" onClick={chooseFile} disabled={locked}><Plus size={15} /> Upload another video</button>}
                  {youtubeSource && selectedVideo && stream.status !== 'preparing' && <div className="youtube-cached"><CheckCircle2 size={14} /> Video is ready in your library. Future starts use this saved copy.</div>}
                  {youtubeSource && stream.status === 'error' && normalizedYoutubeUrl === data.settings.youtubeUrl && <p className="source-error" role="alert">{stream.reason}</p>}
                  </div>
                  <div className="video-note"><span><CheckCircle2 size={15} /> {directYoutube ? 'Starts after connecting, without a full download' : youtubeSource ? 'Prepare once, then stream from your server' : 'Upload once, stream from your server'}</span><span><CheckCircle2 size={15} /> {form.loop ? directYoutube ? 'Loop reconnects from the start; a brief pause may occur' : 'Seamless repeat with loop enabled' : 'Single playback, then automatic stop'}</span><span><CheckCircle2 size={15} /> {directYoutube ? 'Keep your internet connection and server running' : selectedVideo?.hasAudio === false ? 'Silent audio track added automatically' : 'Original video audio included'}</span></div>
                  <div className="youtube-reminder"><Youtube size={21} /><p>Set your title & visibility in <a href="https://studio.youtube.com" target="_blank" rel="noreferrer">YouTube Studio <ArrowUpRight size={11} /></a>. Enable auto-start, or click <strong>Go live</strong> when the preview appears.</p></div>
                </div>
              </div>
              <div className="card-footer"><div className="save-state">{dirty ? <><span className="dot amber" /> Unsaved changes</> : <><CheckCircle2 size={14} /> Settings saved on server</>}</div><button className="button save-button" onClick={() => command('/settings', 'save', 'PUT')} disabled={locked || !dirty || !connected}>{busy === 'save' ? <Loader2 className="spin" size={15} /> : <Save size={15} />} Save settings</button></div>
            </section>
            <div className="stats-row"><div className="stat-card"><span className={`stat-icon ${running ? 'live-icon' : ''}`}><Activity size={20} /></span><div><span>Stream uptime</span><strong>{running ? formatDuration(elapsed) : '00:00:00'}</strong></div><span className="stat-caption">{running ? 'This session' : 'Ready for your next live'}</span></div><div className="stat-card"><span className="stat-icon"><Film size={20} /></span><div><span>Video library</span><strong>{data.videos.length} <small>{data.videos.length === 1 ? 'video' : 'videos'}</small></strong></div><button className="stat-link" onClick={() => setPage('videos')} aria-label="Open video library"><ArrowUpRight size={19} /></button></div><div className="stat-card"><span className="stat-icon"><HardDrive size={20} /></span><div><span>Server storage</span><strong>{formatBytes(data.storage.used)} <small>/ {formatBytes(data.storage.limit)}</small></strong></div><span className="mini-storage"><span style={{ width: `${Math.max(3, data.storage.used / data.storage.limit * 100)}%` }} /></span></div></div>
            {data.events.length > 0 && <details className="activity-panel"><summary><span><Waves size={16} /> Stream activity</span><span>{data.events.length} {data.events.length === 1 ? 'event' : 'events'} <ChevronDown size={14} /></span></summary>{running && <div className="encoder-metrics"><span>Encoder output</span><strong>{stream.metrics.fps ?? '—'} fps</strong><strong>{stream.metrics.bitrate || '—'}</strong><strong>Speed {stream.metrics.speed || '—'}</strong></div>}<div className="event-list">{data.events.map(event => <div className={`event ${event.level}`} key={event.id}><span className={`dot ${event.level === 'error' ? 'red' : event.level === 'warning' ? 'amber' : 'purple'}`} /><time dateTime={event.at}>{new Date(event.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</time><span>{event.message}</span></div>)}</div></details>}
          </> : <section className="library-page"><div className="library-toolbar"><span><Film size={17} /> {data.videos.length} {data.videos.length === 1 ? 'video' : 'videos'} <i /> {formatBytes(data.storage.used)} used</span><button className="button primary" onClick={chooseFile} disabled={Boolean(upload) || !connected || !stream.encoderAvailable}><Plus size={17} /> Upload video</button></div>{libraryContent()}<p className="library-footnote"><ShieldCheck size={14} /> Stored on your server. Closing your browser will not remove your videos.</p></section>}
          <div className="page-footnote"><span className="brand-mini"><Radio size={13} /> StreamLoop</span><span>A little setup. A lot of airtime.</span><button onClick={() => setDialog('guide')}>Need a hand? <ArrowUpRight size={12} /></button></div>
        </main>
        <footer className="stream-dock"><div className="dock-status"><span className={`dock-status-icon ${running ? 'is-live' : ''}`}><Radio size={21} /></span><div><strong>{!connected ? 'Connection lost' : statusLabels[stream.status]}</strong><span>{!connected ? 'Waiting to reconnect to your server' : running ? stream.reason : sourceReady && keyReady ? 'All set. Your next live is one click away.' : youtubeSource ? 'Add a YouTube link and stream key to get started.' : 'Add a video and stream key to get started.'}</span></div></div><div className="dock-actions">{running && stream.startedAt && <span className="dock-timer"><span className="dot green" />{formatDuration(elapsed)}</span>}{running ? <button className="button danger start-button" onClick={() => command('/stream/stop', 'stop')} disabled={Boolean(busy) || !connected || stream.status === 'stopping'}>{busy === 'stop' || stream.status === 'stopping' ? <Loader2 className="spin" size={17} /> : <Square size={15} fill="currentColor" />} {stream.status === 'preparing' ? 'Cancel preparation' : 'Stop stream'}</button> : <button className="button primary start-button" onClick={() => command('/stream/start', 'start')} disabled={!canStart}>{busy === 'start' ? <Loader2 className="spin" size={17} /> : <Radio size={17} />} Start streaming <ArrowRight size={16} /></button>}</div></footer>
      </>}
    </div>
    <input ref={fileInput} className="visually-hidden" type="file" accept=".mp4,.mov,.mkv,.webm,.avi" aria-label="Upload video file" onChange={e => uploadVideo(e.target.files?.[0])} />
    {dialog === 'choose' && data && <Dialog title="Choose your video" subtitle="Select a video from your server library." wide onClose={() => setDialog(null)}><div className="dialog-body">{libraryContent(true)}<button className="button secondary modal-upload" onClick={chooseFile} disabled={Boolean(upload) || !stream.encoderAvailable}><Plus size={16} /> Upload a new video</button></div></Dialog>}
    {dialog === 'guide' && <Dialog title="A little setup. Then, you’re live." subtitle="Your video → your server → YouTube. That’s it." onClose={() => setDialog(null)}><div className="dialog-body guide-body"><div className="guide-step"><span>1</span><div><h3>Get your YouTube stream key</h3><p>Open <a href="https://studio.youtube.com" target="_blank" rel="noreferrer">YouTube Studio <ExternalLink size={12} /></a> → Create → Go live → Stream. Set the title and visibility there, then copy your stream key. First-time live access can take up to 24 hours.</p></div></div><div className="guide-step"><span>2</span><div><h3>Upload a video or paste a YouTube link</h3><p>Choose Upload video to use a file, or YouTube link to use a public recorded video. Links use Direct stream by default: video and audio go straight to the encoder without saving the entire file. Choose Download first if you want a saved library copy instead.</p></div></div><div className="guide-step"><span>3</span><div><h3>Choose your settings & start</h3><p>Paste the key, choose output format and quality, and enable loop for continuous playback. Vertical 9:16 is the default; centre crop fills the frame, while Fit full video keeps the whole picture. Optionally set an end time. Click Start streaming, then check the preview in YouTube Studio and click Go live if auto-start is off.</p></div></div><div className="guide-step"><span>4</span><div><h3>Close the tab. Keep the server on.</h3><p>YouTube and this app can both be closed. FFmpeg on your server keeps sending video. A VPS keeps this working when your computer is off.</p></div></div><div className="guide-callout"><Server size={22} /><div><strong>{localHost ? 'You are currently running locally.' : 'Your server needs to stay running.'}</strong><p>{localHost ? 'For online hosting, follow the Docker + VPS steps in the project README. No app account or signup required.' : 'Automatic retries recover temporary connection failures. A server restart resumes from the beginning; an interruption may require reopening the broadcast in YouTube.'}</p></div></div><button className="button primary guide-done" onClick={() => setDialog(null)}>Got it, let’s stream <ArrowRight size={16} /></button></div></Dialog>}
    {toast && <div className={`toast ${toast.error ? 'toast-error' : ''}`} role={toast.error ? 'alert' : 'status'}>{toast.error ? <CircleHelp size={19} /> : <CheckCircle2 size={19} />}<span>{toast.message}</span><button className="icon-button" aria-label="Dismiss notification" onClick={() => setToast(null)}><X size={16} /></button></div>}
  </div>;
}
