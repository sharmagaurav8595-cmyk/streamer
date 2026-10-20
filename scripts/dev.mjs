import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const children = [
  spawn(process.execPath, ['--env-file-if-exists=.env', 'server/index.mjs'], { stdio: 'inherit' }),
  spawn(process.execPath, [fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url))], { stdio: 'inherit' }),
];
let closing = false;
function stop(code = 0) {
  if (closing) return;
  closing = true;
  process.exitCode = code;
  for (const child of children) child.kill('SIGTERM');
  setTimeout(() => process.exit(code), 1500).unref();
}
for (const child of children) {
  child.on('exit', code => stop(code ?? 0));
  child.on('error', error => { console.error(error.message); stop(1); });
}
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
