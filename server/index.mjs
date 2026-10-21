import { createApplication } from './app.mjs';

// Do not resume a saved encoder until this process owns its listening port.
const { app, controller } = await createApplication({ recover: false });
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '127.0.0.1';
const server = app.listen(port, host);
server.once('listening', () => {
  const address = server.address();
  const connectHost = address.address === '0.0.0.0' ? '127.0.0.1' : address.address === '::' ? '::1' : address.address;
  const origin = `http://${connectHost.includes(':') ? `[${connectHost}]` : connectHost}:${address.port}`;
  console.log(`StreamLoop server: ${origin}`);
  console.log(controller.encoderAvailable ? 'FFmpeg is ready.' : 'FFmpeg is missing. Install FFmpeg or use the Docker setup.');
  controller.recover();
  if (process.connected) process.send({ type: 'streamloop:ready', origin });
});
server.on('error', async error => {
  console.error(error.code === 'EADDRINUSE'
    ? `Backend could not start: port ${port} is already in use. Stop the other app, or set a different PORT in .env.`
    : `Backend could not start (${error.code || 'error'}): ${error.message}`);
  await controller.shutdown();
  process.exit(1);
});
server.requestTimeout = 0;
server.headersTimeout = 60000;
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  console.log('Shutting down. An active stream will resume when this server restarts.');
  server.close();
  const forceExit = setTimeout(() => process.exit(1), 8000);
  await controller.shutdown();
  server.closeAllConnections();
  clearTimeout(forceExit);
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
if (process.connected) {
  process.on('message', message => { if (message?.type === 'streamloop:shutdown') void shutdown(); });
  process.on('disconnect', shutdown);
}
