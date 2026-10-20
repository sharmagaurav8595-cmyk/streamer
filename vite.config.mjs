import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      // Preserve the browser's Host so the API can validate its Origin header.
      // Vite's string shorthand enables changeOrigin and breaks local POSTs.
      '/api': { target: 'http://127.0.0.1:3000', changeOrigin: false },
      '/media': { target: 'http://127.0.0.1:3000', changeOrigin: false },
    },
  },
});
