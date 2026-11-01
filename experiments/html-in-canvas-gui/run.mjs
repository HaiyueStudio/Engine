import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  defaultChromePath,
  removeChromeProfile,
  startHttpFixtureServer,
} from '../../scripts/webgpu-gate/chrome-runner.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const smoke = process.argv.includes('--smoke');
const browserPath = resolveBrowserPath();
const artifactPath = resolve(root, 'artifacts/performance/html-in-canvas-gui-comparison.json');
const reportPath = resolve(root, 'artifacts/performance/html-in-canvas-gui-comparison.md');
const checkpointPath = resolve(root, 'artifacts/performance/html-in-canvas-gui-comparison.partial.json');
const widgetCounts = smoke ? [128] : [256, 1024, 4096];
const updateRatios = smoke ? [0, 1] : [0, 0.1, 1];
const warmupFrames = smoke ? 8 : 30;
const sampleFrames = smoke ? 30 : 120;
const queueProbeFrames = smoke ? 2 : 8;
const fingerprint = sourceFingerprint();
const resume = process.argv.includes('--resume');
const skipUaMemory = process.argv.includes('--skip-ua-memory');
const heavyCaseSampleFrames = readIntegerArgument('--heavy-frames=', sampleFrames);
const allowChangedSource = process.argv.includes('--resume-allow-source-change');
const rerunHtmlStatic = process.argv.includes('--rerun-html-static');
const rerunNative = process.argv.includes('--rerun-native');
const skipHeavyUaMemory = process.argv.includes('--skip-heavy-ua-memory');

if (!existsSync(browserPath)) throw new Error(`Chrome executable not found: ${browserPath}`);

mkdirSync(dirname(artifactPath), { recursive: true });
const server = await startHttpFixtureServer(root, { crossOriginIsolation: true });
const cases = resume
  ? loadCheckpoint(checkpointPath, fingerprint, allowChangedSource)
      .filter(item => !(rerunHtmlStatic && item.mode === 'html' && item.configuration.updateRatio === 0))
      .filter(item => !(rerunNative && item.mode === 'native'))
  : [];
try {
  for (const widgetCount of widgetCounts) {
    for (const updateRatio of updateRatios) {
      for (const mode of ['html', 'native']) {
        const id = `${mode}-${widgetCount}-${Math.round(updateRatio * 100)}pct`;
        if (cases.some(item => item.id === id)) {
          console.log(`[html-in-canvas-gui] ${id} (checkpoint)`);
          continue;
        }
        console.log(`[html-in-canvas-gui] ${id}`);
        cases.push(await runCase({ id, mode, widgetCount, updateRatio }));
        writeFileSync(checkpointPath, `${JSON.stringify({ fingerprint, cases }, null, 2)}\n`);
      }
    }
  }
} finally {
  await server.close();
}

