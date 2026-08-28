import { spawn } from 'node:child_process';
import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const output = resolve(root, 'animation-spec/dist-test');

export async function buildRiveConversionRuntime() {
  await rm(output, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  await run(process.execPath, [
    resolve(root, 'node_modules/typescript/bin/tsc'),
    '-p', resolve(root, 'animation-spec/tsconfig.json'),
    '--outDir', output,
    '--declaration', 'false',
    '--declarationMap', 'false',
    '--sourceMap', 'false',
  ]);
  await addJsExtensions(output);
  return resolve(output, 'rive/convert/index.js');
}

export async function buildRiveProductionCaptureFixture() {
  await run(process.execPath, [resolve(root, 'examples/scripts/build-examples.mjs')], {
    EXAMPLE_FILTER: 'rive-production-capture',
    EXAMPLE_SKIP_SOURCE_VIEWER: '1',
  });
  return resolve(root, 'examples/rive-production-capture/bundle.js');
}

async function addJsExtensions(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) await addJsExtensions(path);
    else if (entry.name.endsWith('.js')) {
      const source = await readFile(path, 'utf8');
      const patched = source.replace(/(from\s+|import\s*)(['"])(\.\.?\/[^'"]+)\2/gu, (match, prefix, quote, specifier) => {
        return /\.(?:js|json|mjs|cjs)$/u.test(specifier) ? match : `${prefix}${quote}${specifier}.js${quote}`;
      });
      if (patched !== source) await writeFile(path, patched);
    }
  }
}

function run(command, args, environment = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { cwd: root, env: { ...process.env, ...environment }, stdio: 'inherit', windowsHide: true, shell: false });
    child.once('error', rejectRun);
    child.once('exit', code => code === 0 ? resolveRun() : rejectRun(new Error(`Conversion runtime build exited with ${String(code)}.`)));
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(`[rive-conversion-runtime] ${await buildRiveConversionRuntime()}`);
}
