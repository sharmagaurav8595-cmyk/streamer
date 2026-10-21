// Development helper: regenerate the committed PNG after editing its SVG source.
import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const browser = await chromium.launch({ ...(process.platform === 'win32' ? { channel: 'msedge' } : {}), headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 720, height: 1280 }, deviceScaleFactor: 1 });
  await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block}</style>${readFileSync(new URL('../public/stream-overlays/red-frame.svg', import.meta.url), 'utf8')}`);
  await page.screenshot({ path: fileURLToPath(new URL('../public/stream-overlays/red-frame.png', import.meta.url)), omitBackground: true });
} finally { await browser.close(); }
