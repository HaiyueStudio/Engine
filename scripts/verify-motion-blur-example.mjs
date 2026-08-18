import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { inflateSync } from 'node:zlib';
import { defaultChromePath, defaultWebGpuAngleBackend } from './webgpu-gate/chrome-runner.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const chrome = process.env.CHROME_PATH ?? defaultChromePath();
if (!existsSync(chrome)) throw new Error(`Motion blur pixel verification requires Chrome at ${chrome}.`);
if (!existsSync(resolve(root, 'examples/motion-blur/bundle.js'))) {
  throw new Error('Build example:motion-blur before motion blur pixel verification.');
}

const server = createStaticServer(root);
await new Promise((accept, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', accept);
});

try {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not allocate motion blur fixture port.');
  const base = `http://127.0.0.1:${address.port}/examples/motion-blur/`;
  const cases = {
    raw: `${base}?regression=1&blur=off&case=raw`,
    centered: `${base}?regression=1&mode=blur&intensity=2.75&reconstruction=centered&case=centered`,
    reconstructed: `${base}?regression=1&mode=blur&intensity=2.75&reconstruction=tile-neighbor-max&case=reconstructed`,
    velocity: `${base}?regression=1&mode=velocity&intensity=2.75&reconstruction=tile-neighbor-max&case=velocity`,
    split: `${base}?regression=1&mode=split&intensity=2.75&reconstruction=tile-neighbor-max&case=split`,
  };
  const captures = await captureCases(chrome, cases);
  const rawVsCentered = comparePixels(captures.raw.pixels, captures.centered.pixels);
  const rawVsReconstructed = comparePixels(captures.raw.pixels, captures.reconstructed.pixels);
  const centeredVsReconstructed = comparePixels(captures.centered.pixels, captures.reconstructed.pixels);
  const rawVsVelocity = comparePixels(captures.raw.pixels, captures.velocity.pixels);
  const pipelineWarmupSamplesMs = Object.entries(captures)
    .filter(([name]) => name !== 'raw')
    .map(([, capture]) => capture.result.pipelineWarmupMs)
    .sort((left, right) => left - right);

  assertDifference(rawVsCentered, { changedPixelRatio: 0.01, meanAbsoluteDifference: 0.4 }, 'raw vs centered blur');
  assertDifference(rawVsReconstructed, { changedPixelRatio: 0.025, meanAbsoluteDifference: 0.75 }, 'raw vs tile/neighbor blur');
  assertDifference(centeredVsReconstructed, { changedPixelRatio: 0.002, meanAbsoluteDifference: 0.05 }, 'centered vs tile/neighbor reconstruction');
  assertDifference(rawVsVelocity, { changedPixelRatio: 0.25, meanAbsoluteDifference: 8 }, 'raw vs velocity heatmap');
  if (captures.split.result.mode !== 'split') throw new Error('Split display mode did not reach the browser fixture.');

  console.log(JSON.stringify({
    fixture: 'haiyue-motion-blur-chrome-500x560',
    rawVsCentered,
    rawVsReconstructed,
    centeredVsReconstructed,
    rawVsVelocity,
    pipelineWarmup: {
      samplesMs: pipelineWarmupSamplesMs,
      p50Ms: percentile(pipelineWarmupSamplesMs, 0.5),
      p95Ms: percentile(pipelineWarmupSamplesMs, 0.95),
    },
    coverage: captures.reconstructed.result.coverage,
  }, null, 2));
} finally {
  const closed = new Promise(accept => server.close(accept));
  server.closeAllConnections();
  await closed;
}

