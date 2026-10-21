import { test, expect } from '@playwright/test';

test('a YouTube frame can be cropped under fixed banners and framing survives reload', async ({ page, request }) => {
  try {
    await request.put('/api/settings', { data: { source: 'youtube', youtubeUrl: 'https://youtu.be/jNQXAC9IVRw', youtubeMode: 'direct', layout: 'vertical', frameFit: 'cover', quality: '720p', overlayEnabled: true,
      overlayName: 'NOT THE BOSS', followText: 'FOLLOW ME', subscribeText: 'SUBSCRIBE NOW', videoZoom: 1, videoPositionX: 50, videoPositionY: 50, sourceTrimTop: 0, sourceTrimBottom: 0 } });
    const original = await (await request.get('/api/state')).json();
    await page.goto('/');
    await page.getByRole('button', { name: 'Load video frame', exact: true }).click();
    const preview = page.getByRole('group', { name: 'Stream layout preview' });
    await expect(preview.locator('img')).toBeVisible();
    await expect.poll(() => preview.locator('img').evaluate(image => image.naturalWidth)).toBeGreaterThan(0);
    const bannerPosition = () => preview.locator('.branding-layer').evaluate(element => {
      const bounds = element.getBoundingClientRect(), parent = element.parentElement.getBoundingClientRect();
      return { width: bounds.width, height: bounds.height, x: bounds.x - parent.x, y: bounds.y - parent.y };
    });
    const bannerBefore = await bannerPosition();
    await page.getByRole('slider', { name: 'Video zoom', exact: true }).press('End');
    await page.getByRole('slider', { name: 'Horizontal video position', exact: true }).press('Home');
    await page.getByRole('slider', { name: 'Vertical video position', exact: true }).press('End');
    await expect(preview.locator('img')).toHaveCSS('transform', 'matrix(3, 0, 0, 3, 0, 0)');
    await expect(preview.locator('img')).toHaveCSS('object-position', '0% 100%');
    await expect(preview.locator('.video-window')).toHaveCSS('overflow', 'hidden');
    expect(await bannerPosition()).toEqual(bannerBefore);
    await page.getByText('Remove borders in original video', { exact: true }).click();
    await page.getByRole('slider', { name: 'Source crop from top', exact: true }).press('End');
    await page.getByRole('slider', { name: 'Source crop from bottom', exact: true }).press('End');
    await expect(preview.locator('.source-crop-frame')).toBeVisible();
    await expect(preview.locator('img')).toHaveCSS('object-fit', 'fill');
    expect(await bannerPosition()).toEqual(bannerBefore);
    await page.getByLabel('Stream key', { exact: true }).fill('test-crop-key-12345');
    await page.getByRole('button', { name: 'Save settings' }).click();
    await expect(page.getByText('Settings saved on your server.')).toBeVisible();
    await page.reload();
    await expect(page.getByRole('slider', { name: 'Video zoom', exact: true })).toHaveValue('3');
    await expect(page.getByRole('slider', { name: 'Horizontal video position', exact: true })).toHaveValue('0');
    await expect(page.getByRole('slider', { name: 'Vertical video position', exact: true })).toHaveValue('100');
    await page.getByText('Remove borders in original video', { exact: true }).click();
    await expect(page.getByRole('slider', { name: 'Source crop from top', exact: true })).toHaveValue('45');
    await expect(page.getByRole('slider', { name: 'Source crop from bottom', exact: true })).toHaveValue('35');
    await page.getByRole('button', { name: 'Load video frame', exact: true }).click();
    await expect(preview.locator('img')).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    await preview.screenshot({ path: '.tools/crop-adjustment-preview.png' });
    await page.getByRole('button', { name: 'Reset framing', exact: true }).click();
    await expect(page.getByRole('slider', { name: 'Video zoom', exact: true })).toHaveValue('1');
    await expect(page.getByRole('slider', { name: 'Horizontal video position', exact: true })).toHaveValue('50');
    await expect(page.getByRole('slider', { name: 'Vertical video position', exact: true })).toHaveValue('50');
    await expect(page.getByRole('slider', { name: 'Source crop from top', exact: true })).toHaveValue('0');
    await expect(preview.locator('.source-crop-frame')).toHaveCount(0);
    await page.getByRole('button', { name: 'Start streaming', exact: true }).click();
    await expect(page.locator('.status-badge')).toHaveText('Sending to YouTube', { timeout: 10000 });
    await expect(page.getByRole('slider', { name: 'Video zoom', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Reset framing', exact: true })).toBeDisabled();
    const state = await (await request.get('/api/state')).json();
    expect(state.videos).toHaveLength(original.videos.length);
  } finally {
    await request.post('/api/stream/stop');
    await request.put('/api/settings', { data: { source: 'upload', youtubeUrl: '', videoId: null, overlayEnabled: false, overlayName: 'Your channel', videoZoom: 1, videoPositionX: 50, videoPositionY: 50, sourceTrimTop: 0, sourceTrimBottom: 0 } });
  }
});
