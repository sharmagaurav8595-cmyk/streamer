import { existsSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brandingLayout } from '../shared/branding.mjs';
import { outputFrame } from '../shared/output.mjs';
import { latinFont, fontForText } from './fonts.mjs';

const assets = fileURLToPath(new URL('../public/stream-overlays/', import.meta.url));
export const brandingImage = join(assets, 'red-frame.png');
export const brandingFont = latinFont;
const filterPath = value => value.replace(/\\/g, '/').replace(/['\\:]/g, character => `\\${character}`).replace(/[\\'\[\],;]/g, character => `\\${character}`);

export function prepareBranding(settings, directory) {
  const layout = brandingLayout(outputFrame(settings), settings);
  if (!layout.enabled) return null;
  if (!existsSync(brandingImage) || !existsSync(brandingFont)) throw new Error('Stream overlay assets are missing. Restore public/stream-overlays from the source package.');
  const destination = join(directory, 'branding');
  mkdirSync(destination, { recursive: true });
  const filters = layout.lines.map(line => {
    const font = fontForText(line.text);
    const path = join(destination, `${line.key}.txt`);
    writeFileSync(`${path}.tmp`, line.text, { encoding: 'utf8', mode: 0o600 });
    renameSync(`${path}.tmp`, path);
    return `drawtext=fontfile=${filterPath(font)}:textfile=${filterPath(path)}:expansion=none:fontsize=${line.fontSize}:fontcolor=white:x=(w-text_w)/2:y=${line.y}:shadowcolor=black@0.8:shadowx=2:shadowy=2`;
  });
  return { ...layout, image: brandingImage, filters };
}
