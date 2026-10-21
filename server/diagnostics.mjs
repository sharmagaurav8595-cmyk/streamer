// Child-process errors can include the full command and expiring media URLs.
// Share only the diagnostic text, never a signed address or stream key.
export function safeDiagnostic(value, key = '') {
  let text = String(value || '').replace(/\u001b\[[0-9;]*m/g, '');
  if (key) text = text.split(key).join('[hidden]');
  return text.replace(/rtmps?:\/\/[^\s'"\]]+/gi, '[YouTube ingest]')
    .replace(/https?:\/\/[^\s'"\]]+/gi, '[media address]').trim().slice(-1600);
}

export class MediaSourceError extends Error {
  constructor(code, message, detail = '') {
    super(message);
    this.code = code;
    this.detail = safeDiagnostic(detail);
  }
}

export function previewFailure(error, { aborted = false, key = '' } = {}) {
  const detail = safeDiagnostic(error?.detail || error?.stderr || error?.message || error, key);
  const result = (code, message) => ({ code, message, detail });
  if (aborted || error?.name === 'AbortError' || (error?.killed && error?.signal === 'SIGTERM')) {
    return result('PREVIEW_TIMEOUT', 'The video frame took too long to load. Check this computer\'s connection and try again.');
  }
  if (error instanceof MediaSourceError) return result(error.code, safeDiagnostic(error.message, key));
  if (error?.code === 'ENOENT') return result('FFMPEG_MISSING', 'FFmpeg could not be started on this computer. Reinstall dependencies with npm install --include=optional, then restart the app.');
  if (error?.code === 'EACCES' || /permission denied|exec format error/i.test(detail)) return result('FFMPEG_EXECUTION', 'This computer cannot run the selected FFmpeg executable. Check FFMPEG_PATH and the executable permissions, then restart.');
  if (/\b(403|401)\b|forbidden|unauthorized/i.test(detail)) return result('MEDIA_ACCESS_DENIED', 'YouTube refused the video connection on this computer. Run npm run setup:youtube, restart, and try again. If it persists, use an uploaded video.');
  if (/\b429\b|too many requests/i.test(detail)) return result('MEDIA_RATE_LIMITED', 'YouTube is limiting requests from this connection. Wait before trying again, or use an uploaded video.');
  if (/protocol not found|https.*not.*(enabled|supported)|tls.*not.*(enabled|supported)/i.test(detail)) return result('FFMPEG_HTTPS', 'This FFmpeg build cannot open secure video connections. Use an FFmpeg build with HTTPS/TLS support and set FFMPEG_PATH in .env.');
  if (/gnutls|tls|ssl|certificate|handshake/i.test(detail)) return result('MEDIA_TLS', 'The secure video connection failed on this computer. Check its date/time and network; an older FFmpeg TLS build may need updating.');
  if (/unknown decoder|decoder .*not found|decoding.*not supported|codec .*not.*supported|decoder.*unavailable/i.test(detail)) return result('MEDIA_DECODER', 'This FFmpeg build cannot decode the selected video format. Use a build with H.264/VP9/AV1 decoding support, or upload an MP4 file.');
  if (/unrecognized option|option .*not found|unknown encoder|no such filter/i.test(detail)) return result('FFMPEG_FEATURE', 'This FFmpeg build is missing a required option, encoder, or filter. Select a compatible FFmpeg build with FFMPEG_PATH, then restart.');
  if (/timed? ?out|timeout|ETIMEDOUT/i.test(detail)) return result('PREVIEW_TIMEOUT', 'The video connection timed out on this computer. Check its connection and try again.');
  if (/network|connection|ENETUNREACH|EHOSTUNREACH|ENOTFOUND|EAI_AGAIN|resolve.*host|input\/output error/i.test(detail)) return result('MEDIA_NETWORK', 'This computer could not read the YouTube video over the network. Check its connection, VPN/proxy and DNS, then try again.');
  return result('PREVIEW_DECODE', 'FFmpeg could not read a video frame on this computer. Open Technical details below, or run npm run diagnose:youtube with this video link.');
}
