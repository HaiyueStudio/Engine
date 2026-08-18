import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { inflateSync } from 'node:zlib';
import {
  defaultChromePath,
  defaultWebGpuAngleBackend,
  startHttpFixtureServer,
} from './webgpu-gate/chrome-runner.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const baselinePath = resolve(root, 'review/baselines/render-pixels-stage9-pbr-example.json');
const chrome = process.env.CHROME_PATH ?? defaultChromePath();
if (!existsSync(chrome)) throw new Error(`PBR product verification requires Chrome at ${chrome}.`);
if (!existsSync(resolve(root, 'examples/pbr-showcase/bundle.js'))) throw new Error('Build example:pbr-showcase before PBR product verification.');

const fixtureServer = await startHttpFixtureServer(root);
try {
const baseUrl = new URL('/examples/pbr-showcase/index.html', fixtureServer.origin);
const onUrl = new URL(baseUrl);
const offUrl = new URL(baseUrl);
offUrl.searchParams.set('clearcoat', 'off');
const specularUrl = new URL(baseUrl);
specularUrl.searchParams.set('specular', 'on');
const sheenUrl = new URL(baseUrl);
sheenUrl.searchParams.set('sheen', 'on');
const transmissionUrl = new URL(baseUrl);
transmissionUrl.searchParams.set('transmission', 'on');
const shadowInstancingUrl = new URL(baseUrl);
shadowInstancingUrl.searchParams.set('shadowBatch', 'on');
const neutralRimUrl = new URL(baseUrl);
neutralRimUrl.searchParams.set('clearcoat', 'off');
neutralRimUrl.searchParams.set('neutralRim', 'on');
const shadowCoverage = 'shadow-static,shadow-morph,shadow-skinned,shadow-skinned-morph';
const on = pixelRecord(await capture(chrome, onUrl.href, `base,clearcoat,${shadowCoverage}`, true));
const off = pixelRecord(await capture(chrome, offUrl.href, `base,${shadowCoverage}`));
const specular = pixelRecord(await capture(chrome, specularUrl.href, `base,clearcoat,ior-specular,${shadowCoverage}`));
const sheen = pixelRecord(await capture(chrome, sheenUrl.href, `base,clearcoat,sheen,${shadowCoverage}`));
const transmission = pixelRecord(await capture(chrome, transmissionUrl.href, `base,clearcoat,transmission-volume,${shadowCoverage}`));
const shadowInstancing = pixelRecord(await capture(
  chrome,
  shadowInstancingUrl.href,
  `base,clearcoat,shadow-direct-instancing,${shadowCoverage}`,
));
const neutralRimCapture = await capture(chrome, neutralRimUrl.href, `base,${shadowCoverage}`);
assertNeutralRimPixels(decodePng(Buffer.from(neutralRimCapture.data, 'base64')));
if (on.hash === off.hash) throw new Error('PBR clearcoat on/off outputs unexpectedly match.');
if (on.hash === specular.hash) throw new Error('PBR IOR/Specular on/off outputs unexpectedly match.');
if (on.hash === sheen.hash) throw new Error('PBR Sheen on/off outputs unexpectedly match.');
if (on.hash === transmission.hash) throw new Error('PBR Transmission/Volume on/off outputs unexpectedly match.');
if (on.hash === shadowInstancing.hash) throw new Error('Direct-instanced directional-shadow fixture did not change the rendered output.');
const current = {
  schemaVersion: 2,
  fixture: 'haiyue-pbr-showcase-clearcoat-chrome-960x640',
  width: 960,
  height: 640,
  modes: { off, on, specular, sheen, transmission, shadowInstancing },
};
if (process.env.UPDATE_PBR_EXAMPLE_BASELINE === '1') {
  writeFileSync(baselinePath, `${JSON.stringify(current, null, 2)}\n`);
  console.log(`[pbr-example] Updated ${baselinePath}.`);
} else {
  const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
  for (const key of ['schemaVersion', 'fixture', 'width', 'height']) {
    if (current[key] !== baseline[key]) throw new Error(`PBR example pixel regression at ${key}: expected ${baseline[key]}, received ${current[key]}.`);
  }
  for (const mode of ['off', 'on', 'specular', 'sheen', 'transmission', 'shadowInstancing']) {
    for (const key of ['hash', 'bytes']) {
      if (current.modes[mode][key] !== baseline.modes?.[mode]?.[key]) {
        throw new Error(`PBR example pixel regression at ${mode}.${key}: expected ${baseline.modes?.[mode]?.[key]}, received ${current.modes[mode][key]}.`);
      }
    }
  }
  console.log(`[pbr-example] PBR base ${off.hash.slice(0, 16)}…, clearcoat ${on.hash.slice(0, 16)}…, IOR/Specular ${specular.hash.slice(0, 16)}…, Sheen ${sheen.hash.slice(0, 16)}…, Transmission/Volume ${transmission.hash.slice(0, 16)}…, direct-instanced shadows ${shadowInstancing.hash.slice(0, 16)}…; shadow/IBL pixels and four deformation variants passed.`);
}
} finally {
  await fixtureServer.close();
}

