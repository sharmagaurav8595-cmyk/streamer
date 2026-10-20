import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './test/browser',
  fullyParallel: false,
  workers: 1,
  timeout: 45000,
  use: {
    baseURL: 'http://127.0.0.1:3100',
    headless: true,
    ...(process.platform === 'win32' ? { channel: 'msedge' } : {}),
  },
  webServer: [{
    command: 'node test/browser-server.mjs',
    url: 'http://127.0.0.1:3100/api/health',
    reuseExistingServer: false,
    timeout: 30000,
  }, {
    command: 'node test/browser-dev-server.mjs',
    url: 'http://localhost:5174',
    reuseExistingServer: false,
    timeout: 30000,
  }],
});
