import { SCENE_CONTRACT, createObjectDescriptors } from './scene-contract.mjs';
import { evaluateComparisonReport } from './lib/policy.mjs';
import { summarizeSamples } from './lib/statistics.mjs';
import { captureVisualSanity } from './lib/visual-sanity.mjs';

const resultNode = document.querySelector('#result');
const progressNode = document.querySelector('#progress');
const summaryNode = document.querySelector('#summary');
const viewportNode = document.querySelector('#viewport');
const query = new URLSearchParams(location.search);
const profile = query.get('profile') === 'full' ? 'full' : 'smoke';
const profileOptions = profile === 'full'
  ? { cohorts: 3, warmupFrames: 12, sampleFrames: 40 }
  : { cohorts: 1, warmupFrames: 4, sampleFrames: 12 };
const versions = parseVersions(query.get('versions'));
const engineIds = ['haiyue', 'three', 'babylon', 'playcanvas', 'galacean'];
const objects = createObjectDescriptors();
const visualOnly = query.get('visualOnly');

try {
  if (!navigator.gpu) throw new Error('navigator.gpu is unavailable; the ranked WebGPU comparison cannot run.');
  if (visualOnly) await runVisualFixture(visualOnly);
  else await runTimingComparison();
} catch (error) {
  resultNode.textContent = error instanceof Error ? (error.stack ?? error.message) : String(error);
  resultNode.dataset.status = 'failed';
  progressNode.textContent = 'failed';
}

async function runVisualFixture(engineId) {
  if (!engineIds.includes(engineId)) throw new Error(`Unknown visual adapter ${engineId}.`);
  document.documentElement.dataset.visualOnly = 'true';
  progressNode.textContent = `visual: ${engineId}`;
  const canvas = createCanvas();
  const module = await import(`./adapters/${engineId}.mjs`);
  const adapter = await module.createAdapter({ canvas, contract: SCENE_CONTRACT, objects, version: versions[engineId] ?? 'unknown' });
  for (let frame = 0; frame < 8; frame++) {
    await adapter.render(frame);
    await adapter.settle();
  }
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  // Keep the adapter and canvas alive until the browser runner captures the page.
  resultNode.textContent = JSON.stringify({
    schemaVersion: 1,
    mode: 'visual',
    engineId,
    backend: adapter.backend,
    structural: adapter.structural,
  });
  resultNode.dataset.status = 'passed';
  progressNode.textContent = 'complete';
}

async function runTimingComparison() {
  const engineCohorts = new Map(engineIds.map(engineId => [engineId, []]));
  const engineMetadata = new Map();
  for (let cohortIndex = 0; cohortIndex < profileOptions.cohorts; cohortIndex++) {
    const order = rotate(engineIds, cohortIndex * 2);
    for (const engineId of order) {
      progressNode.textContent = `cohort ${cohortIndex + 1}/${profileOptions.cohorts}: ${engineId}`;
      const canvas = createCanvas();
      let adapter;
      try {
        const module = await import(`./adapters/${engineId}.mjs`);
        adapter = await module.createAdapter({ canvas, contract: SCENE_CONTRACT, objects, version: versions[engineId] ?? 'unknown' });
        for (let frame = 0; frame < profileOptions.warmupFrames; frame++) {
          await adapter.render(frame);
          await adapter.settle();
        }
        const cpuSubmit = [];
        const frameWall = [];
        for (let frame = 0; frame < profileOptions.sampleFrames; frame++) {
          const wallStartedAt = performance.now();
          const cpuStartedAt = performance.now();
          await adapter.render(profileOptions.warmupFrames + frame);
          cpuSubmit.push(performance.now() - cpuStartedAt);
          await adapter.settle();
          frameWall.push(performance.now() - wallStartedAt);
        }
        await adapter.render(profileOptions.warmupFrames + profileOptions.sampleFrames);
        await adapter.settle();
        const localVisualDiagnostic = await captureVisualSanity(canvas, SCENE_CONTRACT.clearColor);
        engineMetadata.set(engineId, { ...adapter, localVisualDiagnostic });
        engineCohorts.get(engineId).push({
          id: `cohort-${cohortIndex + 1}`,
          orderIndex: order.indexOf(engineId),
          cpuSubmit: summarizeSamples(cpuSubmit),
          frameWall: summarizeSamples(frameWall),
        });
      } finally {
        if (adapter) await adapter.dispose();
        canvas.remove();
      }
    }
  }
  const report = {
    schemaVersion: 1,
    suite: 'haiyue.cross-engine.pbr-grid',
    generatedAt: new Date().toISOString(),
    profile,
    configuration: { ...profileOptions, scene: SCENE_CONTRACT },
    engines: engineIds.map(engineId => {
      const metadata = engineMetadata.get(engineId);
      return {
        engineId,
        displayName: metadata.displayName,
        version: metadata.version,
        backend: metadata.backend,
        nativeBackend: metadata.nativeBackend,
        adapterInfo: metadata.adapterInfo,
        structural: metadata.structural,
        visual: { status: 'pending-external-capture', localDiagnostic: metadata.localVisualDiagnostic },
        browserErrorCount: 0,
        cohorts: engineCohorts.get(engineId),
      };
    }),
  };
  report.policy = evaluateComparisonReport(report);
  summaryNode.textContent = formatSummary(report);
  resultNode.textContent = JSON.stringify(report);
  resultNode.dataset.status = 'passed';
  progressNode.textContent = 'timing complete';
}

function createCanvas() {
  const canvas = document.createElement('canvas');
  canvas.width = SCENE_CONTRACT.viewport.width;
  canvas.height = SCENE_CONTRACT.viewport.height;
  canvas.style.aspectRatio = `${SCENE_CONTRACT.viewport.width}/${SCENE_CONTRACT.viewport.height}`;
  viewportNode.replaceChildren(canvas);
  return canvas;
}

function rotate(values, count) {
  const offset = count % values.length;
  return [...values.slice(offset), ...values.slice(0, offset)];
}

function parseVersions(value) {
  try { return value ? JSON.parse(value) : {}; } catch { return {}; }
}

function formatSummary(report) {
  const lines = [`profile=${report.profile}`, `timing-policy=${report.policy.status}`];
  for (const rank of report.policy.ranking) lines.push(`${rank.engineId}: P50 ${rank.medianP50Ms.toFixed(3)} ms, P95 ${rank.medianP95Ms.toFixed(3)} ms`);
  lines.push('galacean: WebGL2 informational result (not ranked)');
  return lines.join('\n');
}
