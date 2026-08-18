import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runChromeWebGpuFixture } from './webgpu-gate/chrome-runner.mjs';
import { summarizeTimingSamples } from './benchmark/timing-cohorts.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputArgument = argumentValue('--output');
if (!outputArgument) throw new Error('--output is required.');
const output = resolve(root, outputArgument);
const cohortCount = positiveInteger(argumentValue('--cohorts'), 3);
if (cohortCount < 3) throw new Error('Editor app cold-start requires at least three independent browser cohorts.');
const sourceCandidatePath = resolve(root, 'artifacts/release/g03-package-app-candidate.json');
if (!existsSync(sourceCandidatePath)) {
  throw new Error('Editor app cold-start requires the passed G03 production app candidate.');
}
const sourceCandidate = JSON.parse(readFileSync(sourceCandidatePath, 'utf8'));
if (sourceCandidate.gate?.status !== 'passed') throw new Error('G03 production app candidate did not pass.');
const appIds = ['scene-editor', 'animation-editor'];
const specs = appIds.map(id => {
  const manifestPath = resolve(root, `artifacts/release/apps/${id}/release-manifest.json`);
  if (!existsSync(manifestPath)) throw new Error(`${id} release manifest is missing.`);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  return {
    id,
    entry: `/artifacts/release/apps/${id}/${manifest.entry ?? manifest.entries?.[0]}`,
    maxColdStartMs: 15_000,
    startupClosureGzipBytes: manifest.startupClosureGzipBytes ?? null,
  };
});
mkdirSync(dirname(output), { recursive: true });
const fixturePath = resolve(dirname(output), 'app-cold-start-fixture.html');
const cohorts = [];
for (let round = 1; round <= cohortCount; round++) {
  const apps = [];
  for (const spec of specs) {
    console.log(
      `[app-cold-start] ${spec.id} independent Chrome cohort ${round}/${cohortCount}`,
    );
    writeFileSync(fixturePath, fixture(spec));
    const result = await runChromeWebGpuFixture({
      root,
      fixture: relative(root, fixturePath),
      timeoutMs: 120_000,
    });
    const measured = result.apps?.find(app => app.id === spec.id);
    if (!Number.isFinite(measured?.coldStartMs)) {
      throw new Error(`${spec.id} cold-start cohort ${round} is incomplete.`);
    }
    apps.push({
      id: spec.id,
      coldStartMs: measured.coldStartMs,
      browser: result.browser,
      browserEvidence: result.browserEvidence,
      httpProvenance: result.httpProvenance,
    });
  }
  cohorts.push({
    round,
    generatedAt: new Date().toISOString(),
    apps,
  });
}
const apps = specs.map(spec => {
  const samples = cohorts.map(cohort => (
    cohort.apps.find(app => app.id === spec.id)?.coldStartMs
  ));
  if (samples.some(sample => !Number.isFinite(sample))) {
    throw new Error(`${spec.id} cold-start cohort is incomplete.`);
  }
  const timing = summarizeTimingSamples(samples);
  return {
    ...spec,
    samples: samples.length,
    timing,
    status: timing.p95 <= spec.maxColdStartMs ? 'passed' : 'failed',
  };
});
const artifact = {
  schemaVersion: 1,
  suite: 'editor.app-cold-start',
  generatedAt: new Date().toISOString(),
  configuration: {
    apps: appIds,
    independentBrowserCohorts: cohortCount,
    browserProcessesPerApp: cohortCount,
    totalBrowserProcesses: cohortCount * appIds.length,
    cachePolicy: 'fresh Chrome process and user-data directory per app per cohort',
    sourceArtifacts: 'G03 production release apps',
  },
  sourceCandidate: {
    revision: sourceCandidate.sourceState?.revision ?? null,
    workingTreeDirty: sourceCandidate.sourceState?.workingTreeDirty ?? null,
    gateStatus: sourceCandidate.gate?.status ?? null,
  },
  cohorts,
  apps,
  gate: {
    status: apps.every(app => app.status === 'passed') ? 'passed' : 'failed',
    failures: apps.filter(app => app.status !== 'passed').map(app => (
      `${app.id} P95 ${app.timing.p95}ms > ${app.maxColdStartMs}ms`
    )),
  },
};
writeFileSync(output, `${JSON.stringify(artifact, null, 2)}\n`);
if (artifact.gate.status !== 'passed') {
  throw new Error(`Editor app cold-start failed: ${artifact.gate.failures.join('; ')}`);
}
console.log(
  `[app-cold-start] ${apps.map(app => (
    `${app.id} P50/P95=${app.timing.p50.toFixed(1)}/${app.timing.p95.toFixed(1)}ms`
  )).join(', ')}; wrote ${relative(root, output)}.`,
);

function fixture(spec) {
  const serialized = JSON.stringify(spec).replaceAll('<', '\\u003c');
  return `<!doctype html><meta charset="utf-8"><title>G04 app cold-start</title>
<pre id="result" data-status=""></pre>
<script type="module">
const spec = ${serialized};
const result = document.querySelector('#result');
const apps = [];
try {
  const started = performance.now();
  const iframe = document.createElement('iframe');
  iframe.hidden = true;
  iframe.src = new URL(spec.entry, location.href).href;
  await Promise.race([
    new Promise((resolve, reject) => {
      iframe.addEventListener('load', resolve, { once: true });
      iframe.addEventListener('error', () => reject(new Error(spec.id + ' failed to load')), { once: true });
      document.body.append(iframe);
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error(spec.id + ' timed out')), spec.maxColdStartMs)),
  ]);
  apps.push({ id: spec.id, coldStartMs: performance.now() - started });
  iframe.remove();
  result.dataset.status = 'passed';
  result.textContent = JSON.stringify({ browser: navigator.userAgent, apps });
} catch (error) {
  result.dataset.status = 'failed';
  result.textContent = error instanceof Error ? error.stack ?? error.message : String(error);
}
</script>`;
}

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : '';
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}
