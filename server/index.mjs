import { createApplication } from './app.mjs';

const { app, controller } = await createApplication();
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '127.0.0.1';
const server = app.listen(port, host, () => {
  console.log(`StreamLoop server: http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`);
  console.log(controller.encoderAvailable ? 'FFmpeg is ready.' : 'FFmpeg is missing. Install FFmpeg or use the Docker setup.');
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