async function captureCases(binary, cases) {
  const profile = mkdtempSync(resolve(tmpdir(), 'haiyue-motion-blur-'));
  const angleBackend = process.env.WEBGPU_ANGLE_BACKEND ?? defaultWebGpuAngleBackend();
  const child = spawn(binary, [
    '--headless=new', '--no-sandbox', '--disable-gpu-sandbox', '--enable-unsafe-webgpu',
    `--use-angle=${angleBackend}`, '--window-size=960,640', '--force-device-scale-factor=1',
    '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.resume();
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr += chunk; });
  try {
    const endpoint = await waitFor(() => /DevTools listening on (ws:\/\/[^\s]+)/.exec(stderr)?.[1], 20_000, 'Chrome endpoint');
    const listUrl = `http://${new URL(endpoint).host}/json/list`;
    const page = await waitFor(async () => {
      const targets = await fetch(listUrl).then(response => response.json()).catch(() => []);
      return targets.find(target => target.type === 'page' && target.url === 'about:blank');
    }, 20_000, 'motion blur page');
    const cdp = await connectCdp(page.webSocketDebuggerUrl);
    try {
      await cdp.call('Emulation.setDeviceMetricsOverride', {
        width: 960,
        height: 640,
        deviceScaleFactor: 1,
        mobile: false,
      });
      const captures = {};
      for (const [name, url] of Object.entries(cases)) captures[name] = await captureCase(cdp, url, name, stderr);
      return captures;
    } finally {
      await cdp.call('Browser.close').catch(() => {});
      cdp.close();
    }
  } finally {
    if (child.exitCode === null) child.kill('SIGTERM');
    try { rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch {}
  }
}

async function captureCase(cdp, url, name, stderr) {
  await cdp.call('Page.navigate', { url });
  const fixture = await waitFor(async () => {
    try {
      const response = await cdp.call('Runtime.evaluate', {
        expression: `(() => {
          const result = document.querySelector('#result');
          return location.href.includes('case=${name}') && result?.dataset.status
            ? { status: result.dataset.status, text: result.textContent, error: document.body.dataset.renderError }
            : null;
        })()`,
        returnByValue: true,
      });
      return response.result?.result?.value ?? null;
    } catch (error) {
      if (error instanceof Error && error.message.includes('execution context')) return null;
      throw error;
    }
  }, 35_000, `motion blur ${name} result`);
  if (fixture.status !== 'passed') throw new Error(`Motion blur ${name} failed: ${fixture.error || fixture.text}\n${stderr}`);
  const result = JSON.parse(fixture.text);
  const expectedMode = name === 'reconstructed' || name === 'centered' ? 'blur' : name;
  if (result.mode !== expectedMode) throw new Error(`Motion blur ${name} reported mode ${result.mode}, expected ${expectedMode}.`);
  if (result.characterJoints !== 19) throw new Error(`Motion blur ${name} did not load the 19-joint glTF character.`);
  if (!Number.isFinite(result.pipelineWarmupMs) || result.pipelineWarmupMs < 0) {
    throw new Error(`Motion blur ${name} reported invalid pipelineWarmupMs ${result.pipelineWarmupMs}.`);
  }
  if (!String(result.coverage).includes('tile-neighbor-max')) throw new Error(`Motion blur ${name} coverage is incomplete.`);
  const screenshot = await cdp.call('Page.captureScreenshot', {
    format: 'png',
    clip: { x: 440, y: 40, width: 500, height: 560, scale: 1 },
    captureBeyondViewport: false,
  });
  return { result, pixels: decodePng(Buffer.from(screenshot.result.data, 'base64')) };
}

function comparePixels(left, right) {
  if (left.width !== right.width || left.height !== right.height) throw new Error('Motion blur captures have different dimensions.');
  let absoluteDifference = 0;
  let changedPixels = 0;
  for (let index = 0; index < left.data.length; index += 4) {
    const difference = Math.abs(left.data[index] - right.data[index])
      + Math.abs(left.data[index + 1] - right.data[index + 1])
      + Math.abs(left.data[index + 2] - right.data[index + 2]);
    absoluteDifference += difference;
    if (difference >= 12) changedPixels++;
  }
  const pixelCount = left.width * left.height;
  return {
    changedPixelRatio: changedPixels / pixelCount,
    meanAbsoluteDifference: absoluteDifference / (pixelCount * 3),
  };
}

function assertDifference(actual, minimum, label) {
  if (actual.changedPixelRatio < minimum.changedPixelRatio || actual.meanAbsoluteDifference < minimum.meanAbsoluteDifference) {
    throw new Error(
      `${label} is not visually distinct enough: changed ${(actual.changedPixelRatio * 100).toFixed(2)}%, `
      + `mean ${actual.meanAbsoluteDifference.toFixed(3)}; expected at least ${(minimum.changedPixelRatio * 100).toFixed(2)}% and ${minimum.meanAbsoluteDifference}.`,
    );
  }
}

function percentile(values, quantile) {
  if (values.length === 0) return null;
  return values[Math.max(0, Math.ceil(values.length * quantile) - 1)];
}

function decodePng(png) {
  const signature = png.subarray(0, 8).toString('hex');
  if (signature !== '89504e470d0a1a0a') throw new Error('Chrome screenshot is not a PNG.');
  let offset = 8;
  let width = 0;
  let height = 0;
  let colorType = -1;
  const compressed = [];
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString('ascii', offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (data[8] !== 8 || data[12] !== 0) throw new Error('Motion blur PNG decoder requires non-interlaced 8-bit data.');
      colorType = data[9];
    } else if (type === 'IDAT') compressed.push(data);
    else if (type === 'IEND') break;
    offset += length + 12;
  }
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (!channels) throw new Error(`Unsupported Chrome PNG color type ${colorType}.`);
  const packed = inflateSync(Buffer.concat(compressed));
  const stride = width * channels;
  const rows = Buffer.alloc(stride * height);
  let packedOffset = 0;
  for (let y = 0; y < height; y++) {
    const filter = packed[packedOffset++];
    const rowOffset = y * stride;
    for (let x = 0; x < stride; x++) {
      const raw = packed[packedOffset++];
      const left = x >= channels ? rows[rowOffset + x - channels] : 0;
      const up = y > 0 ? rows[rowOffset - stride + x] : 0;
      const upperLeft = y > 0 && x >= channels ? rows[rowOffset - stride + x - channels] : 0;
      const value = filter === 0 ? raw
        : filter === 1 ? raw + left
          : filter === 2 ? raw + up
            : filter === 3 ? raw + Math.floor((left + up) / 2)
              : filter === 4 ? raw + paeth(left, up, upperLeft)
                : Number.NaN;
      if (!Number.isFinite(value)) throw new Error(`Unsupported PNG row filter ${filter}.`);
      rows[rowOffset + x] = value & 255;
    }
  }
  if (channels === 4) return { width, height, data: rows };
  const rgba = Buffer.alloc(width * height * 4);
  for (let source = 0, target = 0; source < rows.length; source += 3, target += 4) {
    rgba[target] = rows[source];
    rgba[target + 1] = rows[source + 1];
    rgba[target + 2] = rows[source + 2];
    rgba[target + 3] = 255;
  }
  return { width, height, data: rgba };
}

function paeth(a, b, c) {
  const estimate = a + b - c;
  const pa = Math.abs(estimate - a);
  const pb = Math.abs(estimate - b);
  const pc = Math.abs(estimate - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

function createStaticServer(directory) {
  const normalizedRoot = resolve(directory);
  return createServer((request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname);
      const requested = resolve(normalizedRoot, `.${pathname}`);
      if (requested !== normalizedRoot && !requested.startsWith(`${normalizedRoot}${sep}`)) {
        response.writeHead(403).end('Forbidden');
        return;
      }
      const path = statSync(requested).isDirectory() ? resolve(requested, 'index.html') : requested;
      response.writeHead(200, {
        'content-type': contentType(path),
        'cache-control': 'no-store',
        'cross-origin-opener-policy': 'same-origin',
        'cross-origin-embedder-policy': 'require-corp',
      });
      response.end(readFileSync(path));
    } catch {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not found');
    }
  });
}

function contentType(path) {
  return ({
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.bin': 'application/octet-stream',
    '.wasm': 'application/wasm',
    '.png': 'image/png',
  })[extname(path)] ?? 'application/octet-stream';
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
