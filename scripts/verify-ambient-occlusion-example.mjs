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
if (!existsSync(chrome)) throw new Error(`Ambient occlusion verification requires Chrome at ${chrome}.`);
if (!existsSync(resolve(root, 'examples/ambient-occlusion/bundle.js'))) {
  throw new Error('Build example:ambient-occlusion before AO browser verification.');
}

const server = staticServer(root);
await new Promise((accept, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', accept); });
try {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not allocate AO fixture port.');
  const base = `http://127.0.0.1:${address.port}/examples/ambient-occlusion/?regression=1`;
  const captures = await captureCases(chrome, {
    off: `${base}&ao=off&case=off`,
    gtao: `${base}&algorithm=gtao&case=gtao`,
    sao: `${base}&algorithm=sao&case=sao`,
    ssao: `${base}&algorithm=ssao&case=ssao`,
    occlusion: `${base}&algorithm=gtao&display=occlusion&case=occlusion`,
    ssaoOcclusion: `${base}&algorithm=ssao&display=occlusion&case=ssaoOcclusion`,
    occlusionNearby: `${base}&algorithm=gtao&display=occlusion&view=nearby&case=occlusionNearby`,
    occlusionAlternate: `${base}&algorithm=gtao&display=occlusion&view=alternate&case=occlusionAlternate`,
    isolatedGtao: `${base}&algorithm=gtao&display=occlusion&fixture=isolated&case=isolatedGtao`,
    isolatedSao: `${base}&algorithm=sao&display=occlusion&fixture=isolated&case=isolatedSao`,
    isolatedSsao: `${base}&algorithm=ssao&display=occlusion&fixture=isolated&case=isolatedSsao`,
  });
  const rawComparisons = Object.fromEntries(['gtao', 'sao', 'ssao'].map(name => [
    name,
    comparePixels(captures.off.pixels, captures[name].pixels),
  ]));
  for (const [name, difference] of Object.entries(rawComparisons)) {
    if (difference.changedPixelRatio < 0.003 || difference.meanAbsoluteDifference < 0.03) {
      throw new Error(`${name.toUpperCase()} is not visibly distinct from AO off: ${JSON.stringify(difference)}.`);
    }
  }
  const algorithmComparisons = {
    gtaoVsSao: comparePixels(captures.gtao.pixels, captures.sao.pixels),
    gtaoVsSsao: comparePixels(captures.gtao.pixels, captures.ssao.pixels),
    saoVsSsao: comparePixels(captures.sao.pixels, captures.ssao.pixels),
  };
  for (const [name, difference] of Object.entries(algorithmComparisons)) {
    if (difference.changedPixelRatio < 0.0002 || difference.meanAbsoluteDifference < 0.002) {
      throw new Error(`AO algorithms ${name} are unexpectedly identical: ${JSON.stringify(difference)}.`);
    }
  }
  const occlusion = summarizeLuma(captures.occlusion.pixels);
  if (occlusion.mean < 5 || occlusion.mean > 250 || occlusion.standardDeviation < 2) {
    throw new Error(`GTAO-only output is degenerate: ${JSON.stringify(occlusion)}.`);
  }
  const ssaoOcclusion = summarizeLuma(captures.ssaoOcclusion.pixels);
  const floorBanding = summarizeRowBanding(captures.occlusion.pixels, { x: 80, y: 460, width: 470, height: 150 });
  const ssaoFloorBanding = summarizeRowBanding(captures.ssaoOcclusion.pixels, { x: 80, y: 460, width: 470, height: 150 });
  const alternateFloorBanding = summarizeRowBanding(captures.occlusionAlternate.pixels, { x: 80, y: 460, width: 470, height: 150 });
  const isolatedConvex = Object.fromEntries(['isolatedGtao', 'isolatedSao', 'isolatedSsao'].map(name => [
    name,
    summarizeRegionLumaDistribution(captures[name].pixels, { x: 45, y: 70, width: 500, height: 500 }),
  ]));
  const narrowGap = summarizeRegionLumaDistribution(
    captures.ssaoOcclusion.pixels,
    { x: 430, y: 545, width: 140, height: 90 },
  );
  const narrowGapViewStability = {
    default: summarizeRegionLumaDistribution(captures.occlusion.pixels, { x: 410, y: 520, width: 160, height: 120 }),
    nearby: summarizeRegionLumaDistribution(captures.occlusionNearby.pixels, { x: 410, y: 520, width: 160, height: 120 }),
  };
  if (ssaoOcclusion.mean < 150 || ssaoOcclusion.mean > 250 || ssaoOcclusion.standardDeviation < 8) {
    throw new Error(`SSAO-only output has regressed to high-contrast silhouette halos: ${JSON.stringify(ssaoOcclusion)}.`);
  }
  for (const [name, banding] of Object.entries({ floorBanding, ssaoFloorBanding, alternateFloorBanding })) {
    if (banding.meanAdjacentDelta > 2 || banding.meanSecondDerivative > 1) {
      throw new Error(`${name} reports view-dependent depth quantization stripes: ${JSON.stringify(banding)}.`);
    }
  }
  for (const [name, distribution] of Object.entries(isolatedConvex)) {
    if (distribution.mean < 248 || distribution.p05 < 235 || distribution.standardDeviation > 8) {
      throw new Error(`${name} produces false occlusion on an isolated convex silhouette: ${JSON.stringify(distribution)}.`);
    }
  }
  if (narrowGap.p05 > narrowGap.p90 - 15) {
    throw new Error(`SSAO narrow-gap fixture has lost close-surface contrast: ${JSON.stringify(narrowGap)}.`);
  }
  const viewStabilityDelta = {
    mean: Math.abs(narrowGapViewStability.default.mean - narrowGapViewStability.nearby.mean),
    p05: Math.abs(narrowGapViewStability.default.p05 - narrowGapViewStability.nearby.p05),
    p10: Math.abs(narrowGapViewStability.default.p10 - narrowGapViewStability.nearby.p10),
  };
  if (viewStabilityDelta.mean > 4 || viewStabilityDelta.p05 > 20 || viewStabilityDelta.p10 > 12) {
    throw new Error(`GTAO narrow-gap visibility changes discontinuously across nearby camera angles: ${JSON.stringify({ narrowGapViewStability, viewStabilityDelta })}.`);
  }
  console.log(JSON.stringify({
    fixture: 'ambient-occlusion-gtao-sao-ssao-chrome-570x640',
    rawComparisons,
    algorithmComparisons,
    occlusion,
    ssaoOcclusion,
    floorBanding,
    ssaoFloorBanding,
    alternateFloorBanding,
    isolatedConvex,
    narrowGap,
    narrowGapViewStability,
    viewStabilityDelta,
    algorithms: Object.fromEntries(['gtao', 'sao', 'ssao'].map(name => [name, captures[name].result.stats])),
  }, null, 2));
} finally {
  const closed = new Promise(accept => server.close(accept));
  server.closeAllConnections();
  await closed;
}

async function captureCases(binary, cases) {
  const profile = mkdtempSync(resolve(tmpdir(), 'haiyue-ao-'));
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
    const page = await waitFor(async () => (await fetch(listUrl).then(response => response.json()).catch(() => []))
      .find(target => target.type === 'page' && target.url === 'about:blank'), 20_000, 'AO browser page');
    const cdp = await connectCdp(page.webSocketDebuggerUrl);
    try {
      await cdp.call('Emulation.setDeviceMetricsOverride', { width: 960, height: 640, deviceScaleFactor: 1, mobile: false });
      const result = {};
      for (const [name, url] of Object.entries(cases)) result[name] = await captureCase(cdp, url, name, stderr);
      return result;
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
        expression: `(() => { const node = document.querySelector('#result'); return location.href.includes('case=${name}') && node?.dataset.status ? { status: node.dataset.status, text: node.textContent, error: document.body.dataset.renderError } : null; })()`,
        returnByValue: true,
      });
      return response.result?.result?.value ?? null;
    } catch (error) {
      if (error instanceof Error && error.message.includes('execution context')) return null;
      throw error;
    }
  }, 45_000, `AO ${name} result`);
  if (fixture.status !== 'passed') throw new Error(`AO ${name} failed: ${fixture.error || fixture.text}\n${stderr}`);
  const result = JSON.parse(fixture.text);
  if (result.needsDepthTexture !== true || result.needsNormalTexture !== true) throw new Error(`AO ${name} did not declare its G-buffer inputs.`);
  const expectedAlgorithm = name === 'occlusion' || name === 'occlusionNearby' || name === 'occlusionAlternate' || name === 'isolatedGtao' ? 'gtao'
    : name === 'ssaoOcclusion' || name === 'isolatedSsao' ? 'ssao'
      : name === 'isolatedSao' ? 'sao' : name;
  if (name !== 'off' && result.algorithm !== expectedAlgorithm) throw new Error(`AO ${name} reported ${result.algorithm}.`);
  if (name !== 'off' && result.radiusSpace !== 'view') throw new Error(`AO ${name} did not report view-space radius provenance.`);
  if (name === 'occlusionAlternate' && result.view !== 'alternate') throw new Error('AO alternate-view case did not use alternate camera provenance.');
  if (name === 'occlusionNearby' && result.view !== 'nearby') throw new Error('AO nearby-view case did not use nearby camera provenance.');
  if (name.startsWith('isolated') && result.fixture !== 'isolated') throw new Error(`AO ${name} did not report isolated fixture provenance.`);
  if (name !== 'off' && (!(result.stats?.frameCount >= 2) || result.stats?.sampleCount !== 32)) {
    throw new Error(`AO ${name} did not execute its high-quality sample tier: ${JSON.stringify(result.stats)}.`);
  }
  if (name !== 'off' && (
    result.stats?.renderPassCount !== 3
    || result.stats?.resolutionScale !== 0.5
    || result.stats?.scratchFormat !== 'r8unorm'
    || !(result.stats?.scratchTextureBytes > 0)
  )) {
    throw new Error(`AO ${name} did not use the reviewed half-resolution three-stage path: ${JSON.stringify(result.stats)}.`);
  }
  const screenshot = await cdp.call('Page.captureScreenshot', {
    format: 'png',
    clip: { x: 390, y: 0, width: 570, height: 640, scale: 1 },
    captureBeyondViewport: false,
  });
  return { result, pixels: decodePng(Buffer.from(screenshot.result.data, 'base64')) };
}

