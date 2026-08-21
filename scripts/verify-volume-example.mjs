import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import {
  defaultChromePath,
  defaultWebGpuAngleBackend,
  startHttpFixtureServer,
} from './webgpu-gate/chrome-runner.mjs';
import {
  compareVolumePixelRecords,
  resolveVolumePixelCandidateMode,
} from './volume-example-pixel-policy.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const baselinePath = resolve(root, 'review/baselines/render-pixels-volume.json');
const chrome = process.env.CHROME_PATH ?? defaultChromePath();
const bundlePath = resolve(root, 'examples/ktx2-volume/bundle.js');
if (!existsSync(chrome)) throw new Error(`Volume pixel verification requires Chrome at ${chrome}.`);
if (!existsSync(bundlePath)) throw new Error('Build example:ktx2-volume before Volume pixel verification.');

const fixtureServer = await startHttpFixtureServer(root);
const url = new URL('/examples/ktx2-volume/index.html', fixtureServer.origin);
url.searchParams.set('verify', '1');
let capture;
try {
  capture = await captureVolume(chrome, url.href);
} finally {
  await fixtureServer.close();
}
const png = Buffer.from(capture.data, 'base64');
const candidateMode = resolveVolumePixelCandidateMode();
const current = {
  schemaVersion: 1,
  fixture: 'haiyue-ktx2-volume-storage-table-chrome-960x640',
  width: png.readUInt32BE(16),
  height: png.readUInt32BE(20),
  hash: createHash('sha256').update(png).digest('hex'),
  bytes: png.byteLength,
  coverage: capture.coverage,
};
if (current.width !== 960 || current.height !== 640) {
  throw new Error(`Volume screenshot dimensions changed: expected 960x640, received ${current.width}x${current.height}.`);
}
if (current.bytes < 5_000) throw new Error(`Volume screenshot is unexpectedly empty (${current.bytes} bytes).`);

if (process.env.UPDATE_VOLUME_EXAMPLE_BASELINE === '1') {
  if (candidateMode.enabled) {
    throw new Error('Volume baseline update and candidate retention are mutually exclusive.');
  }
  writeFileSync(baselinePath, `${JSON.stringify(current, null, 2)}\n`);
  console.log(`[volume-example] Updated ${baselinePath}.`);
} else {
  const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
  const mismatches = compareVolumePixelRecords(current, baseline);
  const candidate = {
    ...current,
    evidence: {
      revision: git(['rev-parse', 'HEAD']),
      dirty: Boolean(git(['status', '--porcelain'])),
      browser: capture.browser,
      transport: 'http',
      sources: [
        sourceRecord('examples/ktx2-volume/index.html'),
        sourceRecord('examples/shared/engine.js'),
        sourceRecord('examples/ktx2-volume/bundle.js'),
      ],
    },
    baselineComparison: {
      status: mismatches.length === 0 ? 'passed' : 'candidate-diff',
      baseline: 'review/baselines/render-pixels-volume.json',
      mismatches,
    },
  };
  if (candidateMode.enabled) writeCandidateArtifacts(candidateMode.directory, candidate, png);
  if (mismatches.length > 0) {
    if (!candidateMode.enabled) throw new Error(mismatches.join('\n'));
    console.warn(
      `[volume-example] Retained ${mismatches.length} exact HTTP pixel mismatch(es) as candidate diff; `
      + 'the reviewed baseline was not changed.',
    );
  } else {
    console.log(`[volume-example] Storage-table raymarch pixels passed: ${current.hash.slice(0, 16)}…, ${current.bytes} bytes.`);
  }
}

