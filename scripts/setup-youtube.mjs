import { mkdirSync, writeFileSync, chmodSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const assets = {
  'win32-x64': 'yt-dlp.exe', 'win32-arm64': 'yt-dlp_arm64.exe',
  'linux-x64': 'yt-dlp_linux', 'linux-arm64': 'yt-dlp_linux_aarch64',
  'darwin-x64': 'yt-dlp_macos', 'darwin-arm64': 'yt-dlp_macos',
};
const assetName = assets[`${process.platform}-${process.arch}`];
if (!assetName) throw new Error('Install yt-dlp with your platform package manager and set YT_DLP_PATH to its executable.');
const root = fileURLToPath(new URL('../', import.meta.url));
const destination = join(root, '.tools', 'youtube', process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
async function get(url) {
  const response = await fetch(url, { headers: { 'User-Agent': 'StreamLoop-setup' }, signal: AbortSignal.timeout(180000) });
  if (!response.ok) throw new Error(`Download failed (HTTP ${response.status}). Please run npm run setup:youtube again.`);
  return response;
}
const release = await (await get('https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest')).json();
const asset = release.assets.find(item => item.name === assetName);
const checksums = release.assets.find(item => item.name === 'SHA2-256SUMS');
if (!asset || !checksums) throw new Error('The official yt-dlp release is missing this platform or its checksums.');
console.log(`Installing official yt-dlp ${release.tag_name} (${assetName})…`);
const sums = await (await get(checksums.browser_download_url)).text();
const expected = sums.split(/\r?\n/).map(line => line.trim().split(/\s+/)).find(parts => parts[1]?.replace(/^\*/, '') === assetName)?.[0];
if (!/^[a-f0-9]{64}$/i.test(expected || '')) throw new Error('Could not verify the release checksum.');
const data = Buffer.from(await (await get(asset.browser_download_url)).arrayBuffer());
if (createHash('sha256').update(data).digest('hex') !== expected.toLowerCase()) throw new Error('yt-dlp checksum mismatch. The download was not installed.');
mkdirSync(dirname(destination), { recursive: true });
const temporary = `${destination}.download`;
try {
  writeFileSync(temporary, data, { mode: 0o755 });
  chmodSync(temporary, 0o755);
  renameSync(temporary, destination);
} finally { rmSync(temporary, { force: true }); }
console.log('YouTube link support installed. Restart the app if it is already running.');
