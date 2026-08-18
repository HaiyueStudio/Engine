import { spawn, spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const examplesDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(examplesDir, '..');
const rollup = resolve(root, 'node_modules/rollup/dist/bin/rollup');
const filter = process.env.EXAMPLE_FILTER;
const childProcesses = new Set();

for (const workspace of ['./engine', './animation-spec', './extensions']) {
  runInitial('npm', ['run', 'build', '-w', workspace], root);
}

watch('engine', ['-c', 'rollup.config.js', '--watch'], resolve(root, 'engine'));
watch('animation-spec', ['-c', 'rollup.config.js', '--watch'], resolve(root, 'animation-spec'));
watch('extensions', ['-c', 'rollup.config.js', '--watch'], resolve(root, 'extensions'));
watch('extensions-worker', ['-c', 'rollup.worker.config.js', '--watch'], resolve(root, 'extensions'));
watch('examples', ['-c', 'rollup.config.js', '--watch'], examplesDir, {
  ...(filter ? { EXAMPLE_FILTER: filter } : {}),
});

console.log(
  `[examples:watch] watching workspace sources${filter ? ` for "${filter}"` : ' for all examples'}; press Ctrl+C to stop.`,
);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    for (const child of childProcesses) child.kill('SIGTERM');
  });
}

function runInitial(command, args, cwd, environment = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env: { ...process.env, ...environment },
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function watch(label, args, cwd, environment = {}) {
  const child = spawn(process.execPath, [rollup, ...args], {
    cwd,
    env: { ...process.env, ...environment },
    stdio: 'inherit',
  });
  childProcesses.add(child);
  child.on('exit', code => {
    childProcesses.delete(child);
    if (code === 0 || code === null) return;
    console.error(`[examples:watch] ${label} watcher exited with code ${code}.`);
    for (const peer of childProcesses) peer.kill('SIGTERM');
    process.exitCode = code;
  });
  child.on('error', error => {
    console.error(`[examples:watch] ${label} watcher failed:`, error);
    for (const peer of childProcesses) peer.kill('SIGTERM');
    process.exitCode = 1;
  });
}