function comparePixels(left, right) {
  if (left.width !== right.width || left.height !== right.height) throw new Error('AO captures have different dimensions.');
  let absoluteDifference = 0;
  let changedPixels = 0;
  for (let index = 0; index < left.data.length; index += 4) {
    const difference = Math.abs(left.data[index] - right.data[index])
      + Math.abs(left.data[index + 1] - right.data[index + 1])
      + Math.abs(left.data[index + 2] - right.data[index + 2]);
    absoluteDifference += difference;
    if (difference >= 6) changedPixels++;
  }
  const pixelCount = left.width * left.height;
  return { changedPixelRatio: changedPixels / pixelCount, meanAbsoluteDifference: absoluteDifference / (pixelCount * 3) };
}

function summarizeLuma(image) {
  let sum = 0;
  let squared = 0;
  const count = image.width * image.height;
  for (let index = 0; index < image.data.length; index += 4) {
    const value = image.data[index] * 0.2126 + image.data[index + 1] * 0.7152 + image.data[index + 2] * 0.0722;
    sum += value;
    squared += value * value;
  }
  const mean = sum / count;
  return { mean, standardDeviation: Math.sqrt(Math.max(0, squared / count - mean * mean)) };
}

function summarizeRegionLumaDistribution(image, region) {
  const values = [];
  const endX = Math.min(image.width, region.x + region.width), endY = Math.min(image.height, region.y + region.height);
  for (let y = Math.max(0, region.y); y < endY; y++) for (let x = Math.max(0, region.x); x < endX; x++) {
    const index = (y * image.width + x) * 4;
    values.push(image.data[index] * 0.2126 + image.data[index + 1] * 0.7152 + image.data[index + 2] * 0.0722);
  }
  values.sort((left, right) => left - right);
  const mean = values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / Math.max(1, values.length);
  const percentile = fraction => values[Math.min(values.length - 1, Math.floor(values.length * fraction))] ?? 0;
  return {
    mean,
    standardDeviation: Math.sqrt(variance),
    p05: percentile(0.05),
    p10: percentile(0.10),
    p90: percentile(0.90),
    sampleCount: values.length,
  };
}

