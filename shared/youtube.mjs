export function normalizeYouTubeUrl(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 2048) throw new Error('Paste a YouTube video link.');
  let text = value.trim();
  if (/^(?:www\.|m\.|music\.)?(?:youtube\.com|youtu\.be)\//i.test(text)) text = `https://${text}`;
  let url;
  try { url = new URL(text); } catch { throw new Error('Enter a valid YouTube video link.'); }
  const hosts = ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be', 'www.youtu.be'];
  if (!['https:', 'http:'].includes(url.protocol) || !hosts.includes(url.hostname.toLowerCase()) || url.username || url.password || url.port) {
    throw new Error('Use a youtube.com or youtu.be video link.');
  }
  let id;
  if (url.hostname.endsWith('youtu.be')) id = /^\/([\w-]{11})\/?$/.exec(url.pathname)?.[1];
  else if (url.pathname === '/watch') id = url.searchParams.get('v');
  else id = /^\/(?:shorts|embed|live)\/([\w-]{11})\/?$/.exec(url.pathname)?.[1];
  if (!id || !/^[\w-]{11}$/.test(id)) throw new Error('Use a link to one YouTube video, rather than a channel or playlist.');
  return `https://www.youtube.com/watch?v=${id}`;
}
