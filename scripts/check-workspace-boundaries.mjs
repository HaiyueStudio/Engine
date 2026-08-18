import { readFileSync, readdirSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const configPath = resolve(root, 'config/architecture-boundaries.json');
const config = JSON.parse(readFileSync(configPath, 'utf8'));
const workspaceEntries = Object.entries(config.workspaces);
const workspaceByPackageName = new Map();
const workspaceRoots = new Map();
const observedDependencies = new Map();
const violations = [];

for (const [workspace, definition] of workspaceEntries) {
  workspaceRoots.set(workspace, resolve(root, definition.root));
  observedDependencies.set(workspace, new Set());
  for (const packageName of definition.packageNames) {
    workspaceByPackageName.set(packageName, workspace);
  }
}

validateDeclaredDependencies();

for (const [workspace, definition] of workspaceEntries) {
  for (const sourceRoot of definition.sources) {
    scanDirectory(workspace, resolve(root, sourceRoot));
  }
}

for (const [workspace] of workspaceEntries) {
  const dependencies = [...observedDependencies.get(workspace)].sort();
  console.log(`[workspace-boundary] ${workspace} -> ${dependencies.join(', ') || '(none)'}`);
}

if (violations.length > 0) {
  console.error('\n[workspace-boundary] Architecture boundary violations:');
  for (const violation of violations) console.error(`- ${violation}`);
  process.exit(1);
}

console.log('[workspace-boundary] All workspace dependency rules passed.');

function validateDeclaredDependencies() {
  for (const [workspace, definition] of workspaceEntries) {
    const manifestPath = resolve(root, definition.root, 'package.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const declared = {
      ...manifest.dependencies,
      ...manifest.devDependencies,
      ...manifest.peerDependencies,
      ...manifest.optionalDependencies,
    };
    for (const packageName of Object.keys(declared)) {
      const target = matchPackageWorkspace(packageName);
      if (!target || target === workspace) continue;
      observedDependencies.get(workspace).add(target);
      if (!definition.allowedWorkspaceDependencies.includes(target)) {
        violations.push(`${relative(root, manifestPath)} declares forbidden workspace dependency ${packageName} (${workspace} -> ${target}).`);
      }
    }
  }
}

function scanDirectory(workspace, directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'dist-test') continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      scanDirectory(workspace, path);
      continue;
    }
    if (!entry.isFile() || !/\.(?:ts|tsx|mts|cts)$/.test(entry.name)) continue;
    scanSourceFile(workspace, path);
  }
}

function scanSourceFile(workspace, file) {
  const sourceText = readFileSync(file, 'utf8');
  const sourceFile = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true, scriptKind(file));
  const specifiers = [];

  visit(sourceFile);
  for (const specifier of specifiers) validateSpecifier(workspace, file, specifier);

  function visit(node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const [argument] = node.arguments;
      if (argument && ts.isStringLiteralLike(argument)) specifiers.push(argument.text);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteralLike(node.argument.literal)) {
      specifiers.push(node.argument.literal.text);
    }
    ts.forEachChild(node, visit);
  }
}

function validateSpecifier(workspace, file, specifier) {
  const target = resolveTargetWorkspace(file, specifier);
  if (!target || target === workspace) return;

  observedDependencies.get(workspace).add(target);
  const definition = config.workspaces[workspace];
  const location = `${relative(root, file)} imports "${specifier}"`;

  if (!definition.allowedWorkspaceDependencies.includes(target)) {
    violations.push(`${location}: forbidden dependency ${workspace} -> ${target}.`);
    return;
  }

  if (specifier.startsWith('.')) {
    violations.push(`${location}: cross-workspace relative imports are forbidden; use the target package export.`);
    return;
  }

  if (specifier.includes('/src/') || specifier.endsWith('/src')) {
    violations.push(`${location}: package source internals are not public API.`);
  }

  const sourceManifest = JSON.parse(readFileSync(resolve(workspaceRoots.get(workspace), 'package.json'), 'utf8'));
  const declared = {
    ...sourceManifest.dependencies,
    ...sourceManifest.devDependencies,
    ...sourceManifest.peerDependencies,
    ...sourceManifest.optionalDependencies,
  };
  const importedPackageName = findImportedPackageName(specifier);
  if (importedPackageName && !(importedPackageName in declared)) {
    violations.push(`${location}: ${importedPackageName} is not declared in ${workspace}/package.json.`);
  }
}

function resolveTargetWorkspace(file, specifier) {
  const packageTarget = matchPackageWorkspace(specifier);
  if (packageTarget) return packageTarget;
  if (!specifier.startsWith('.')) return null;
  const absolute = resolve(dirname(file), specifier);
  return workspaceForPath(absolute);
}

function matchPackageWorkspace(specifier) {
  for (const [packageName, workspace] of [...workspaceByPackageName.entries()].sort((a, b) => b[0].length - a[0].length)) {
    if (specifier === packageName || specifier.startsWith(`${packageName}/`)) return workspace;
  }
  return null;
}

function findImportedPackageName(specifier) {
  for (const packageName of workspaceByPackageName.keys()) {
    if (specifier === packageName || specifier.startsWith(`${packageName}/`)) return packageName;
  }
  return null;
}

function workspaceForPath(path) {
  for (const [workspace, workspaceRoot] of workspaceRoots) {
    if (path === workspaceRoot || path.startsWith(`${workspaceRoot}${sep}`)) return workspace;
  }
  return null;
}

function scriptKind(file) {
  if (file.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (file.endsWith('.mts')) return ts.ScriptKind.TS;
  if (file.endsWith('.cts')) return ts.ScriptKind.TS;
  return ts.ScriptKind.TS;
}
