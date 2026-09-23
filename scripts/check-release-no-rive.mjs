import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateNoRiveRelease } from './release-no-rive-policy.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const artifacts = process.argv.includes('--artifacts');
for (const arg of process.argv.slice(2)) {
  if (arg !== '--artifacts') throw new Error(`Unknown argument: ${arg}`);
}
const workspaces = ['engine', 'animation-spec', 'extensions', 'shader-language'];
const sourceRoots = [...workspaces.map(name => `${name}/src`), 'animation-spec/corpus', 'examples', 'tools'];
if (artifacts) {
  for (const name of workspaces) {
    if (!existsSync(resolve(root, name, 'dist/index.js'))) {
      // release:scope:check builds the three playback packages. The compiler is
      // build tooling; inspect its output when present, and always inspect its source.
      if (name === 'shader-language') continue;
      throw new Error(`Build ${name} before checking artifacts.`);
    }
    sourceRoots.push(`${name}/dist`);
  }
}
const scopeCheckFiles = new Set(['check-release-no-rive.mjs', 'release-no-rive-policy.mjs', 'release-no-rive-policy.test.mjs']);
const files = [
  ...sourceRoots.flatMap(walk),
  ...walk('docs/for-ai/rive-hya').filter(file => /\.(?:mjs|js|ts)$/.test(file)),
  ...walk('scripts').filter(file => !scopeCheckFiles.has(file.split('/').at(-1))),
];
const runtimeSources = Object.fromEntries(files
  .filter(file => !file.startsWith('scripts/') && /\.(?:ts|js|mjs|wgsl)$/.test(file))
  .map(file => [file, readFileSync(resolve(root, file), 'utf8')]));
const packages = Object.fromEntries(['package.json', ...[...workspaces, 'examples'].map(name => `${name}/package.json`)]
  .map(file => [file, json(file)]));
const errors = validateNoRiveRelease({ files, packages, lock: json('package-lock.json'), examples: json('examples/manifest.json'), runtimeSources });
if (errors.length) {
  console.error(`[release:no-rive] Failed (${artifacts ? 'source + built artifacts' : 'source'}):\n${errors.map(error => `- ${error}`).join('\n')}`);
  process.exitCode = 1;
} else {
  console.log(`[release:no-rive] Passed: ${files.length} files, package metadata, lockfile and example catalog${artifacts ? ', including built artifacts' : ''}.`);
}

function json(file) { return JSON.parse(readFileSync(resolve(root, file), 'utf8')); }
function walk(directory) {
  if (!existsSync(resolve(root, directory))) return [];
  return readdirSync(resolve(root, directory), { withFileTypes: true }).flatMap(entry => {
    if (['node_modules', 'dist-test', '.git'].includes(entry.name)) return [];
    if (!artifacts && /^(?:bundle\.|shared-engine\.)/.test(entry.name)) return [];
    const path = `${directory}/${entry.name}`;
    return entry.isDirectory() ? walk(path) : entry.isFile() ? [path] : [];
  });
}