const artifact = {
  schemaVersion: 1,
  suite: 'html-in-canvas-vs-haiyue-native-gui',
  generatedAt: new Date().toISOString(),
  mode: smoke ? 'smoke' : 'stress',
  browserPath,
  configuration: { widgetCounts, updateRatios, warmupFrames, sampleFrames, queueProbeFrames, viewport: [1280, 720] },
  sourceFingerprint: fingerprint,
  cases,
  comparisons: compareCases(cases),
};
writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`);
writeFileSync(reportPath, renderReport(artifact));
console.log(renderConsoleSummary(artifact));
console.log(`[html-in-canvas-gui] Wrote ${artifactPath}`);
console.log(`[html-in-canvas-gui] Wrote ${reportPath}`);

async function runCase({ id, mode, widgetCount, updateRatio }) {
  const profile = mkdtempSync(resolve(tmpdir(), 'haiyue-html-canvas-gui-'));
  let stderr = '';
  const child = spawn(browserPath, [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu-sandbox',
    '--enable-unsafe-webgpu',
    '--enable-experimental-web-platform-features',
    '--enable-blink-features=CanvasDrawElement',
    '--disable-backgrounding-occluded-windows',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--force-device-scale-factor=1',
    '--window-size=1280,720',
    '--use-angle=d3d11',
    '--js-flags=--expose-gc',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr += chunk; });
  let browserCdp;
  let pageCdp;
  try {
    const endpoint = await waitFor(
      () => /DevTools listening on (ws:\/\/[^\s]+)/u.exec(stderr)?.[1],
      20_000,
      'Chrome DevTools endpoint',
    );
    browserCdp = await connectCdp(endpoint, 600_000);
    const browserVersion = (await browserCdp.call('Browser.getVersion')).result;
    const page = await waitFor(async () => {
      const listUrl = `http://${new URL(endpoint).host}/json/list`;
      const targets = await fetch(listUrl).then(response => response.json()).catch(() => []);
      return targets.find(target => target.type === 'page');
    }, 20_000, 'Chrome page target');
    pageCdp = await connectCdp(page.webSocketDebuggerUrl, 600_000);
    await pageCdp.call('Runtime.enable');
    await pageCdp.call('Page.enable');
    await pageCdp.call('Performance.enable');
    await pageCdp.call('HeapProfiler.enable');
    const caseSampleFrames = mode === 'native' && widgetCount === 4096 && updateRatio === 1
      ? heavyCaseSampleFrames
      : sampleFrames;
    const query = new URLSearchParams({
      mode,
      widgets: widgetCount,
      updateRatio,
      warmup: warmupFrames,
      frames: caseSampleFrames,
      queueProbes: queueProbeFrames,
      width: 1280,
      height: 720,
    });
    await pageCdp.call('Page.navigate', {
      url: `${server.origin}/experiments/html-in-canvas-gui/index.html?${query}`,
    });
    await waitFor(async () => {
      const response = await pageCdp.call('Runtime.evaluate', {
        expression: 'document.readyState === "complete" && Boolean(window.__benchmarkReady)',
        returnByValue: true,
      });
      return response.result?.result?.value === true;
    }, 30_000, 'benchmark readiness');
    if (skipUaMemory || (skipHeavyUaMemory && mode === 'native' && widgetCount === 4096 && updateRatio === 1)) {
      await pageCdp.call('Runtime.evaluate', {
        expression: 'Object.defineProperty(performance, "measureUserAgentSpecificMemory", { value: undefined, configurable: true })',
      });
    }
    await pageCdp.call('HeapProfiler.collectGarbage');
    const performanceBefore = await readPerformanceMetrics(pageCdp);
    const domBefore = (await pageCdp.call('Memory.getDOMCounters')).result;
    const processBefore = await readProcessInfo(browserCdp);
    const evaluation = await pageCdp.call('Runtime.evaluate', {
      expression: 'window.__runGuiBenchmark()',
      awaitPromise: true,
      returnByValue: true,
    }, 600_000);
    if (evaluation.result?.exceptionDetails) {
      throw new Error(evaluation.result.exceptionDetails.exception?.description ?? evaluation.result.exceptionDetails.text);
    }
    const result = evaluation.result?.result?.value;
    if (!result || result.status !== 'passed') throw new Error(`Benchmark failed: ${JSON.stringify(result)}`);
    const processAfter = await readProcessInfo(browserCdp);
    const domAfter = (await pageCdp.call('Memory.getDOMCounters')).result;
    const performanceAfter = await readPerformanceMetrics(pageCdp);
    return {
      id,
      ...result,
      chrome: {
        product: browserVersion.product,
        revision: browserVersion.revision,
        jsVersion: browserVersion.jsVersion,
        protocolVersion: browserVersion.protocolVersion,
        blinkFeatureForced: 'CanvasDrawElement',
      },
      cdp: {
        performanceDelta: metricDelta(performanceBefore, performanceAfter),
        domBefore,
        domAfter,
        processCpuSeconds: processCpuDelta(processBefore, processAfter),
      },
    };
  } catch (error) {
    error.message = `${id}: ${error.message}\nChrome stderr tail:\n${stderr.slice(-8000)}`;
    throw error;
  } finally {
    try { await browserCdp?.call('Browser.close', {}, 5_000); } catch {}
    pageCdp?.close();
    browserCdp?.close();
    if (!(await waitForExit(child, 5_000))) child.kill();
    await removeChromeProfile(profile).catch(error => console.warn(`[html-in-canvas-gui] ${error.message}`));
  }
}

function compareCases(results) {
  const comparisons = [];
  for (const html of results.filter(item => item.mode === 'html')) {
    const native = results.find(item => item.mode === 'native'
      && item.configuration.widgetCount === html.configuration.widgetCount
      && item.configuration.updateRatio === html.configuration.updateRatio);
    if (!native) continue;
    comparisons.push({
      widgetCount: html.configuration.widgetCount,
      updateRatio: html.configuration.updateRatio,
      html: comparisonChannels(html),
      native: comparisonChannels(native),
      ratios: {
        fpsHtmlOverNative: safeRatio(html.timing.effectiveFps, native.timing.effectiveFps),
        taskCpuHtmlOverNative: safeRatio(
          html.cdp.performanceDelta.TaskDuration,
          native.cdp.performanceDelta.TaskDuration,
        ),
        setupMemoryHtmlOverNative: safeRatio(
          html.memory.setupUaBytesDelta,
          native.memory.setupUaBytesDelta,
        ),
        gpuP95HtmlOverNative: safeRatio(
          html.timing.gpuRenderPassMs?.p95,
          native.timing.gpuRenderPassMs?.p95,
        ),
      },
    });
  }
  return comparisons.sort((left, right) => (
    left.widgetCount - right.widgetCount || left.updateRatio - right.updateRatio
  ));
}

