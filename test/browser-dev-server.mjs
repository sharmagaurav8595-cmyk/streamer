import { createServer } from 'vite';
import config from '../vite.config.mjs';

// Use the real dev proxy configuration, changing only its target and listen port.
// Keep shorthand rules as strings so this test catches their Host rewriting.
const proxy = Object.fromEntries(Object.entries(config.server.proxy).map(([path, rule]) => [
  path, typeof rule === 'string' ? 'http://127.0.0.1:3100' : { ...rule, target: 'http://127.0.0.1:3100' },
]));
const server = await createServer({
  ...config, configFile: false,
  cacheDir: 'node_modules/.vite-upload-tests',
  server: { ...config.server, port: 5174, proxy },
});
await server.listen();
server.printUrls();
