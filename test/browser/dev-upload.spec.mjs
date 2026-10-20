import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';

for (const file of ['browser-fixture.mp4', 'browser-large-fixture.mp4']) {
  test(`local dev proxy accepts a real drag-and-drop upload: ${file}`, async ({ page, request }) => {
    const base = 'http://localhost:5174';
    let uploadedId;
    try {
      await page.goto(base);
      const zone = page.getByRole('button', { name: /Drop a video/ });
      await expect(zone).toBeEnabled();
      // Use a disk-backed File, just like a video dragged from File Explorer.
      await page.evaluate(() => {
        const input = document.createElement('input');
        input.type = 'file'; input.id = 'drop-source'; input.hidden = true;
        document.body.append(input);
      });
      await page.locator('#drop-source').setInputFiles(resolve('.tools', file));
      const transfer = await page.evaluateHandle(() => {
        const data = new DataTransfer();
        data.items.add(document.querySelector('#drop-source').files[0]);
        return data;
      });
      await zone.dispatchEvent('dragover', { dataTransfer: transfer });
      const [response] = await Promise.all([
        page.waitForResponse(response => response.url().endsWith('/api/videos') && response.request().method() === 'POST'),
        zone.dispatchEvent('drop', { dataTransfer: transfer }),
      ]);
      const state = await response.json();
      uploadedId = state.uploadedVideoId;
      expect(response.status(), JSON.stringify(state.error)).toBe(201);
      expect(state.videos.find(video => video.id === uploadedId)?.name).toBe(file);
      await expect(page.getByText('Video uploaded. It is now stored on your server.')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Play uploaded video preview' })).toBeVisible();
      await page.reload();
      await expect(page.getByText(file, { exact: true })).toBeVisible();
      await expect(page.getByLabel('Stream key', { exact: true })).toHaveValue('');
    } finally {
      if (uploadedId) expect((await request.delete(`${base}/api/videos/${uploadedId}`)).ok()).toBe(true);
    }
  });
}
