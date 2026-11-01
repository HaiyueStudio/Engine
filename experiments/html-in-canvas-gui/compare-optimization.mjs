import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const baselinePath = resolve(root, 'experiments/html-in-canvas-gui/baselines/chrome-157-2026-11-01.json');
const optimizedPath = resolve(root, 'artifacts/performance/html-in-canvas-gui-comparison.json');
const outputJson = resolve(root, 'artifacts/performance/html-in-canvas-gui-optimization-comparison.json');
const outputMarkdown = resolve(root, 'artifacts/performance/html-in-canvas-gui-optimization-comparison.md');
const baseline = readJson(baselinePath);
const optimized = readJson(optimizedPath);

const rows = [];
for (const html of baseline.cases.filter(item => item.mode === 'html')) {
  const widgetCount = html.configuration.widgetCount;
  const updateRatio = html.configuration.updateRatio;
  const before = findCase(baseline, 'native', widgetCount, updateRatio);
  const after = findCase(optimized, 'native', widgetCount, updateRatio);
  rows.push({
    widgetCount,
    updateRatio,
    html: channels(html),
    nativeBefore: channels(before),
    nativeAfter: channels(after),
    improvement: {
      fpsRatio: ratio(after.timing.effectiveFps, before.timing.effectiveFps),
      frameP95Ratio: ratio(before.timing.frameIntervalMs.p95, after.timing.frameIntervalMs.p95),
      updateP95Ratio: ratio(before.timing.updateCpuMs.p95, after.timing.updateCpuMs.p95),
      taskCpuRatio: ratio(
        before.cdp.performanceDelta.TaskDuration / before.configuration.sampleFrames,
        after.cdp.performanceDelta.TaskDuration / after.configuration.sampleFrames,
      ),
    },
  });
}
rows.sort((left, right) => left.widgetCount - right.widgetCount || left.updateRatio - right.updateRatio);

const artifact = {
  schemaVersion: 1,
  suite: 'html-in-canvas-vs-haiyue-native-gui-before-after',
  generatedAt: new Date().toISOString(),
  browser: optimized.cases[0]?.chrome.product ?? baseline.cases[0]?.chrome.product,
  adapter: optimized.cases[0]?.adapter ?? baseline.cases[0]?.adapter,
  baseline: { path: baselinePath, generatedAt: baseline.generatedAt, sourceFingerprint: baseline.sourceFingerprint },
  optimized: { path: optimizedPath, generatedAt: optimized.generatedAt, sourceFingerprint: optimized.sourceFingerprint },
  rows,
};
writeFileSync(outputJson, `${JSON.stringify(artifact, null, 2)}\n`);
writeFileSync(outputMarkdown, renderMarkdown(artifact));
console.log(renderConsole(rows));
console.log(`[html-in-canvas-gui] Wrote ${outputJson}`);
console.log(`[html-in-canvas-gui] Wrote ${outputMarkdown}`);

function channels(item) {
  return {
    sampleFrames: item.configuration.sampleFrames,
    fps: item.timing.effectiveFps,
    frameP95Ms: item.timing.frameIntervalMs.p95,
    missedFrameRatio: item.timing.missedFrameRatio,
    updateP95Ms: item.timing.updateCpuMs.p95,
    callbackP95Ms: item.timing.callbackCpuMs.p95,
    gpuP95Ms: item.timing.gpuRenderPassMs?.p95 ?? null,
    queueP95Ms: item.timing.endToEndQueueCompletionMs.p95,
    taskCpuSeconds: item.cdp.performanceDelta.TaskDuration ?? null,
    taskCpuMsPerFrame: Number.isFinite(item.cdp.performanceDelta.TaskDuration)
      ? item.cdp.performanceDelta.TaskDuration * 1000 / item.configuration.sampleFrames
      : null,
    rendererCpuSeconds: item.cdp.processCpuSeconds.renderer ?? null,
    gpuProcessCpuSeconds: item.cdp.processCpuSeconds.GPU ?? null,
    setupUaMiB: Number.isFinite(item.memory.setupUaBytesDelta) ? item.memory.setupUaBytesDelta / 1048576 : null,
    setupJsHeapMiB: Number.isFinite(item.memory.setupJsHeapBytesDelta) ? item.memory.setupJsHeapBytesDelta / 1048576 : null,
    retainedGeometryMiB: Number.isFinite(item.resources.retainedCpuGeometryBytes)
      ? item.resources.retainedCpuGeometryBytes / 1048576
      : null,
  };
}

