import { existsSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectReachablePackageDeclarations } from './package-declaration-graph.mjs';

const repositoryRoot = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
const requestedWorkspace = process.argv[2];
if (!requestedWorkspace || process.argv.length !== 3) {
  throw new Error('Usage: node scripts/prune-package-declarations.mjs <workspace>');
}

const workspace = realpathSync(resolve(repositoryRoot, requestedWorkspace));
const workspaceRelative = relative(repositoryRoot, workspace);
if (!workspaceRelative || workspaceRelative === '..' || workspaceRelative.startsWith(`..${sep}`)) {
  throw new Error(`Refusing package workspace outside the repository: ${workspace}`);
}

const distRoot = realpathSync(resolve(workspace, 'dist'));
const distRelative = relative(workspace, distRoot);
if (distRelative !== 'dist') throw new Error(`Refusing generated declaration root: ${distRoot}`);

const packageJson = JSON.parse(readFileSync(resolve(workspace, 'package.json'), 'utf8'));
const declarationPaths = listDeclarations(distRoot);
const declarations = Object.fromEntries(declarationPaths.map(path => [
  toPackagePath(workspace, path),
  readFileSync(path, 'utf8'),
]));
const reachable = collectReachablePackageDeclarations({ packageJson, declarations });
const removed = [];

for (const path of declarationPaths) {
  const packagePath = toPackagePath(workspace, path);
  if (reachable.has(packagePath)) continue;
  rmSync(path);
  const mapPath = `${path}.map`;
  if (existsSync(mapPath)) rmSync(mapPath);
  removed.push(packagePath);
}

console.log(`[package-declarations] ${packageJson.name}: retained=${reachable.size}, removed=${removed.length}.`);

function listDeclarations(root) {
  const result = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) result.push(...listDeclarations(path));
    else if (entry.isFile() && entry.name.endsWith('.d.ts')) result.push(path);
  }
  return result;
}

function toPackagePath(root, path) {
  return relative(root, path).split(sep).join('/');
}