function comparisonChannels(item) {
  return {
    fps: item.timing.effectiveFps,
    frameP95Ms: item.timing.frameIntervalMs.p95,
    missedFrameRatio: item.timing.missedFrameRatio,
    callbackP95Ms: item.timing.callbackCpuMs.p95,
    gpuP95Ms: item.timing.gpuRenderPassMs?.p95 ?? null,
    queueP95Ms: item.timing.endToEndQueueCompletionMs.p95,
    taskCpuSeconds: item.cdp.performanceDelta.TaskDuration ?? null,
    scriptCpuSeconds: item.cdp.performanceDelta.ScriptDuration ?? null,
    layoutCpuSeconds: item.cdp.performanceDelta.LayoutDuration ?? null,
    recalcStyleCpuSeconds: item.cdp.performanceDelta.RecalcStyleDuration ?? null,
    rendererProcessCpuSeconds: item.cdp.processCpuSeconds.renderer ?? null,
    gpuProcessCpuSeconds: item.cdp.processCpuSeconds.GPU ?? item.cdp.processCpuSeconds.gpu ?? null,
    setupUaBytesDelta: item.memory.setupUaBytesDelta,
    setupJsHeapBytesDelta: item.memory.setupJsHeapBytesDelta,
    explicitGpuTextureBytes: item.resources.explicitGpuTextureBytes,
    retainedCpuGeometryBytes: item.resources.retainedCpuGeometryBytes,
  };
}

function renderReport(artifact) {
  const browser = artifact.cases[0]?.chrome.product ?? 'unknown';
  const adapterInfo = artifact.cases[0]?.adapter ?? {};
  const adapter = adapterInfo.description || adapterInfo.device
    || [adapterInfo.vendor, adapterInfo.architecture].filter(Boolean).join(' / ')
    || 'unknown';
  const lines = [
    '# HTML-in-Canvas versus Haiyue native GUI',
    '',
    `Generated: ${artifact.generatedAt}`,
    '',
    `Browser: ${browser}`,
    '',
    `Adapter: ${adapter}`,
    '',
    '| Widgets | Updates/frame | HTML FPS | Native FPS | HTML frame p95 | Native frame p95 | HTML task CPU | Native task CPU | HTML setup memory | Native setup memory | HTML GPU p95 | Native GPU p95 |',
    '|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
  ];
  for (const item of artifact.comparisons) {
    lines.push(`| ${item.widgetCount} | ${formatPercent(item.updateRatio)} | ${formatNumber(item.html.fps)} | ${formatNumber(item.native.fps)} | ${formatMs(item.html.frameP95Ms)} | ${formatMs(item.native.frameP95Ms)} | ${formatSeconds(item.html.taskCpuSeconds)} | ${formatSeconds(item.native.taskCpuSeconds)} | ${formatBytes(item.html.setupUaBytesDelta)} | ${formatBytes(item.native.setupUaBytesDelta)} | ${formatMs(item.html.gpuP95Ms)} | ${formatMs(item.native.gpuP95Ms)} |`);
  }
  lines.push(
    '',
    '## Measurement boundaries',
    '',
    '- HTML GPU timestamps cover the WebGPU sampling pass, not Chromium DOM rasterization or the HTML-to-texture upload.',
    '- End-to-end queue completion, Chrome process CPU, layout/style CPU, and frame cadence include the practical upload impact.',
    '- Setup memory is the user-agent-specific memory delta where supported; JS heap and explicit resource bytes remain in the JSON artifact.',
    '- Total VRAM use and hardware GPU utilization are not exposed by portable browser APIs.',
    '- `CanvasDrawElement` is forced on the command line so the same harness can run against pre-stable and stable implementations; the exact browser product is recorded above.',
    ...(artifact.cases.some(item => item.configuration.sampleFrames !== artifact.configuration.sampleFrames)
      ? ['- Non-realtime heavy cases may use fewer measured frames; the exact `sampleFrames` value is preserved in each JSON case.']
      : []),
    '',
  );
  return `${lines.join('\n')}\n`;
}

function renderConsoleSummary(artifact) {
  const lines = ['[html-in-canvas-gui] Comparison'];
  for (const item of artifact.comparisons) {
    lines.push(
      `${item.widgetCount} widgets ${formatPercent(item.updateRatio)} updates: `
      + `HTML ${formatNumber(item.html.fps)} fps / Native ${formatNumber(item.native.fps)} fps; `
      + `task CPU ${formatSeconds(item.html.taskCpuSeconds)} / ${formatSeconds(item.native.taskCpuSeconds)}; `
      + `setup memory ${formatBytes(item.html.setupUaBytesDelta)} / ${formatBytes(item.native.setupUaBytesDelta)}`,
    );
  }
  return lines.join('\n');
}