function summarizeRowBanding(image, region) {
  const rows = [];
  const startX = Math.max(0, region.x), endX = Math.min(image.width, region.x + region.width);
  const startY = Math.max(0, region.y), endY = Math.min(image.height, region.y + region.height);
  for (let y = startY; y < endY; y++) {
    let sum = 0;
    for (let x = startX; x < endX; x++) {
      const index = (y * image.width + x) * 4;
      sum += image.data[index] * 0.2126 + image.data[index + 1] * 0.7152 + image.data[index + 2] * 0.0722;
    }
    rows.push(sum / Math.max(1, endX - startX));
  }
  let adjacentDelta = 0;
  let secondDerivative = 0;
  for (let index = 1; index < rows.length; index++) adjacentDelta += Math.abs(rows[index] - rows[index - 1]);
  for (let index = 1; index + 1 < rows.length; index++) secondDerivative += Math.abs(rows[index - 1] - rows[index] * 2 + rows[index + 1]);
  return {
    meanAdjacentDelta: adjacentDelta / Math.max(1, rows.length - 1),
    meanSecondDerivative: secondDerivative / Math.max(1, rows.length - 2),
  };
}

function decodePng(png) {
  if (png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('AO screenshot is not PNG.');
  let offset = 8, width = 0, height = 0, colorType = -1;
  const compressed = [];
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString('ascii', offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); colorType = data[9]; }
    else if (type === 'IDAT') compressed.push(data);
    else if (type === 'IEND') break;
    offset += length + 12;
  }
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (!channels) throw new Error(`Unsupported AO PNG color type ${colorType}.`);
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
      const value = filter === 0 ? raw : filter === 1 ? raw + left : filter === 2 ? raw + up
        : filter === 3 ? raw + Math.floor((left + up) / 2) : filter === 4 ? raw + paeth(left, up, upperLeft) : Number.NaN;
      if (!Number.isFinite(value)) throw new Error(`Unsupported AO PNG filter ${filter}.`);
      rows[rowOffset + x] = value & 255;
    }
  }
  if (channels === 4) return { width, height, data: rows };
  const rgba = Buffer.alloc(width * height * 4);
  for (let source = 0, target = 0; source < rows.length; source += 3, target += 4) {
    rgba[target] = rows[source]; rgba[target + 1] = rows[source + 1]; rgba[target + 2] = rows[source + 2]; rgba[target + 3] = 255;
  }
  return { width, height, data: rgba };
}

