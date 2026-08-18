import { readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { isAbsolute, relative, resolve as resolvePath, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import nodeResolve from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import typescript from '@rollup/plugin-typescript';
import { wgslRaw } from '../scripts/rollup-plugin-wgsl.js';

/** Shared Rollup policy for every Haiyue TypeScript/WebGPU bundle. */
export function haiyuePlugins({
  tsconfig = './tsconfig.json',
  declaration,
  localPackages = {},
  commonjsInterop = true,
  extra = [],
} = {}) {
  return [
    wgslRaw(),
    workerModuleUrlPolicy(),
    resolveLocalWorkspace(localPackages),
    nodeResolve({ browser: true, preferBuiltins: false }),
    commonjsInterop ? commonjs() : null,
    typescript({ tsconfig, ...(declaration === undefined ? {} : { declaration }) }),
    ...extra,
  ].filter(Boolean);
}

/** Documents the single worker contract: module workers use new URL(path, import.meta.url). */
export function workerModuleUrlPolicy() {
  return {
    name: 'haiyue-worker-module-url-policy',
    transform(code, id) {
      if (!/\.[cm]?[jt]sx?$/.test(id) || !/new\s+Worker\s*\(/.test(code)) return null;
      if (/new\s+Worker\s*\(\s*['"`]/.test(code)) {
        this.error('Worker entry must use new URL(path, import.meta.url) or an injected Worker instance.');
      }
      return null;
    },
  };
}

/** Exact package/subpath matching prevents accidental source aliasing. */
export function resolveLocalWorkspace(packages = {}) {
  return {
    name: 'haiyue-local-workspace-resolution',
    resolveId(source) { return packages[source] ?? null; },
  };
}

/** Source aliases for every published engine entrypoint used by workspace bundles. */
export function engineSourcePackages() {
  const entries = [
    'assets', 'color', 'components', 'compute', 'controls', 'core', 'diagnostics', 'ecs',
    'experimental', 'font', 'geometry', 'gui', 'input', 'lighting', 'material',
    'math', 'navigation', 'physics', 'physics/backend', 'physics/components', 'postprocess', 'rtt', 'scene',
    'serialization', 'systems', 'tween',
  ];
  return {
    '@haiyue/engine': fileURLToPath(new URL('../engine/src/index.ts', import.meta.url)),
    ...Object.fromEntries(entries.map(entry => [
      `@haiyue/engine/${entry}`,
      fileURLToPath(new URL(`../engine/src/${entry === 'physics/components' ? 'physics-components' : entry}.ts`, import.meta.url)),
    ])),
  };
}

export function libraryOutput(directory = 'dist') {
  return {
    dir: directory,
    entryFileNames: '[name].js',
    chunkFileNames: 'chunks/[name]-[hash].js',
    format: 'es',
    sourcemap: true,
  };
}

/** Removes a package-local output directory once before Rollup starts emitting files. */
export function cleanOutputDirectory(directory = 'dist') {
  let cleaned = false;
  return {
    name: 'haiyue-clean-output-directory',
    async buildStart() {
      if (cleaned) return;
      // Workspace watch processes run concurrently and consume each other's
      // published dist entries. Removing the whole directory at watch startup
      // creates an avoidable ENOENT window for downstream rebuilds. The watch
      // orchestrator performs one clean production build before starting.
      if (this.meta.watchMode) {
        cleaned = true;
        return;
      }

      const cwd = process.cwd();
      const target = resolvePath(cwd, directory);
      const relativeTarget = relative(cwd, target);
      const escapesPackage = relativeTarget === '..'
        || relativeTarget.startsWith(`..${sep}`)
        || isAbsolute(relativeTarget);
      if (!relativeTarget || escapesPackage) {
        this.error(`Refusing to clean output directory outside the package: ${target}`);
      }

      await rm(target, { recursive: true, force: true });
      cleaned = true;
    },
  };
}

export function haiyueExternal({ packages = [], includeMatrix = true } = {}) {
  return id => (includeMatrix && id === 'wgpu-matrix')
    || packages.some(name => id === name || id.startsWith(`${name}/`));
}

export function loadContentManifest(kind, cwd = process.cwd()) {
  const path = resolvePath(cwd, 'manifest.json');
  const manifest = JSON.parse(readFileSync(path, 'utf8'));
  if (manifest.schemaVersion !== 1 || manifest.kind !== kind || !Array.isArray(manifest.entries)) {
    throw new Error(`Invalid ${kind} manifest at ${path}.`);
  }
  const ids = new Set();
  for (const entry of manifest.entries) {
    if (!entry.id || ids.has(entry.id)) throw new Error(`Duplicate or empty ${kind} manifest id: ${entry.id}.`);
    ids.add(entry.id);
    if (!entry.entry || !Array.isArray(entry.capabilities) || !entry.ci) {
      throw new Error(`Incomplete ${kind} manifest entry: ${entry.id}.`);
    }
  }
  return Object.freeze(manifest);
}

export function selectContentEntries(manifest, filter) {
  const selected = filter ? manifest.entries.filter(entry => entry.id === filter) : manifest.entries;
  if (filter && selected.length === 0) throw new Error(`Unknown ${manifest.kind} manifest target "${filter}".`);
  return selected;
}

export function toGlobalName(name, prefix = '') {
  const value = name.replace(/(^|[-_])(\w)/g, (_match, _separator, character) => character.toUpperCase());
  const safe = value.replace(/^\d/, '_$&');
  return `${prefix}${safe}`;
}