async function readPerformanceMetrics(cdp) {
  const response = await cdp.call('Performance.getMetrics');
  return Object.fromEntries((response.result?.metrics ?? []).map(item => [item.name, item.value]));
}

async function readProcessInfo(cdp) {
  const response = await cdp.call('SystemInfo.getProcessInfo');
  return response.result?.processInfo ?? [];
}

function metricDelta(before, after) {
  const result = {};
  for (const [name, value] of Object.entries(after)) {
    if (Number.isFinite(before[name]) && Number.isFinite(value)) result[name] = value - before[name];
  }
  return result;
}

function processCpuDelta(before, after) {
  const previous = new Map(before.map(item => [item.id, item]));
  const totals = {};
  for (const item of after) {
    const earlier = previous.get(item.id);
    if (!earlier || !Number.isFinite(item.cpuTime) || !Number.isFinite(earlier.cpuTime)) continue;
    totals[item.type] = (totals[item.type] ?? 0) + item.cpuTime - earlier.cpuTime;
  }
  return totals;
}

function sourceFingerprint() {
  const hash = createHash('sha256');
  for (const path of [
    resolve(root, 'experiments/html-in-canvas-gui/index.html'),
    resolve(root, 'experiments/html-in-canvas-gui/benchmark.mjs'),
    resolve(root, 'engine/dist/gui.js'),
  ]) {
    hash.update(path.slice(root.length));
    hash.update(readFileSync(path));
  }
  return hash.digest('hex');
}

function loadCheckpoint(path, expectedFingerprint, allowMismatch = false) {
  if (!existsSync(path)) return [];
  try {
    const checkpoint = JSON.parse(readFileSync(path, 'utf8'));
    if ((!allowMismatch && checkpoint.fingerprint !== expectedFingerprint) || !Array.isArray(checkpoint.cases)) return [];
    return checkpoint.cases;
  } catch {
    return [];
  }
}

function resolveBrowserPath() {
  const inline = process.argv.find(argument => argument.startsWith('--browser='));
  return resolve(inline?.slice('--browser='.length) || process.env.CHROME_PATH || defaultChromePath());
}

function readIntegerArgument(prefix, fallback) {
  const inline = process.argv.find(argument => argument.startsWith(prefix));
  const value = Number(inline?.slice(prefix.length));
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function safeRatio(numerator, denominator) {
  return Number.isFinite(numerator) && Number.isFinite(denominator) && denominator !== 0 ? numerator / denominator : null;
}

function formatNumber(value) { return Number.isFinite(value) ? value.toFixed(1) : 'n/a'; }
function formatMs(value) { return Number.isFinite(value) ? `${value.toFixed(2)} ms` : 'n/a'; }
function formatSeconds(value) { return Number.isFinite(value) ? `${value.toFixed(3)} s` : 'n/a'; }
function formatPercent(value) { return `${Math.round(value * 100)}%`; }
function formatBytes(value) { return Number.isFinite(value) ? `${(value / 1048576).toFixed(1)} MiB` : 'n/a'; }

async function waitFor(read, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await new Promise(resolveWait => setTimeout(resolveWait, 100));
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null) return Promise.resolve(true);
  return new Promise(resolveExit => {
    const timeout = setTimeout(() => {
      child.off('exit', onExit);
      resolveExit(false);
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timeout);
      resolveExit(true);
    };
    child.once('exit', onExit);
  });
}

function connectCdp(url, defaultCallTimeoutMs) {
  return new Promise((resolveConnect, reject) => {
    const socket = new WebSocket(url);
    const pending = new Map();
    let nextId = 0;
    socket.addEventListener('error', () => reject(new Error(`Could not connect to Chrome DevTools at ${url}.`)), { once: true });
    socket.addEventListener('open', () => resolveConnect({
      call(method, params = {}, callTimeoutMs = defaultCallTimeoutMs) {
        return new Promise((resolveCall, rejectCall) => {
          const id = ++nextId;
          const timeout = setTimeout(() => {
            pending.delete(id);
            rejectCall(new Error(`Chrome DevTools call timed out: ${method}`));
          }, callTimeoutMs);
          pending.set(id, { resolveCall, rejectCall, timeout });
          socket.send(JSON.stringify({ id, method, params }));
        });
      },
      close() { socket.close(); },
    }), { once: true });
    socket.addEventListener('message', event => {
      const message = JSON.parse(String(event.data));
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      clearTimeout(request.timeout);
      if (message.error) request.rejectCall(new Error(message.error.message));
      else request.resolveCall(message);
    });
    socket.addEventListener('close', () => {
      for (const request of pending.values()) {
        clearTimeout(request.timeout);
        request.rejectCall(new Error('Chrome DevTools connection closed.'));
      }
      pending.clear();
    });
  });
}