function paeth(a, b, c) {
  const estimate = a + b - c;
  const pa = Math.abs(estimate - a), pb = Math.abs(estimate - b), pc = Math.abs(estimate - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

function staticServer(directory) {
  const normalized = resolve(directory);
  return createServer((request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname);
      const requested = resolve(normalized, `.${pathname}`);
      if (requested !== normalized && !requested.startsWith(`${normalized}${sep}`)) return response.writeHead(403).end('Forbidden');
      const path = statSync(requested).isDirectory() ? resolve(requested, 'index.html') : requested;
      response.writeHead(200, { 'content-type': contentType(path), 'cache-control': 'no-store', 'cross-origin-opener-policy': 'same-origin', 'cross-origin-embedder-policy': 'require-corp' });
      response.end(readFileSync(path));
    } catch { response.writeHead(404).end('Not found'); }
  });
}

function contentType(path) {
  const extension = extname(path);
  return extension === '.html' ? 'text/html; charset=utf-8' : extension === '.js' || extension === '.mjs' ? 'text/javascript; charset=utf-8'
    : extension === '.wasm' ? 'application/wasm' : 'application/octet-stream';
}

async function waitFor(read, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { const value = await read(); if (value) return value; await new Promise(resolveWait => setTimeout(resolveWait, 100)); }
  throw new Error(`Timed out waiting for ${label}.`);
}

function connectCdp(url) {
  return new Promise((resolveConnect, reject) => {
    const socket = new WebSocket(url);
    const pending = new Map();
    let nextId = 0;
    socket.addEventListener('error', () => reject(new Error(`Could not connect to ${url}.`)), { once: true });
    socket.addEventListener('open', () => resolveConnect({
      call(method, params = {}) { return new Promise((resolveCall, rejectCall) => { const id = ++nextId; pending.set(id, { resolveCall, rejectCall }); socket.send(JSON.stringify({ id, method, params })); }); },
      close() { socket.close(); },
    }), { once: true });
    socket.addEventListener('message', event => {
      const message = JSON.parse(String(event.data));
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      if (message.error) request.rejectCall(new Error(message.error.message)); else request.resolveCall(message);
    });
  });
}
