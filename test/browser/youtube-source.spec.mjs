import { test, expect } from '@playwright/test';

test('direct streaming is the default, survives reload and creates no library file', async ({ page, request }) => {
  try {
    await request.put('/api/settings', { data: { source: 'upload', youtubeMode: 'direct' } });
    const before = await (await request.get('/api/state')).json();
    await page.goto('/');
    await page.getByRole('tab', { name: 'YouTube link' }).click();
    await expect(page.getByLabel('YouTube playback mode')).toHaveValue('direct');
    await page.getByLabel('YouTube video link').fill('https://youtu.be/jNQXAC9IVRw');
    await page.getByLabel('Stream key', { exact: true }).fill('test-direct-stream-key');
    await page.getByRole('button', { name: 'Start streaming' }).click();
    await expect(page.getByText('Opening your YouTube video…')).toBeVisible();
    await expect(page.getByLabel('YouTube playback mode')).toBeDisabled();
    await page.reload();
    await expect(page.locator('.status-badge')).toHaveText('Sending to YouTube', { timeout: 10000 });
    await expect(page.getByText('Streaming directly from YouTube', { exact: true })).toBeVisible();
    await expect(page.getByText('YouTube source fixture', { exact: true })).toBeVisible();
    const after = await (await request.get('/api/state')).json();
    expect(after.videos).toHaveLength(before.videos.length);
    expect(after.stream.source.direct).toBe(true);
    expect(JSON.stringify(after)).not.toMatch(/browser-private|googlevideo|test-direct-stream-key/);
    await page.getByRole('button', { name: 'Stop stream', exact: true }).click();
    await expect(page.locator('.status-badge')).toHaveText('Ready to stream');
  } finally {
    await request.post('/api/stream/stop');
    await request.put('/api/settings', { data: { source: 'upload', youtubeUrl: '', videoId: null, youtubeMode: 'direct' } });
  }
});

test('a YouTube link prepares on the server, survives reload, and automatically starts streaming', async ({ page, request }) => {
  const sourceUrl = 'https://www.youtube.com/watch?v=jNQXAC9IVRw';
  let importedId;
  try {
    await page.goto('/');
    await page.getByRole('tab', { name: 'YouTube link' }).click();
    await page.getByLabel('YouTube playback mode').selectOption('download');
    await page.getByLabel('YouTube video link').fill('https://example.com/video');
    await expect(page.getByText('Use a youtube.com or youtu.be video link.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Start streaming' })).toBeDisabled();
    await page.getByLabel('YouTube video link').fill('https://youtu.be/jNQXAC9IVRw');
    await page.getByLabel('Stream key', { exact: true }).fill('test-youtube-browser-key');
    await page.getByRole('button', { name: 'Start streaming' }).click();
    await expect(page.getByRole('progressbar', { name: 'YouTube video preparation' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Upload video' })).toBeDisabled();
    await page.reload();
    await expect(page.getByLabel('YouTube video link')).toHaveValue(sourceUrl);
    await expect(page.locator('.status-badge')).toHaveText('Sending to YouTube', { timeout: 10000 });
    await expect(page.getByRole('button', { name: 'Play YouTube video preview' })).toBeVisible();
    const state = await (await request.get('/api/state')).json();
    importedId = state.settings.videoId;
    expect(state.videos.find(video => video.id === importedId)?.sourceUrl).toBe(sourceUrl);
    expect(JSON.stringify(state)).not.toContain('test-youtube-browser-key');
    await page.getByRole('button', { name: 'Stop stream', exact: true }).click();
    await expect(page.locator('.status-badge')).toHaveText('Ready to stream');
    await page.getByRole('tab', { name: 'Upload video' }).click();
    await expect(page.getByRole('tab', { name: 'Upload video' })).toHaveAttribute('aria-selected', 'true');
  } finally {
    await request.post('/api/stream/stop');
    if (importedId) await request.delete(`/api/videos/${importedId}`);
    await request.put('/api/settings', { data: { source: 'upload', youtubeUrl: '', videoId: null, youtubeMode: 'direct' } });
  }
});

test('failed frame loads show the actual reason and expandable technical details', async ({ page }) => {
  await page.route('**/api/youtube/preview', route => route.fulfill({
    status: 400, contentType: 'application/json',
    body: JSON.stringify({ error: 'The secure video connection failed on this computer.', code: 'MEDIA_TLS', detail: 'gnutls_handshake() failed: TLS connection terminated' }),
  }));
  await page.goto('/');
  await page.getByRole('tab', { name: 'YouTube link' }).click();
  await page.getByLabel('YouTube video link').fill('https://youtu.be/jNQXAC9IVRw');
  await page.getByRole('button', { name: 'Load video frame', exact: true }).click();
  const error = page.locator('.preview-diagnostic');
  await expect(error).toContainText('The secure video connection failed on this computer.');
  await error.getByText('Technical details', { exact: false }).click();
  await expect(error.locator('pre')).toBeVisible();
  await expect(error.locator('pre')).toContainText('gnutls_handshake() failed');
  await expect(page.getByRole('button', { name: 'Load video frame', exact: true })).toBeEnabled();
});

test('YouTube preparation can be cancelled and unavailable videos show a readable error', async ({ page, request }) => {
  try {
    await page.goto('/');
    await page.getByRole('tab', { name: 'YouTube link' }).click();
    await page.getByLabel('YouTube video link').fill('https://youtu.be/jNQXAC9IVRw');
    await page.getByLabel('Stream key', { exact: true }).fill('test-youtube-cancel-key');
    await page.getByRole('button', { name: 'Start streaming' }).click();
    await page.getByRole('button', { name: 'Cancel preparation', exact: true }).click();
    await expect(page.locator('.status-badge')).toHaveText('Ready to stream');
    await page.getByLabel('YouTube video link').fill('https://www.youtube.com/watch?v=unavailable');
    await page.getByRole('button', { name: 'Start streaming' }).click();
    await expect(page.locator('.source-error')).toContainText('private, unavailable, or restricted', { timeout: 10000 });
    expect((await (await request.get('/api/state')).json()).stream.desiredRunning).toBe(false);
  } finally {
    await request.post('/api/stream/stop');
    await request.put('/api/settings', { data: { source: 'upload', youtubeUrl: '', videoId: null, youtubeMode: 'direct' } });
  }
});
