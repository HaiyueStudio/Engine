import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import {
  defaultChromePath,
  defaultWebGpuAngleBackend,
  startHttpFixtureServer,
} from './webgpu-gate/chrome-runner.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const baselinePath = resolve(root, 'review/baselines/render-pixels-fog.json');
const chrome = process.env.CHROME_PATH ?? defaultChromePath();
if (!existsSync(chrome)) throw new Error(`Fog product verification requires Chrome at ${chrome}.`);
if (!existsSync(resolve(root, 'examples/fog/bundle.js'))) {
  throw new Error('Build example:fog before Fog product verification.');
}

const fixtureServer = await startHttpFixtureServer(root);
let baseUrl;
try {
baseUrl = new URL('/examples/fog/index.html', fixtureServer.origin);
const cases = {
  distance: exampleUrl({ mode: 'distance', regression: '1' }),
  height: exampleUrl({ mode: 'height', regression: '1' }),
  noFog: exampleUrl({ mode: 'distance', fog: 'none', regression: '1' }),
  disabled: exampleUrl({ mode: 'distance', fog: 'disabled', regression: '1' }),
  maxOpacityZero: exampleUrl({ mode: 'distance', maxOpacity: '0', regression: '1' }),
};
const captures = await captureCases(chrome, cases);
const current = {
  schemaVersion: 1,
  fixture: 'haiyue-distance-height-fog-chrome-960x640',
  width: 960,
  height: 640,
  rendererValidation: ['basic', 'pbr', 'blinn', 'instanced'],
  modes: {
    distance: pixelRecord(captures.distance),
    height: pixelRecord(captures.height),
  },
  noFogEquivalence: {
    noFog: pixelRecord(captures.noFog),
    disabled: pixelRecord(captures.disabled),
    maxOpacityZero: pixelRecord(captures.maxOpacityZero),
  },
};

assertEquivalent(current.noFogEquivalence.noFog, current.noFogEquivalence.disabled, 'disabled Fog');
assertEquivalent(current.noFogEquivalence.noFog, current.noFogEquivalence.maxOpacityZero, 'maxOpacity=0 Fog');

if (process.env.UPDATE_FOG_BASELINE === '1') {
  writeFileSync(baselinePath, `${JSON.stringify(current, null, 2)}\n`);
  console.log(`[fog-example] Updated ${baselinePath}.`);
} else {
  if (!existsSync(baselinePath)) {
    throw new Error('Fog pixel baseline is missing. Run with UPDATE_FOG_BASELINE=1 after reviewing both modes.');
  }
  const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
  for (const key of ['schemaVersion', 'fixture', 'width', 'height']) {
    if (current[key] !== baseline[key]) {
      throw new Error(`Fog pixel regression at ${key}: expected ${baseline[key]}, received ${current[key]}.`);
    }
  }
  if (JSON.stringify(current.rendererValidation) !== JSON.stringify(baseline.rendererValidation)) {
    throw new Error('Fog renderer shader validation coverage changed.');
  }
  const mismatches = [];
  for (const mode of ['distance', 'height']) compareRecord(current.modes[mode], baseline.modes?.[mode], mode, mismatches);
  for (const state of ['noFog', 'disabled', 'maxOpacityZero']) {
    compareRecord(current.noFogEquivalence[state], baseline.noFogEquivalence[state], state, mismatches);
  }
  current.baselineComparison = {
    status: mismatches.length === 0 ? 'passed' : 'candidate-diff',
    baseline: 'review/baselines/render-pixels-fog.json',
    mismatches,
  };
  writeCandidateArtifacts(current, captures);
  if (mismatches.length > 0) {
    if (process.env.FOG_CANDIDATE_DIFF !== '1' || !process.env.FOG_CANDIDATE_DIR) {
      throw new Error(`Fog pixel regression:\n${mismatches.join('\n')}`);
    }
    console.warn(
      `[fog-example] Retained ${mismatches.length} exact HTTP pixel mismatch(es) as candidate diff; `
      + 'the reviewed baseline was not changed.',
    );
  } else {
    console.log(
      `[fog-example] Distance ${current.modes.distance.hash.slice(0, 16)}…, height ${current.modes.height.hash.slice(0, 16)}…, `
      + 'four renderer shaders valid; disabled/maxOpacity=0 match no Fog.',
    );
  }
}
} finally {
  await fixtureServer.close();
}

function exampleUrl(parameters) {
  const url = new URL(baseUrl);
  for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, value);
  return url.href;
}

function pixelRecord(capture) {
  const png = Buffer.from(capture.data, 'base64');
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  if (width !== 960 || height !== 640) {
    throw new Error(`Fog screenshot dimensions changed: expected 960x640, received ${width}x${height}.`);
  }
  return {
    hash: createHash('sha256').update(png).digest('hex'),
    bytes: png.byteLength,
  };
}

function assertEquivalent(expected, actual, label) {
  if (expected.hash !== actual.hash || expected.bytes !== actual.bytes) {
    throw new Error(`${label} output differs from the no-Fog output.`);
  }
}

