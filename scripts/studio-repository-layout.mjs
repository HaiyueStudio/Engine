import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const engineRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const studioRoot = resolve(engineRoot, '..');

export const STUDIO_REPOSITORIES = Object.freeze({
  Engine: Object.freeze({ root: engineRoot, packageName: '@haiyue/engine-repository' }),
  Editor: Object.freeze({ root: resolve(studioRoot, 'Editor'), packageName: '@haiyue/editor-repository' }),
  Games: Object.freeze({ root: resolve(studioRoot, 'Games'), packageName: '@haiyue/games-repository' }),
  UI: Object.freeze({ root: resolve(studioRoot, 'UI'), packageName: '@haiyue/ui' }),
  milestones: Object.freeze({ root: resolve(studioRoot, 'milestones'), packageName: null }),
});

export function requireStudioRepository(name) {
  const repository = STUDIO_REPOSITORIES[name];
  if (!repository) throw new Error(`Unknown HaiYueStudio repository "${String(name)}".`);
  if (!existsSync(repository.root)) throw new Error(`${name} repository is unavailable at ${repository.root}.`);
  if (repository.packageName) {
    const manifestPath = resolve(repository.root, 'package.json');
    if (!existsSync(manifestPath)) throw new Error(`${name} repository is missing package.json.`);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (manifest.name !== repository.packageName) {
      throw new Error(`${name} repository identity mismatch: expected ${repository.packageName}, received ${String(manifest.name)}.`);
    }
  }
  return repository;
}

export function resolveStudioRepositoryPath(name, ...segments) {
  const repositoryRoot = requireStudioRepository(name).root;
  const candidate = resolve(repositoryRoot, ...segments);
  if (candidate !== repositoryRoot && !candidate.startsWith(`${repositoryRoot}${sep}`)) {
    throw new Error(`${name} repository path escapes its root: ${candidate}.`);
  }
  return candidate;
}
