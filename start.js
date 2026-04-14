import { fork, spawn } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Start backend (always on 3001, regardless of PORT env set by parent)
const server = fork(join(__dirname, 'server.js'), { stdio: 'inherit', env: { ...process.env, PORT: '3001' } });

// Start Vite frontend
const vite = spawn(process.execPath, [join(__dirname, 'node_modules/vite/bin/vite.js'), '--port', '3000'], {
  stdio: 'inherit',
  cwd: __dirname
});

process.on('SIGINT', () => {
  server.kill();
  vite.kill();
  process.exit();
});
