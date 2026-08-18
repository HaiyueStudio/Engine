import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { npmArgs, npmCommand } from './npm-process.mjs';
import {
  collectProductionComponents,
  createDependencySbom,
  findCredentialLeaks,
  sha256File,
  validateAuditReport,
} from './release-supply-chain-policy.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputRoot = resolve(root, argumentValue('--output') ?? 'artifacts/release/supply-chain');
const allowedArguments = new Set(['--output']);
for (let index = 2; index < process.argv.length; index += 1) {
  const argument = process.argv[index];
  if (!allowedArguments.has(argument)) throw new Error(`Unknown supply-chain argument "${argument}".`);
  index += 1;
}
assertInsideRoot(outputRoot);
mkdirSync(outputRoot, { recursive: true });

const lockfilePath = resolve(root, 'package-lock.json');
const lockfile = JSON.parse(readFileSync(lockfilePath, 'utf8'));
const revision = git(['rev-parse', 'HEAD']);
const sourceDirty = git(['status', '--porcelain']).length > 0;
const dependencyPolicy = collectProductionComponents(lockfile, workspace => {
  const path = resolve(root, workspace, 'package.json');
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
});

const auditPath = resolve(outputRoot, 'npm-audit-production.json');
const audit = runAudit(auditPath);
const auditPolicy = validateAuditReport(audit.report);
const trackedFiles = gitNull(['ls-files', '-z'])
  .map(path => ({ path, contents: readScannable(resolve(root, path)) }));
const credentialFindings = findCredentialLeaks(trackedFiles);
const errors = [
  ...dependencyPolicy.errors,
  ...audit.errors,
  ...auditPolicy.errors,
  ...credentialFindings.map(finding => `${finding.kind} detected in ${finding.path}`),
];
const report = {
  schemaVersion: 1,
  goal: 'g06-ci-supply-chain-release-rehearsal',
  generatedAt: new Date().toISOString(),
  source: {
    revision,
    dirty: sourceDirty,
    node: process.version,
    v8: process.versions.v8,
    platform: `${process.platform}-${process.arch}`,
    packageLockSha256: sha256File(lockfilePath),
  },
  dependencyAudit: {
    manager: 'npm',
    command: ['npm', 'audit', '--omit=dev', '--audit-level=high', '--json'],
    lockedInstallCommand: ['npm', 'ci'],
    productionComponentCount: dependencyPolicy.components.length,
    vulnerabilityCounts: audit.report?.metadata?.vulnerabilities ?? null,
    licensePolicy: 'allowlist-with-reviewed-expression-selection',
    components: dependencyPolicy.components,
  },
  credentialScan: {
    trackedFileCount: trackedFiles.length,
    findings: credentialFindings,
  },
  gate: { status: errors.length === 0 ? 'passed' : 'failed', errors },
};
const reportPath = resolve(outputRoot, 'report.json');
const sbomPath = resolve(outputRoot, 'dependencies.cdx.json');
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
writeFileSync(sbomPath, `${JSON.stringify(createDependencySbom({
  components: dependencyPolicy.components,
  lockfileSha256: report.source.packageLockSha256,
  revision,
}), null, 2)}\n`);

if (errors.length > 0) {
  console.error('[release-supply-chain] Failed:');
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}
console.log(
  `[release-supply-chain] passed; production-components=${dependencyPolicy.components.length}; `
  + `node=${process.version}; v8=${process.versions.v8}; report=${relative(root, reportPath)}.`,
);

function runAudit(path) {
  const result = spawnSync(npmCommand(), npmArgs(['audit', '--omit=dev', '--audit-level=high', '--json']), {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  const raw = result.stdout || JSON.stringify({ error: result.stderr || result.error?.message || 'npm audit emitted no output' });
  writeFileSync(path, raw.endsWith('\n') ? raw : `${raw}\n`);
  let report = null;
  const errors = [];
  try {
    report = JSON.parse(raw);
  } catch {
    errors.push(`npm audit output is not JSON: ${result.stderr || result.error?.message || 'unknown error'}`);
  }
  if (result.error) errors.push(`npm audit failed to start: ${result.error.message}`);
  if (result.status !== 0 && !(report?.metadata?.vulnerabilities)) {
    errors.push(`npm audit was unavailable or incomplete (exit ${result.status}): ${result.stderr.trim()}`);
  }
  return { report, errors };
}

function readScannable(path) {
  try {
    const size = statSync(path).size;
    if (size > 16 * 1024 * 1024) return null;
    return readFileSync(path);
  } catch {
    return null;
  }
}

function git(args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

function gitNull(args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'buffer' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed.`);
  return result.stdout.toString('utf8').split('\0').filter(Boolean);
}

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function assertInsideRoot(path) {
  const rel = relative(root, path);
  if (!rel || rel.startsWith('..') || rel.startsWith('/')) throw new Error('--output must resolve inside the repository.');
}
