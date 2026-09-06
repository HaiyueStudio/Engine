import { TaaPass } from '../../engine/dist/postprocess.js';
import { readFloatTexture } from './float-texture-readback.mjs';
import { verifyTemporalScene } from './taa-temporal-scene.mjs';
import { mat4 } from 'wgpu-matrix';

const result = document.querySelector('#result');
const check = (condition, message) => { if (!condition) throw Error(message); };
const identity = () => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const gray = value => [value, value, value, 1];
const current = (x, y) => gray(x === 8 && y === 4 ? 0.2 : (x + y) % 2);

try {
  const adapter = await navigator.gpu?.requestAdapter({ powerPreference: 'high-performance' });
  check(adapter, 'WebGPU adapter unavailable');
  const device = await adapter.requestDevice();
  const errors = [];
  const cases = [];
  device.addEventListener('uncapturederror', event => errors.push(event.error.message));
  device.pushErrorScope('validation');
  try {
    async function pair(name, options = {}) {
      const taa = new TaaPass({ feedback: 0.9, sharpness: 0, depthThreshold: options.threshold ?? 0.0001 });
      const resources = [];
      const width = 16, height = 8;
      function texture(format) {
        const value = device.createTexture({ size: [width, height], format, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
        resources.push(value); return value;
      }
      const color = texture('rgba16float'), depth = texture('r32float'), motion = texture('rgba16float'), output = texture('rgba16float');
      taa.prepare(device, 'rgba16float');
      async function apply(id, colors, depths, motions, jitter = [0, 0]) {
        writePixels(device, color, colors); writePixels(device, depth, (x, y) => [depths(x, y)]); writePixels(device, motion, motions);
        const projection = options.perspective ? mat4.perspective(Math.PI / 2, width / height, 0.1, 100) : identity();
        for (let column = 0; column < 4; column++) {
          const base = column * 4;
          projection[base] += 2 * jitter[0] / width * projection[base + 3];
          projection[base + 1] -= 2 * jitter[1] / height * projection[base + 3];
        }
        const view = mat4.translation([id === 0 ? 0 : -(options.cameraTranslation ?? 0), 0, 0]);
        const viewProjection = mat4.multiply(projection, view);
        const frame = { frameId: id, viewKey: name, width, height, cameraId: 1, near: options.perspective ? 0.1 : 0,
          far: options.perspective ? 100 : 1, reverseZ: false, isOrthographic: !options.perspective,
          projectionJitter: new Float32Array(jitter), projectionMatrix: projection, viewProjectionMatrix: viewProjection,
          inverseViewProjectionMatrix: mat4.inverse(viewProjection) };
        taa.setSceneTextures({ depth, motion, frame });
        const encoder = device.createCommandEncoder(); taa.apply(encoder, color, output.createView(), device); device.queue.submit([encoder.finish()]);
        return readFloatTexture(device, output);
      }
      try {
        await apply(0, options.seedColor ?? (x => gray(x < 6 ? 0.8 : 0.1)), options.seedDepth ?? (() => 0.2), () => [0, 0, 0.2, -1], options.seedJitter);
        const pixels = await apply(1, options.currentColor ?? current, options.currentDepth ?? (() => 0.2), options.motion ?? (() => [4 / width, 0, 0.2, 1]), options.jitter);
        const value = pixels[(4 * width + 8) * 4];
        const history = taa._historyStore.histories.get(name);
        const historyColor = await readFloatTexture(device, history.colors[history.readIndex]);
        const historyDepth = await readFloatTexture(device, history.depths[history.readIndex]);
        cases.push({ name, center: value, historyAlpha: historyColor[(4 * width + 8) * 4 + 3], historyDepth: historyDepth[(4 * width + 8) * 4] });
        return { value, historyColor, historyDepth };
      } finally { taa.destroy(); for (const texture of resources) texture.destroy(); }
    }

    const moved = await pair('velocity-reprojection');
    const still = await pair('zero-velocity-control', { motion: () => [0, 0, 0.2, 1] });
    check(moved.value > still.value + 0.2, `TAA did not use motion: moved=${moved.value}, still=${still.value}`);
    const forward = await pair('object-depth-motion', { currentDepth: () => 0.6 });
    check(forward.value > 0.4, 'motion previous depth must validate an object moving toward the camera');
    const disoccluded = await pair('disocclusion', { seedDepth: () => 0.7 });
    check(Math.abs(disoccluded.value - 0.2) < 0.002, 'disoccluded pixel contains old history');
    for (const [name, vector] of [['new-entity', [0, 0, 0.2, -1]], ['missing-finite-surface-motion', [0, 0, 0, 0]], ['offscreen-history', [2, 0, 0.2, 1]]]) {
      const sample = await pair(name, { motion: () => vector });
      check(Math.abs(sample.value - 0.2) < 0.002, `${name} must reject history`);
    }
    const mixedDepth = await pair('bilinear-depth-boundary', {
      seedDepth: x => x <= 3 ? 0.2 : 0.8, currentDepth: () => 0.5, motion: () => [4.5 / 16, 0, 0.5, 1],
    });
    check(Math.abs(mixedDepth.value - 0.2) < 0.002, 'interpolated depth must not invent a valid surface');
    const jitter = await pair('stable-history-grid', { seedColor: x => gray(x === 8 ? 0.8 : 0.1), motion: () => [0, 0, 0.2, 1], jitter: [1, 0] });
    check(jitter.value > 0.4, 'projection jitter was applied twice to history coordinates');
    for (const perspective of [false, true]) {
      const background = await pair(perspective ? 'perspective-sky-translation' : 'background-jitter', {
        perspective, cameraTranslation: perspective ? 4 : 0, seedJitter: [-0.25, 0], jitter: [0.75, 0],
        seedColor: x => gray(x === 8 ? 0.8 : 0.1), seedDepth: () => 1, currentDepth: () => 1, motion: () => [0, 0, 0, 0],
      });
      check(background.value > 0.4, 'far background must cancel jitter and ignore perspective camera translation');
    }
    const silhouette = await pair('subpixel-silhouette-accumulation', {
      seedColor: x => gray(x < 8 ? 1 : 0), currentColor: x => gray(x <= 8 ? 1 : 0),
      seedDepth: x => x < 8 ? 0.2 : 1, currentDepth: x => x <= 8 ? 0.2 : 1,
      motion: x => x <= 8 ? [0, 0, 0.2, 1] : [0, 0, 0, 0], jitter: [0.5, 0],
    });
    check(silhouette.value > 0.2 && silhouette.value < 0.8, 'jittered silhouette rejected all temporal antialiasing samples');
    const hdr = await pair('hdr-alpha-depth-precision', {
      seedColor: () => [4, 2, 1, 0.4], currentColor: () => [4, 2, 1, 0.4],
      seedDepth: () => 0.000123456, currentDepth: () => 0.000123456, motion: () => [0, 0, 0.000123456, 1],
    });
    check(hdr.value > 3.9, 'HDR history was clamped to display range');
    check(Math.abs(hdr.historyDepth[(4 * 16 + 8) * 4] - 0.000123456) < 1e-9, 'history depth lost r32float precision');
    check(Math.abs(hdr.historyColor[(4 * 16 + 8) * 4 + 3] - 0.4) < 0.001, 'history alpha was overwritten by depth');

    await verifyTemporalScene(device, cases);
    const validation = await device.popErrorScope();
    if (validation) errors.push(validation.message);
    check(errors.length === 0, errors.join('\n'));
  } finally { device.destroy(); }
  result.textContent = JSON.stringify({ schemaVersion: 1, suite: 'taa.temporal-motion', status: 'passed', role: 'diagnostic-regression',
    generatedAt: new Date().toISOString(), browser: navigator.userAgent, adapter: { vendor: adapter.info.vendor, architecture: adapter.info.architecture }, cases, validationErrors: errors });
  result.dataset.status = 'passed';
} catch (error) { result.textContent = error.stack ?? String(error); result.dataset.status = 'failed'; }

function writePixels(device, texture, sample) {
  const channels = texture.format === 'r32float' ? 1 : 4;
  const data = channels === 1 ? new Float32Array(texture.width * texture.height) : new Uint16Array(texture.width * texture.height * 4);
  for (let y = 0; y < texture.height; y++) for (let x = 0; x < texture.width; x++) {
    const values = sample(x, y);
    for (let c = 0; c < channels; c++) data[(y * texture.width + x) * channels + c] = channels === 1 ? values[c] : half(values[c]);
  }
  device.queue.writeTexture({ texture }, data, { bytesPerRow: texture.width * (channels === 1 ? 4 : 8) }, [texture.width, texture.height]);
}

function half(value) {
  const sign = value < 0 ? 32768 : 0;
  const magnitude = Math.abs(value);
  if (magnitude === 0) return sign;
  if (magnitude < 2 ** -14) return sign + Math.round(magnitude * 2 ** 24);
  const exponent = Math.floor(Math.log2(magnitude));
  return sign + (exponent + 15) * 1024 + Math.round((magnitude / 2 ** exponent - 1) * 1024);
}
