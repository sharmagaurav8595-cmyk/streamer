import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';

test('desktop studio uploads, previews, saves, reloads, selects, and deletes a real video', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 1080 });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Your stream, on repeat.' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start streaming' })).toBeDisabled();
  await expect(page.getByText('Server connected', { exact: true })).toBeVisible();
  await page.screenshot({ path: '.tools/studio-desktop.png', fullPage: true });
  await page.getByRole('button', { name: 'How it works', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByLabel('Upload video file').setInputFiles(resolve('.tools/browser-fixture.mp4'));
  await expect(page.getByText('Video uploaded. It is now stored on your server.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Play uploaded video preview' })).toBeVisible();
  await page.getByRole('button', { name: 'Play uploaded video preview' }).click();
  await expect(page.locator('video')).toBeVisible();
  await expect.poll(() => page.locator('video').evaluate(video => video.readyState)).toBeGreaterThanOrEqual(2);
  await page.getByLabel('Stream name').fill('My nightly live stream');
  await page.getByLabel('Stream key', { exact: true }).fill('browser-test-key-12345');
  await page.getByRole('switch', { name: 'Loop video' }).click();
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.getByText('Settings saved on your server.')).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('Stream name')).toHaveValue('My nightly live stream');
  await expect(page.getByRole('switch', { name: 'Loop video' })).toHaveAttribute('aria-checked', 'false');
  await expect(page.getByLabel('Stream key', { exact: true })).toHaveValue('');
  await expect(page.getByRole('button', { name: 'Start streaming' })).toBeEnabled();
  await page.screenshot({ path: '.tools/studio-with-video.png', fullPage: true });
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Video library' }).click();
  await expect(page.getByRole('heading', { name: 'Your video library.' })).toBeVisible();
  await page.getByRole('button', { name: 'Select browser-fixture.mp4' }).click();
  await expect(page.getByRole('heading', { name: 'Your stream, on repeat.' })).toBeVisible();
  await page.getByRole('button', { name: 'Change video' }).click();
  await expect(page.getByRole('dialog', { name: 'Choose your video' })).toBeVisible();
  await page.getByRole('button', { name: 'Select browser-fixture.mp4' }).click();
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Video library' }).click();
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Delete browser-fixture.mp4' }).click();
  await expect(page.getByText('Video deleted.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Select browser-fixture.mp4' })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('mobile layout fits the screen and keeps navigation and help usable', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Your stream, on repeat.' })).toBeVisible();
  await page.screenshot({ path: '.tools/studio-mobile-before-check.png', fullPage: true });
  const layout = await page.evaluate(() => ({
    fits: document.documentElement.scrollWidth <= innerWidth,
    overflow: [...document.querySelectorAll('body *')].filter(element => element.getBoundingClientRect().right > innerWidth + 1).map(element => ({ tag: element.tagName, class: element.className?.baseVal ?? element.className, right: element.getBoundingClientRect().right })),
  }));
  expect(layout.fits, JSON.stringify(layout.overflow)).toBe(true);
  await expect(page.getByRole('button', { name: 'Start streaming' })).toBeInViewport();
  await page.getByRole('button', { name: 'Quick start guide' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button', { name: 'Close dialog' }).click();
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Video library' }).click();
  await expect(page.getByRole('button', { name: 'Upload video', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Stream studio', exact: true }).click();
  await page.screenshot({ path: '.tools/studio-mobile.png', fullPage: true });
});
