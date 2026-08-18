import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const [mode, argument] = process.argv.slice(2);
const marker = 'created fixture/bundle.js in 1ms\n';

switch (mode) {
  case 'normal':
    process.stdout.write(marker);
    break;
  case 'wrong-output':
    process.stdout.write('created fixture/bundle.js.map in 1ms\n');
    break;
  case 'split-marker':
    process.stdout.write('crea');
    setTimeout(() => {
      process.stdout.write('ted fixture/bundle.js in 1ms\n');
    }, 15);
    break;
  case 'interval':
    process.stdout.write(marker);
    setInterval(() => {}, 1_000);
    break;
  case 'no-marker':
    setInterval(() => {}, 1_000);
    break;
  case 'fail':
    process.stderr.write('synthetic rollup error\n');
    process.exitCode = 7;
    break;
  case 'marker-then-fail':
    process.stdout.write(marker);
    process.stderr.write('synthetic late rollup error\n');
    process.exitCode = 9;
    break;
  case 'stubborn-tree': {
    if (!argument) throw new Error('stubborn-tree requires a pid file.');
    const grandchild = spawn(process.execPath, [new URL(import.meta.url).pathname, 'stubborn-child'], {
      stdio: 'ignore',
    });
    writeFileSync(argument, String(grandchild.pid));
    process.on('SIGTERM', () => {});
    process.stdout.write(marker);
    setInterval(() => {}, 1_000);
    break;
  }
  case 'stubborn-child':
    process.on('SIGTERM', () => {});
    setInterval(() => {}, 1_000);
    break;
  default:
    throw new Error(`Unknown fixture mode ${mode}.`);
}