function pixelRecord(result) {
  const png = Buffer.from(result.data, 'base64');
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  if (width !== 960 || height !== 640) throw new Error(`PBR screenshot dimensions changed: expected 960x640, received ${width}x${height}.`);
  return { hash: createHash('sha256').update(png).digest('hex'), bytes: png.byteLength };
}

function assertNeutralRimPixels(image) {
  const channelDeltas = [];
  for (let y = 24; y < Math.min(image.height, 616); y++) {
    for (let x = 330; x < Math.min(image.width, 530); x++) {
      const offset = (y * image.width + x) * 4;
      const red = image.data[offset];
      const green = image.data[offset + 1];
      const blue = image.data[offset + 2];
      channelDeltas.push(Math.max(red, green, blue) - Math.min(red, green, blue));
    }
  }
  channelDeltas.sort((left, right) => left - right);
  const p99 = channelDeltas[Math.max(0, Math.ceil(channelDeltas.length * 0.99) - 1)] ?? 0;
  const tintedRatio = channelDeltas.filter(delta => delta > 3).length / Math.max(1, channelDeltas.length);
  if (p99 > 2 || tintedRatio > 0.002) {
    throw new Error(
      `Neutral PBR contour acquired a color cast: p99 channel delta ${p99}, `
      + `tinted pixels ${(tintedRatio * 100).toFixed(3)}%.`,
    );
  }
}

function decodePng(png) {
  if (png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('PBR screenshot is not PNG.');
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
      if (data[8] !== 8 || data[12] !== 0) throw new Error('PBR PNG decoder requires non-interlaced 8-bit data.');
      colorType = data[9];
    } else if (type === 'IDAT') compressed.push(data);
    else if (type === 'IEND') break;
    offset += length + 12;
  }
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (!channels) throw new Error(`Unsupported PBR PNG color type ${colorType}.`);
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
      if (!Number.isFinite(value)) throw new Error(`Unsupported PBR PNG filter ${filter}.`);
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