function compareRecord(currentRecord, baselineRecord, label, mismatches) {
  for (const key of ['hash', 'bytes']) {
    if (currentRecord[key] !== baselineRecord?.[key]) {
      mismatches.push(`Fog pixel regression at ${label}.${key}: expected ${baselineRecord?.[key]}, received ${currentRecord[key]}.`);
    }
  }
}

function writeCandidateArtifacts(result, caseCaptures) {
  const requested = process.env.FOG_CANDIDATE_DIR;
  if (!requested) return;
  const directory = resolve(root, requested);
  mkdirSync(directory, { recursive: true });
  writeFileSync(resolve(directory, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
  for (const [name, capture] of Object.entries(caseCaptures)) {
    writeFileSync(resolve(directory, `${name}.png`), Buffer.from(capture.data, 'base64'));
  }
  console.log(`[fog-example] Wrote candidate diagnostics to ${directory}.`);
}

async function captureCases(binary, urls) {
  const captures = {};
  for (const [name, url] of Object.entries(urls)) {
    captures[name] = await capture(binary, url, name);
  }
  return captures;
}

async function capture(binary, url, name) {
  const profile = mkdtempSync(resolve(tmpdir(), 'haiyue-fog-example-'));
  const angleBackend = process.env.WEBGPU_ANGLE_BACKEND ?? defaultWebGpuAngleBackend();
  const child = spawn(binary, [
    '--headless=new', '--no-sandbox', '--disable-gpu-sandbox', '--enable-unsafe-webgpu', `--use-angle=${angleBackend}`,
    '--window-size=960,640', '--force-device-scale-factor=1',
    '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.resume();
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr += chunk; });
  try {
    const endpoint = await waitFor(() => /DevTools listening on (ws:\/\/[^\s]+)/.exec(stderr)?.[1], 15_000, 'Chrome endpoint');
    const listUrl = `http://${new URL(endpoint).host}/json/list`;
    const page = await waitFor(async () => {
      const targets = await fetch(listUrl).then(response => response.json()).catch(() => []);
      return targets.find(item => item.type === 'page' && item.url === 'about:blank');
    }, 15_000, 'Fog page');
    const cdp = await connectCdp(page.webSocketDebuggerUrl);
    try {
      await cdp.call('Emulation.setDeviceMetricsOverride', {
        width: 960,
        height: 640,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await cdp.call('Page.navigate', { url });
      const status = await waitFor(async () => {
        const response = await cdp.call('Runtime.evaluate', {
          expression: `({ status: document.body.dataset.renderStatus, error: document.body.dataset.renderError, coverage: document.body.dataset.fogShaderValidation })`,
          returnByValue: true,
        });
        const value = response.result?.result?.value;
        return value?.status ? value : null;
      }, 25_000, `Fog ${name} GPU validation`);
      if (status.status !== 'passed') {
        throw new Error(`Fog ${name} GPU validation failed: ${status.error || 'unknown error'}\n${stderr}`);
      }
      if (status.coverage !== 'basic,pbr,blinn,instanced') {
        throw new Error(`Fog ${name} did not validate all renderer shaders: ${status.coverage || 'none'}.`);
      }
      // The validation marker is produced after GPU work, but ResizeObserver
      // delivery can still trail it by one browser frame when the fixture is
      // loaded over HTTP. Capture only after the viewport has settled so the
      // exact pixel gate is independent of transport scheduling.
      await cdp.call('Runtime.evaluate', {
        expression: `new Promise(resolve => {
          let remaining = 5;
          const next = () => requestAnimationFrame(() => --remaining === 0 ? resolve() : next());
          next();
        })`,
        awaitPromise: true,
        returnByValue: true,
      });
      return (await cdp.call('Page.captureScreenshot', {
        format: 'png',
        captureBeyondViewport: false,
      })).result;
    } finally {
      await cdp.call('Browser.close').catch(() => {});
      cdp.close();
    }
  } finally {
    if (child.exitCode === null) child.kill('SIGTERM');
    try { rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch {}
  }
}

async function waitFor(read, timeout, label) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await new Promise(accept => setTimeout(accept, 100));
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

function connectCdp(url) {
  return new Promise((accept, reject) => {
    const socket = new WebSocket(url);
    const pending = new Map();
    let id = 0;
    socket.addEventListener('error', () => reject(new Error(`Could not connect to ${url}.`)), { once: true });
    socket.addEventListener('open', () => accept({
      call(method, params = {}) {
        return new Promise((resolveCall, rejectCall) => {
          const requestId = ++id;
          pending.set(requestId, { resolveCall, rejectCall });
          socket.send(JSON.stringify({ id: requestId, method, params }));
        });
      },
      close() { socket.close(); },
    }), { once: true });
    socket.addEventListener('message', event => {
      const message = JSON.parse(String(event.data));
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      if (message.error) request.rejectCall(new Error(message.error.message));
      else request.resolveCall(message);
    });
  });
}
