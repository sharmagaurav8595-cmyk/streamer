import { defineConfig } from 'vite';

// npm run dev passes the API's actual address after its listen callback.
const apiTarget = process.env.STREAMLOOP_API_TARGET || 'http://127.0.0.1:3000';

export default defineConfig({
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    watch: { ignored: ['**/.tools/**', '**/data/**', '**/test-results/**', '**/playwright-report/**'] },
    proxy: {
      // Preserve the browser's Host so the API can validate its Origin header.
      // Vite's string shorthand enables changeOrigin and breaks local POSTs.
      '/api': { target: apiTarget, changeOrigin: false },
      '/media': { target: apiTarget, changeOrigin: false },
    },
  },
});
