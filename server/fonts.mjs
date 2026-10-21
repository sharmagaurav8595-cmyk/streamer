import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const latinFont = fileURLToPath(new URL('../public/stream-overlays/NotoSans-Bold.ttf', import.meta.url));
export const devanagariFont = fileURLToPath(new URL('../public/stream-overlays/NotoSansDevanagari-Bold.ttf', import.meta.url));
const maps = new Map();

// Read Unicode cmap tables from the bundled fonts, rather than assuming that a
// script-specific font contains English too. Glyph zero is the missing-glyph box.
export function glyphIndex(path, codePoint) {
  if (!maps.has(path)) {
    const bytes = readFileSync(path);
    let cmap;
    for (let index = 0; index < bytes.readUInt16BE(4); index++) {
      const offset = 12 + index * 16;
      if (bytes.toString('ascii', offset, offset + 4) === 'cmap') cmap = bytes.readUInt32BE(offset + 8);
    }
    if (cmap === undefined) throw new Error('The overlay font has no Unicode character map.');
    const subtables = [];
    for (let index = 0; index < bytes.readUInt16BE(cmap + 2); index++) {
      const offset = cmap + 4 + index * 8;
      const platform = bytes.readUInt16BE(offset), encoding = bytes.readUInt16BE(offset + 2);
      if (platform !== 0 && !(platform === 3 && [1, 10].includes(encoding))) continue;
      const start = cmap + bytes.readUInt32BE(offset + 4), format = bytes.readUInt16BE(start);
      if ([4, 12].includes(format)) subtables.push({ start, format });
    }
    maps.set(path, { bytes, subtables: subtables.sort((a, b) => b.format - a.format) });
  }
  const { bytes, subtables } = maps.get(path);
  for (const { start, format } of subtables) {
    if (format === 12) {
      let low = 0, high = bytes.readUInt32BE(start + 12) - 1;
      while (low <= high) {
        const middle = (low + high) >>> 1, offset = start + 16 + middle * 12;
        const first = bytes.readUInt32BE(offset), last = bytes.readUInt32BE(offset + 4);
        if (codePoint < first) high = middle - 1;
        else if (codePoint > last) low = middle + 1;
        else return bytes.readUInt32BE(offset + 8) + codePoint - first;
      }
    } else if (codePoint <= 0xffff) {
      const count = bytes.readUInt16BE(start + 6) / 2;
      const ends = start + 14, starts = ends + count * 2 + 2, deltas = starts + count * 2, ranges = deltas + count * 2;
      for (let index = 0; index < count; index++) {
        if (codePoint > bytes.readUInt16BE(ends + index * 2)) continue;
        const first = bytes.readUInt16BE(starts + index * 2);
        if (codePoint < first) break;
        const delta = bytes.readInt16BE(deltas + index * 2), distance = bytes.readUInt16BE(ranges + index * 2);
        if (!distance) return (codePoint + delta) & 0xffff;
        const glyph = bytes.readUInt16BE(ranges + index * 2 + distance + (codePoint - first) * 2);
        return glyph ? (glyph + delta) & 0xffff : 0;
      }
    }
  }
  return 0;
}

export function fontForText(text) {
  const characters = Array.from(text).filter(character => !/[\u200c\u200d]/u.test(character));
  for (const path of [latinFont, devanagariFont]) {
    if (characters.every(character => glyphIndex(path, character.codePointAt(0)) !== 0)) return path;
  }
  throw Object.assign(new Error('This overlay text contains characters the stream fonts cannot display. Use supported letters and numbers instead of emoji or mixed scripts.'), { status: 400 });
}
