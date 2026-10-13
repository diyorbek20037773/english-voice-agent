// Runs the gateway (tsx watch, port 3000) and the Vite dev server (port 5173) together,
// using whichever package manager launched this script.
import { spawn } from 'node:child_process';

const pm = process.env.npm_execpath;
const run = (script) =>
  pm && pm.endsWith('.cjs')
    ? spawn(process.execPath, [pm, 'run', script], { stdio: 'inherit' })
    : spawn('pnpm', ['run', script], { stdio: 'inherit', shell: process.platform === 'win32' });

const procs = [run('dev:server'), run('dev:web')];
const stop = () => procs.forEach((p) => p.kill());
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
procs.forEach((p) =>
  p.on('exit', (code) => {
    if (code) {
      stop();
      process.exit(code);
    }
  }),
);
