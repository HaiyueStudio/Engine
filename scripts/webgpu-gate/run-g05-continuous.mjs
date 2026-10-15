import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve, relative, sep } from 'node:path';
import { cpus, hostname, release } from 'node:os';
import { fileURLToPath } from 'node:url';
import { sha256 } from './deferred-fixture-policy.mjs';
import { buildDeferredFixture } from './deferred-fixture-builder.mjs';
import { buildG05ForwardBaseline } from './build-g05-forward-baseline.mjs';
import { runChromeWebGpuFixture } from './chrome-runner.mjs';
import { frameGraphBrowserPath } from './framegraph-qualification.mjs';
import { G05_FORWARD_CASES } from './deferred-g05-forward-policy.mjs';
import { validateG05ContinuousConfig, createG05ContinuousPlan, validateG05ContinuousHost, validateG05ContinuousCapture, evaluateG05ContinuousBudgets } from './deferred-g05-continuous-policy.mjs';
import { validateG05ContinuousMemory } from './deferred-g05-continuous-memory.mjs';
import { auditG05ContinuousReport } from './deferred-g05-continuous-artifact.mjs';
import { lightingContinuousEvidenceInputs } from './framegraph-evidence-inputs.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url)), args = process.argv.slice(2);
if (args.length === 1 && args[0].startsWith('--audit=')) {
  const path = resolve(root, args[0].slice(8)), directory = resolve(path, '..');
  const readBound = name => { const file = resolve(directory, name), local = relative(directory, file); if (!local || local === '..' || local.startsWith(`..${sep}`) || /^[A-Za-z]:/.test(local)) throw Error('Evidence path escaped output'); return readFile(file); };
  const result = await auditG05ContinuousReport(JSON.parse(await readFile(path)), readBound, await readFile(resolve(root, 'config/lighting-performance-021.json')));
  console.log(JSON.stringify(result, null, 2)); process.exit(result.status === 'passed' ? 0 : 1);
}
if (args.length !== 2 || !/^--suite=(rooms|instances|forward)$/.test(args[0]) || !['--plan', '--smoke', '--full'].includes(args[1])) throw Error('Use --suite=rooms|instances|forward --plan|--smoke|--full');
const suite = args[0].slice(8), smoke = args[1] === '--smoke';
const configBytes = await readFile(resolve(root, 'config/lighting-continuous-021.json')), config = validateG05ContinuousConfig(JSON.parse(configBytes));
const budgetBytes = await readFile(resolve(root, config.frozenBudget.path));
if (sha256(budgetBytes) !== config.frozenBudget.sha256) throw Error('Frozen budget bytes changed');
const budget = JSON.parse(budgetBytes), fullPlan = createG05ContinuousPlan(config, suite);
const plan = smoke ? fullPlan.filter(j => j.cohort === 0 && (suite === 'rooms' ? j.caseId === 'dynamic-128-four-view' : suite === 'instances' ? j.count === 1000 && j.views === 4 : true)) : fullPlan;
if (args[1] === '--plan') { console.log(JSON.stringify({ config, suite, captures: fullPlan.length, plan: fullPlan }, null, 2)); process.exit(0); }
const directory = resolve(root, 'artifacts/engine-0.2.1/g05', `continuous-${suite}-${smoke ? 'smoke-' : ''}${new Date().toISOString().replaceAll(':', '-')}`);
await mkdir(directory, { recursive: true }); console.log(directory);
const save = async (name, value) => { const bytes = JSON.stringify(value, null, 2) + '\n'; await writeFile(resolve(directory, name), bytes); return { file: name, sha256: sha256(bytes) }; };
const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const report = { schemaVersion: 1, protocolId: config.protocolId, tier: smoke ? 'smoke' : 'local-full', suite, status: 'running', config,
  generatedAt: new Date().toISOString(), plan, revision: git(['rev-parse', 'HEAD']), dirty: !!git(['status', '--porcelain']), entries: [] };