function renderMarkdown(artifact) {
  const lines = [
    '# HTML-in-Canvas and Haiyue native GUI optimization comparison',
    '',
    `Generated: ${artifact.generatedAt}`,
    '',
    `Browser: ${artifact.browser}`,
    '',
    '| Widgets | Updates/frame | HTML FPS | Native before FPS | Native optimized FPS | Native FPS gain | Native frame p95 before | Native frame p95 after |',
    '|---:|---:|---:|---:|---:|---:|---:|---:|',
  ];
  for (const row of artifact.rows) {
    lines.push(`| ${row.widgetCount} | ${percent(row.updateRatio)} | ${number(row.html.fps)} | ${number(row.nativeBefore.fps)} | ${number(row.nativeAfter.fps)} | ${multiple(row.improvement.fpsRatio)} | ${milliseconds(row.nativeBefore.frameP95Ms)} | ${milliseconds(row.nativeAfter.frameP95Ms)} |`);
  }
  lines.push(
    '',
    '| Widgets | Updates/frame | Native update p95 before | Native update p95 after | Update speedup | Native task CPU/frame before | Native task CPU/frame after | Task CPU/frame speedup | Native setup memory before | Native setup memory after |',
    '|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
  );
  for (const row of artifact.rows) {
    lines.push(`| ${row.widgetCount} | ${percent(row.updateRatio)} | ${milliseconds(row.nativeBefore.updateP95Ms)} | ${milliseconds(row.nativeAfter.updateP95Ms)} | ${multiple(row.improvement.updateP95Ratio)} | ${milliseconds(row.nativeBefore.taskCpuMsPerFrame)} | ${milliseconds(row.nativeAfter.taskCpuMsPerFrame)} | ${multiple(row.improvement.taskCpuRatio)} | ${mib(row.nativeBefore.setupUaMiB)} | ${mib(row.nativeAfter.setupUaMiB)} |`);
  }
  lines.push(
    '',
    'The optimized native 4,096-widget 100% case completed 120 measured frames. The baseline exceeded ten minutes at 120 frames and therefore used 30 measured frames. Task CPU is normalized per measured frame before calculating its speedup.',
    '',
  );
  return `${lines.join('\n')}\n`;
}

function renderConsole(rows) {
  return rows.map(row => (
    `${row.widgetCount} widgets ${percent(row.updateRatio)}: `
    + `HTML ${number(row.html.fps)} fps; native ${number(row.nativeBefore.fps)} -> ${number(row.nativeAfter.fps)} fps `
    + `(${multiple(row.improvement.fpsRatio)})`
  )).join('\n');
}

function findCase(artifact, mode, widgetCount, updateRatio) {
  const item = artifact.cases.find(candidate => candidate.mode === mode
    && candidate.configuration.widgetCount === widgetCount
    && candidate.configuration.updateRatio === updateRatio);
  if (!item) throw new Error(`Missing ${mode} ${widgetCount}/${updateRatio} case.`);
  return item;
}

function readJson(path) { return JSON.parse(readFileSync(path, 'utf8')); }
function ratio(numerator, denominator) { return Number.isFinite(numerator) && Number.isFinite(denominator) && denominator !== 0 ? numerator / denominator : null; }
function number(value) { return Number.isFinite(value) ? value.toFixed(1) : 'n/a'; }
function milliseconds(value) { return Number.isFinite(value) ? `${value.toFixed(2)} ms` : 'n/a'; }
function seconds(value) { return Number.isFinite(value) ? `${value.toFixed(3)} s` : 'n/a'; }
function mib(value) { return Number.isFinite(value) ? `${value.toFixed(1)} MiB` : 'n/a'; }
function multiple(value) { return Number.isFinite(value) ? `${value.toFixed(2)}×` : 'n/a'; }
function percent(value) { return `${Math.round(value * 100)}%`; }
