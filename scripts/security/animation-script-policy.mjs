import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const FORBIDDEN = Object.freeze([
  ['dynamic-eval', /\beval\s*\(|\bnew\s+Function\b|\bFunction\s*\(/u],
  ['dynamic-module', /\bimport\s*\(|\bimportScripts\s*\(/u],
  ['browser-ambient', /\b(?:document|window|navigator|localStorage|sessionStorage|indexedDB)\s*[.[]|\b(?:XMLHttpRequest|WebSocket|EventSource)\b/u],
  ['network', /\bfetch\s*\(|\bnode:(?:http|https|net|tls|dns)\b/u],
  ['filesystem-process', /\bnode:(?:fs|child_process|process|worker_threads)\b/u],
  ['trusted-runtime', /\btrusted-project\b|\bScriptExecutionScope\b|@haiyue\/engine/u],
  ['source-format-vocabulary', /rive/iu],
]);

export function auditAnimationScriptIsolation(workspace) {
  const roots = [
    path.join(workspace, 'animation-spec/src/script'),
    path.join(workspace, 'extensions/src/animation-script'),
  ];
  const findings = [];
  for (const file of roots.flatMap(walk).filter(file => file.endsWith('.ts'))) {
    const source = readFileSync(file, 'utf8');
    for (const [rule, pattern] of FORBIDDEN) {
      const match = pattern.exec(source);
      if (match !== null) findings.push(Object.freeze({ rule, file: path.relative(workspace, file).replaceAll('\\', '/'), index: match.index }));
    }
    if (/module\.source\s*[+`]|[+`]\s*module\.source/u.test(source)) {
      findings.push(Object.freeze({ rule: 'shader-source-concatenation', file: path.relative(workspace, file).replaceAll('\\', '/'), index: source.indexOf('module.source') }));
    }
  }
  return Object.freeze({
    schema: 'haiyue-animation-script-security-audit@1',
    roots: Object.freeze(roots.map(root => path.relative(workspace, root).replaceAll('\\', '/'))),
    files: roots.flatMap(walk).filter(file => file.endsWith('.ts')).length,
    findings: Object.freeze(findings),
    status: findings.length === 0 ? 'passed' : 'failed',
  });
}
export function scanAnimationScriptSource(source) {
  return Object.freeze(FORBIDDEN.flatMap(([rule, pattern]) => pattern.test(source) ? [rule] : []));
}

export function auditAnimationScriptPackageClosure(workspace) {
  const findings = [];
  const denyList = JSON.parse(readFileSync(path.join(workspace, 'docs/for-ai/rive-hya/browser-runtime-deny-list.json'), 'utf8'));
  const markers = ['org.haiyue.sandboxed-animation-script@1', 'haiyue-portable-script@1', 'PortableScriptVm'];
  for (const packageName of ['animation-spec', 'extensions']) {
    const packageRoot = path.join(workspace, packageName);
    const manifest = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
    if ((manifest.files ?? []).some(entry => entry === 'src' || entry.startsWith('src/'))) {
      findings.push(Object.freeze({ rule: 'published-source-tree', file: `${packageName}/package.json` }));
    }
    const exportsText = JSON.stringify(manifest.exports ?? {});
    if (exportsText.includes('animation-script') || exportsText.includes('src/script')) {
      findings.push(Object.freeze({ rule: 'premature-public-export', file: `${packageName}/package.json` }));
    }
    const dependencies = JSON.stringify({ ...manifest.dependencies, ...manifest.peerDependencies, ...manifest.optionalDependencies });
    for (const forbiddenPackage of denyList.forbiddenPackages) {
      if (dependencies.includes(forbiddenPackage)) findings.push(Object.freeze({ rule: 'forbidden-runtime-package', file: `${packageName}/package.json`, value: forbiddenPackage }));
    }
    const rootEntry = readFileSync(path.join(packageRoot, 'src/index.ts'), 'utf8');
    if (/(?:from\s+|import\s*)['"]\.\/(?:animation-)?script(?:\/|['"])/u.test(rootEntry)) {
      findings.push(Object.freeze({ rule: 'premature-root-export', file: `${packageName}/src/index.ts` }));
    }
    const distRoot = path.join(packageRoot, 'dist');
    if (existsSync(distRoot)) {
      for (const file of walk(distRoot).filter(entry => /\.(?:js|mjs|cjs|map)$/u.test(entry))) {
        const source = readFileSync(file, 'utf8');
        for (const marker of markers) if (source.includes(marker)) findings.push(Object.freeze({ rule: 'sandbox-payload-in-published-dist', file: path.relative(workspace, file).replaceAll('\\', '/'), value: marker }));
        for (const pattern of denyList.forbiddenStaticPatterns) if (source.includes(pattern)) findings.push(Object.freeze({ rule: 'browser-deny-list-pattern', file: path.relative(workspace, file).replaceAll('\\', '/'), value: pattern }));
      }
    }
  }
  return Object.freeze({
    schema: 'haiyue-animation-script-package-closure@1',
    packages: Object.freeze(['@haiyue/animation-spec', '@haiyue/extensions']),
    denyListSchemaVersion: denyList.schemaVersion,
    findings: Object.freeze(findings),
    status: findings.length === 0 ? 'passed' : 'failed',
  });
}

function walk(directory) {
  const result = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const resolved = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...walk(resolved));
    else result.push(resolved);
  }
  return result;
}