function writeCandidateArtifacts(requestedDirectory, result, image) {
  const directory = resolve(root, requestedDirectory);
  mkdirSync(directory, { recursive: true });
  writeFileSync(resolve(directory, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
  writeFileSync(resolve(directory, 'volume.png'), image);
  console.log(`[volume-example] Wrote candidate diagnostics to ${directory}.`);
}

function sourceRecord(path) {
  const bytes = readFileSync(resolve(root, path));
  return {
    path,
    bytes: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

async function captureVolume(binary, pageUrl) {
  const profile = mkdtempSync(resolve(tmpdir(), 'haiyue-volume-example-'));
  const child = spawn(binary, [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu-sandbox',
    '--enable-unsafe-webgpu',
    `--use-angle=${process.env.WEBGPU_ANGLE_BACKEND ?? defaultWebGpuAngleBackend()}`,
    '--window-size=960,640',
    '--force-device-scale-factor=1',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.resume();
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr += chunk; });
  try {
    const endpoint = await waitFor(
      () => /DevTools listening on (ws:\/\/[^\s]+)/.exec(stderr)?.[1],
      15_000,
      'Chrome endpoint',
    );
    const listUrl = `http://${new URL(endpoint).host}/json/list`;
    const page = await waitFor(
      async () => (await fetch(listUrl).then(response => response.json()).catch(() => []))
        .find(item => item.type === 'page' && item.url === 'about:blank'),
      15_000,
      'Volume page',
    );
    const cdp = await connectCdp(page.webSocketDebuggerUrl);
    try {
      await cdp.call('Emulation.setDeviceMetricsOverride', {
        width: 960,
        height: 640,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await cdp.call('Page.navigate', { url: pageUrl });
      const status = await waitFor(async () => {
        const response = await cdp.call('Runtime.evaluate', {
          expression: `({
            status: document.body.dataset.volumeRenderStatus,
            error: document.body.dataset.volumeRenderError,
            coverage: document.body.dataset.volumeShaderCoverage
          })`,
          returnByValue: true,
        });
        const value = response.result?.result?.value;
        return value?.status ? value : null;
      }, 25_000, 'Volume WebGPU render');
      if (status.status !== 'passed') {
        throw new Error(`Volume WebGPU render failed: ${status.error || 'unknown error'}\n${stderr}`);
      }
      const expectedCoverage = 'storage-object-table,raymarch,bounds,volume-params';
      if (status.coverage !== expectedCoverage) {
        throw new Error(`Volume shader coverage changed: expected ${expectedCoverage}, received ${status.coverage || 'none'}.`);
      }
      await cdp.call('Runtime.evaluate', {
        expression: `new Promise(resolve => {
          let remaining = 5;
          const next = () => requestAnimationFrame(() => --remaining === 0 ? resolve() : next());
          next();
        })`,
        awaitPromise: true,
        returnByValue: true,
      });
      const browser = (await cdp.call('Browser.getVersion')).result?.product ?? 'unknown';
      const screenshot = (await cdp.call('Page.captureScreenshot', {
        format: 'png',
        captureBeyondViewport: false,
      })).result;
      return { ...screenshot, coverage: status.coverage, browser };
    } finally {
      await cdp.call('Browser.close').catch(() => {});
      cdp.close();
    }
  } finally {
    if (child.exitCode === null) child.kill('SIGTERM');
    try {
      rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {}
  }
}

function git(args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed while recording Volume candidate provenance.`);
  return result.stdout.trim();
}

async function waitFor(read, timeout, label) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await new Promise(resolveWait => setTimeout(resolveWait, 100));
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

function connectCdp(url) {
  return new Promise((resolveConnect, reject) => {
    const socket = new WebSocket(url);
    const pending = new Map();
    let nextId = 0;
    socket.addEventListener(
      'error',
      () => reject(new Error(`Could not connect to ${url}.`)),
      { once: true },
    );
    socket.addEventListener('open', () => resolveConnect({
      call(method, params = {}) {
        return new Promise((resolveCall, rejectCall) => {
          const id = ++nextId;
          pending.set(id, { resolveCall, rejectCall });
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
      if (message.error) request.rejectCall(new Error(message.error.message));
      else request.resolveCall(message);
    });
  });
}