async function capture(binary, url, expectedCoverage, verifyControls = false) {
  const profile = mkdtempSync(resolve(tmpdir(), 'haiyue-pbr-example-'));
  const angleBackend = process.env.WEBGPU_ANGLE_BACKEND ?? defaultWebGpuAngleBackend();
  const child = spawn(binary, [
    '--headless=new', '--no-sandbox', '--disable-gpu-sandbox', '--enable-unsafe-webgpu', `--use-angle=${angleBackend}`,
    '--window-size=960,640', '--force-device-scale-factor=1', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.resume();
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr += chunk; });
  try {
    const endpoint = await waitFor(() => /DevTools listening on (ws:\/\/[^\s]+)/.exec(stderr)?.[1], 15_000, 'Chrome endpoint');
    const listUrl = `http://${new URL(endpoint).host}/json/list`;
    const page = await waitFor(async () => (await fetch(listUrl).then(response => response.json()).catch(() => [])).find(item => item.type === 'page' && item.url === 'about:blank'), 15_000, 'PBR page');
    const cdp = await connectCdp(page.webSocketDebuggerUrl);
    try {
      await cdp.call('Emulation.setDeviceMetricsOverride', { width: 960, height: 640, deviceScaleFactor: 1, mobile: false });
      await cdp.call('Page.navigate', { url });
      const status = await waitFor(async () => {
        const response = await cdp.call('Runtime.evaluate', { expression: `({ status: document.body.dataset.renderStatus, error: document.body.dataset.renderError, coverage: document.body.dataset.pbrShaderValidation })`, returnByValue: true });
        const value = response.result?.result?.value;
        return value?.status ? value : null;
      }, 20_000, 'PBR GPU validation');
      if (status.status !== 'passed') throw new Error(`PBR example GPU validation failed: ${status.error || 'unknown error'}\n${stderr}`);
      if (status.coverage !== expectedCoverage) throw new Error(`PBR shader validation coverage changed: expected ${expectedCoverage}, received ${status.coverage || 'none'}.`);
      const screenshot = (await cdp.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })).result;
      if (verifyControls) await verifyPbrControls(cdp);
      return screenshot;
    } finally {
      await cdp.call('Browser.close').catch(() => {});
      cdp.close();
    }
  } finally {
    if (child.exitCode === null) child.kill('SIGTERM');
    try { rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch {}
  }
}

async function verifyPbrControls(cdp) {
  const viewportClip = { x: 286, y: 100, width: 270, height: 480, scale: 1 };
  const before = (await cdp.call('Page.captureScreenshot', { format: 'png', clip: viewportClip })).result.data;
  const probe = await cdp.call('Runtime.evaluate', {
    expression: `(async () => {
      const required = [
        'material-target', 'variant', 'base-color', 'metallic', 'roughness',
        'normal-scale', 'occlusion-strength', 'clearcoat-factor', 'ior',
        'specular-factor', 'sheen-roughness', 'transmission-factor',
        'thickness-factor', 'attenuation-distance', 'alpha-mode',
        'texture-slot', 'texture-enabled', 'texture-texcoord',
        'sampler-override', 'sun-intensity', 'environment-intensity',
      ];
      const missing = required.filter(id => !document.getElementById(id));
      const dispatch = (id, value, event = 'input') => {
        const input = document.getElementById(id);
        input.value = value;
        input.dispatchEvent(new Event(event, { bubbles: true }));
      };
      dispatch('metallic', '0');
      dispatch('roughness', '0.96');
      dispatch('emissive-r', '2.5');
      dispatch('emissive-g', '0.15');
      dispatch('emissive-b', '0.05');
      dispatch('alpha-mode', 'mask', 'change');
      dispatch('texture-slot', 'thickness', 'change');
      const sampler = document.getElementById('sampler-override');
      sampler.checked = true;
      sampler.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return {
        missing,
        controlCount: document.querySelectorAll('#inspector input, #inspector select, #inspector button').length,
        alphaCutoffEnabled: !document.getElementById('alpha-cutoff').disabled,
        samplerEnabled: !document.getElementById('sampler-mag').disabled,
        textureMeta: document.getElementById('texture-meta').textContent,
      };
    })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  const result = probe.result?.result?.value;
  if (result?.missing?.length) throw new Error(`PBR inspector controls missing: ${result.missing.join(', ')}.`);
  if ((result?.controlCount ?? 0) < 50) throw new Error(`PBR inspector unexpectedly exposes only ${result?.controlCount ?? 0} controls.`);
  if (!result?.alphaCutoffEnabled) throw new Error('PBR alpha cutoff did not activate for mask mode.');
  if (!result?.samplerEnabled) throw new Error('PBR sampler controls did not activate with a sampler override.');
  if (!String(result?.textureMeta).includes('G thickness')) throw new Error(`PBR texture-slot metadata did not follow the selected slot: ${result?.textureMeta}.`);
  const after = (await cdp.call('Page.captureScreenshot', { format: 'png', clip: viewportClip })).result.data;
  if (before === after) throw new Error('PBR inspector mutations did not change the rendered viewport.');
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
        return new Promise((resolveCall, rejectCall) => { const requestId = ++id; pending.set(requestId, { resolveCall, rejectCall }); socket.send(JSON.stringify({ id: requestId, method, params })); });
      },
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
