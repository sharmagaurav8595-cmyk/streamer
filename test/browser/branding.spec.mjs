import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';

test('editable stream banners preview immediately, persist, and lock while streaming', async ({ page, request }) => {
  let videoId;
  try {
    await request.put('/api/settings', { data: { source: 'youtube', youtubeUrl: 'https://youtu.be/jNQXAC9IVRw', youtubeMode: 'direct', layout: 'vertical', frameFit: 'cover', quality: '720p', overlayEnabled: false } });
    await page.goto('/');
    const toggle = page.getByRole('switch', { name: 'Follow and subscribe overlay' });
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await toggle.click();
    await page.getByLabel('Overlay channel name').fill("Gaurav's Gaming");
    await page.getByLabel('Top banner text').fill('FOLLOW @GAURAV');
    await page.getByLabel('Bottom banner text').fill('SUBSCRIBE & JOIN');
    const preview = page.getByRole('group', { name: 'Stream overlay preview' });
    await expect(preview.locator('text').filter({ hasText: /^Gaurav's Gaming$/ })).toHaveCount(2);
    await expect(preview.locator('text').filter({ hasText: 'FOLLOW @GAURAV' })).toBeVisible();
    await page.getByLabel('Overlay channel name').fill('');
    await page.getByLabel('Stream key', { exact: true }).fill('test-branding-key-12345');
    await expect(page.getByRole('button', { name: 'Start streaming' })).toBeDisabled();
    await page.getByLabel('Overlay channel name').fill("Gaurav's Gaming");
    await page.getByRole('button', { name: 'Save settings' }).click();
    await expect(page.getByText('Settings saved on your server.')).toBeVisible();
    await page.reload();
    await expect(page.getByLabel('Overlay channel name')).toHaveValue("Gaurav's Gaming");
    await expect(page.getByLabel('Bottom banner text')).toHaveValue('SUBSCRIBE & JOIN');
    await page.getByRole('button', { name: 'Start streaming' }).click();
    await expect(page.locator('.status-badge')).toHaveText('Sending to YouTube', { timeout: 10000 });
    await expect(toggle).toBeDisabled();
    await expect(page.getByLabel('Overlay channel name')).toBeDisabled();
    await page.getByRole('button', { name: 'Stop stream', exact: true }).click();
    await expect(toggle).toBeEnabled();
    await page.getByRole('tab', { name: 'Upload video' }).click();
    await page.getByLabel('Upload video file').setInputFiles(resolve('.tools/browser-fixture.mp4'));
    await expect(page.getByRole('button', { name: 'Play uploaded video preview' })).toBeVisible();
    const state = await (await request.get('/api/state')).json();
    videoId = state.videos.find(video => video.name === 'browser-fixture.mp4').id;
    const uploadedPreview = page.getByRole('group', { name: 'Stream layout preview' });
    await expect(uploadedPreview.locator('.branding-layer')).toBeVisible();
    const videoArea = await uploadedPreview.locator('img').boundingBox();
    const frame = await uploadedPreview.boundingBox();
    expect(videoArea.y).toBeGreaterThan(frame.y);
    expect(videoArea.height).toBeLessThan(frame.height * 0.75);
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: '.tools/branding-preview.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await toggle.click();
    await expect(uploadedPreview.locator('.branding-layer')).toHaveCount(0);
  } finally {
    await request.post('/api/stream/stop');
    if (videoId) await request.delete(`/api/videos/${videoId}`);
    await request.put('/api/settings', { data: { source: 'upload', youtubeUrl: '', videoId: null, overlayEnabled: false, overlayName: 'Your channel', followText: 'FOLLOW ME', subscribeText: 'SUBSCRIBE NOW' } });
  }
});
