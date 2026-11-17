import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { WINDOWS_RENDER_JOBS, validateWindowsRenderReport } from '../../g13-windows-final-policy.mjs';
import { assessEngine021G05Audit } from '../../engine-021-evidence-policy.mjs';
import { windowsWorkflowHost } from '../../release-workflow.mjs';

const root = resolve(import.meta.dirname, '../../..');
const targetVersion = '0.2.4';
const target = 'artifacts/engine-' + targetVersion + '/qualification.json';
const audit = ['scripts/check-engine-021-evidence.mjs'];
const lighting = ['scripts/verify-webgpu-lighting-scaling-fixture.mjs', '--evidence=diagnostic',
  '--lights=128', '--overlap=high', '--dynamic=1', '--views=4', '--resolution=720p',
  '--warmup=4', '--samples=8', '--gpu-samples=2'];
const jobTimeout = job => (job.id === 'rooms' ? 4 : 2) * 60 * 60 * 1000;
const auditTimeout = 30 * 60 * 1000;
const lightingTimeout = 10 * 60 * 1000;
const args = process.argv.slice(2);
const plan = { targetVersion, target, samples: WINDOWS_RENDER_JOBS.reduce((n, job) => n + job.captures, 0),
  jobs: WINDOWS_RENDER_JOBS.map(job => ({ ...job, timeoutMs: jobTimeout(job) })), audit, auditTimeout, lighting, lightingTimeout };
if (args.length === 1 && args[0] === '--plan') {
  console.log(JSON.stringify(plan, null, 2));
  process.exit(0);
}
assert.deepEqual(args, ['--run'], 'Use --plan or --run.');
assert.equal(process.platform, 'win32');
const git = (...args) => execFileSync('git', ['-c', 'safe.directory=' + root.replaceAll('\\', '/'), ...args],
  { cwd: root, encoding: 'utf8', windowsHide: true }).trim();
const revision = git('rev-parse', 'HEAD');
const clean = () => {
  assert.equal(git('rev-parse', 'HEAD'), revision, 'Candidate revision changed.');
  assert.equal(git('status', '--porcelain'), '', 'Candidate source must remain clean.');
};
clean();
const host = windowsWorkflowHost(root);
assert.equal(host.administrator, true, 'Use the registered elevated Windows runner.');
assert.deepEqual(host.blockers, [], 'Background applications are still running.');
for (const required of ['artifacts/engine-0.2.1/g09/fixture-build.json',
  'artifacts/engine-0.2.1/g09/a0-built/provenance.json']) assert(existsSync(join(root, required)), 'Prepare ' + required + ' first.');
assert.equal(JSON.parse(readFileSync(join(root, 'package.json'))).version, targetVersion);
const evidence = join(root, 'artifacts/engine-0.2.4/g07');
mkdirSync(evidence, { recursive: true });
const output = mkdtempSync(join(evidence, 'legacy-render-'));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const save = (path, data) => writeFileSync(path, JSON.stringify(data, null, 2) + '\n', { flag: 'wx' });
const stages = [];
const env = { ...process.env, WEBGPU_REQUIRE_NATIVE: '1' };
for (const key of ['NODE_AUTH_TOKEN', 'NPM_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN', 'COSIGN_PRIVATE_KEY', 'SIGNING_KEY']) delete env[key];

function run(id, argv, timeout, allowFailedBudget = false) {
  clean();
  const stdout = join(output, id + '.stdout.log');
  const stderr = join(output, id + '.stderr.log');
  const out = openSync(stdout, 'wx'), err = openSync(stderr, 'wx');
  let run;
  console.log('START ' + id + ' · ' + stdout);
  try { run = spawnSync(process.execPath, argv, { cwd: root, env, windowsHide: true,
    timeout, stdio: ['ignore', out, err] }); }
  finally { closeSync(out); closeSync(err); }
  stages.push({ id, argv, status: run.status, signal: run.signal, error: run.error?.message,
    stdoutSha256: sha(readFileSync(stdout)), stderrSha256: sha(readFileSync(stderr)) });
  if (run.error) throw run.error;
  assert(run.status === 0 || (allowFailedBudget && run.status === 1), id + ' failed. See the original logs.');
  clean();
}

const destination = join(root, target);
const manifest = { schemaVersion: 2, contractId: 'engine-021-evidence-v2', targetVersion, revision, reports: {} };
let passed = false;
try {
  if (!existsSync(destination)) {
    for (const job of WINDOWS_RENDER_JOBS) {
      const parent = join(root, job.parent);
      mkdirSync(parent, { recursive: true });
      const before = new Set(readdirSync(parent));
      const budget = ['rooms', 'instances', 'forward'].includes(job.id);
      run('legacy-' + job.id, job.args, jobTimeout(job), budget);
      const fresh = readdirSync(parent).filter(name => !before.has(name) && name.startsWith(job.prefix));
      assert.equal(fresh.length, 1, job.id + ': expected one fresh report directory');
      const file = join(parent, fresh[0], 'report.json');
      const bytes = readFileSync(file), report = JSON.parse(bytes);
      validateWindowsRenderReport(job, report, revision);
      if (budget) {
        assert.equal(report.assessment.status, report.status);
        assert.equal(stages.at(-1).status === 0, report.status === 'passed');
        assessEngine021G05Audit(job.id, report.assessment, targetVersion);
      }
      manifest.reports[job.id] = { file: relative(root, file).replaceAll('\\', '/'), sha256: sha(bytes), captureRevision: revision };
    }
    mkdirSync(dirname(destination), { recursive: true });
    save(destination, manifest);
  }
  run('inherited-render-audit', audit, auditTimeout);
  run('lighting-bootstrap', lighting, lightingTimeout);
  passed = true;
} finally {
  save(join(output, 'result.json'), { status: passed ? 'passed' : 'failed', revision, targetVersion, manifest: target, stages });
  console.log('Inherited render evidence: ' + output);
}