const cpuSnapshot = () => cpus().reduce((a, c) => ({ idle: a.idle + c.times.idle, total: a.total + Object.values(c.times).reduce((x, y) => x + y, 0) }), { idle: 0, total: 0 });
let previousCpu = cpuSnapshot();
const cpuSample = () => { const current = cpuSnapshot(), delta = current.total - previousCpu.total; const sample = { at: new Date().toISOString(), busyPercent: delta ? 100 * (1 - (current.idle - previousCpu.idle) / delta) : 0 }; previousCpu = current; return sample; };
function host() {
  const hardware = JSON.parse(execFileSync('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', ['-NoProfile', '-Command',
    '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding; [pscustomobject]@{ gpu=@(Get-CimInstance Win32_VideoController | Select-Object Name,DriverVersion); power=(powercfg /getactivescheme | Out-String) } | ConvertTo-Json -Depth 4 -Compress'], { encoding: 'utf8', windowsHide: true }));
  return validateG05ContinuousHost({ at: new Date().toISOString(), platform: process.platform, hostname: hostname(), os: release(), cpu: cpus()[0].model, hardware }, config);
}
const fingerprint = () => lightingContinuousEvidenceInputs(root, config);
try {
  report.hostBefore = host(); report.inputs = await fingerprint();
  report.build = await buildDeferredFixture({ sourceRoot: root, outputDirectory: resolve(directory, 'candidate') });
  const baseline = suite === 'forward' ? await buildG05ForwardBaseline({ root, directory: resolve(directory, 'baseline'), config }) : null;
  if (baseline) report.baseline = baseline.provenance;
  if (JSON.stringify(report.inputs) !== JSON.stringify(await fingerprint())) throw Error('Inputs changed during build');
  report.registration = await save('registration.json', { ...report, entries: undefined, registeredAt: new Date().toISOString() });
  await save('report.json', report); process.env.WEBGPU_REQUIRE_NATIVE = '1';
  for (const [i, job] of plan.entries()) {
    const armBaseline = job.arm === 'baseline', runtime = armBaseline ? baseline.directory : resolve(directory, 'candidate');
    const evidence = { schemaVersion: 1, protocolId: config.protocolId, startedAt: new Date().toISOString(), job, inputs: armBaseline ? baseline.provenance.sourceSha256 : report.inputs.runtime.sha256,
      harness: report.inputs.harness, revision: armBaseline ? config.forwardBaselineRevision : report.revision, dirty: armBaseline ? false : report.dirty, hostSamples: [cpuSample()] };
    const entry = { job, status: 'running' }; report.entries.push(entry);
    try {
      const fixture = suite === 'rooms' ? 'room' : suite === 'instances' ? 'instance' : 'forward';
      const query = suite === 'forward' ? { ...G05_FORWARD_CASES.find(c => c.id === job.caseId), framegraphRuntime: 1, resolution: '720p', warmup: smoke ? 2 : 120, samples: smoke ? 3 : 300, gpuSamples: smoke ? 3 : 300 } :
        { ...job, full: smoke ? 0 : 1, moving: job.moving ? 1 : 0 };
      evidence.result = await runChromeWebGpuFixture({ root, browserPath: frameGraphBrowserPath(job.browserId),
        fixture: `scripts/webgpu-gate/deferred-g05-${fixture}-fixture.html`, query: { ...query, powerPreference: 'high-performance' },
        timeoutMs: suite === 'rooms' ? 1200000 : 480000, acceptedStatuses: ['passed', 'failed'], chunkedResult: true,
        mounts: [{ prefix: '/artifacts/engine-0.2.1/g03', directory: runtime }, { prefix: '/artifacts/engine-0.2.1/g05', directory: runtime },
          { prefix: '/artifacts/engine-0.2.1/g09/oracle-runtime', directory: runtime }, { prefix: '/games', directory: resolve(root, 'scripts/fixtures/lighting-content') }] });
    } catch (error) { evidence.result = { status: 'failed', stage: 'browser', error: error.stack, browserFailure: error.browserFailure }; }
    evidence.hostSamples.push(cpuSample()); entry.raw = await save(`${String(i).padStart(3, '0')}.json`, evidence);
    try {
      validateG05ContinuousCapture(evidence, job, config, { smoke });
      if (suite === 'rooms') { entry.memory = validateG05ContinuousMemory(evidence.result, budget); if (entry.memory.status !== 'passed') throw Error('Frozen memory budget failed'); }
      entry.status = smoke ? 'smoke-complete' : 'captured';
    } catch (error) { entry.status = 'invalid'; entry.error = error.stack; }
    await save('report.json', report);
    console.log(JSON.stringify({ capture: i + 1, total: plan.length, job, status: entry.status, error: entry.error?.split('\n')[0] ?? evidence.result.error }));
    if (JSON.stringify(report.inputs) !== JSON.stringify(await fingerprint())) throw Error('Inputs changed during capture; remaining plan retained unexecuted');
  }
  report.hostAfter = host();
  if (report.hostAfter.hostname !== report.hostBefore.hostname || JSON.stringify(report.hostAfter.hardware) !== JSON.stringify(report.hostBefore.hardware)) throw Error('Host identity/power changed');
  report.inputsAfter = await fingerprint();
  if (report.entries.some(e => e.status === 'invalid')) report.status = 'invalid';
  else if (smoke) report.status = 'smoke-complete';
  else {
    const readBound = name => { const path = resolve(directory, name), local = relative(directory, path); if (!local || local === '..' || local.startsWith(`..${sep}`) || /^[A-Za-z]:/.test(local)) throw Error('Evidence path escaped output'); return readFile(path); };
    report.assessment = await auditG05ContinuousReport(report, readBound, budgetBytes); report.status = report.assessment.status;
  }
} catch (error) { report.status = 'invalid'; report.error = error.stack; }
finally { report.finishedAt = new Date().toISOString(); await save('report.json', report); console.log(JSON.stringify({ directory, status: report.status, error: report.error })); }
if (!['passed', 'smoke-complete'].includes(report.status)) process.exitCode = 1;
