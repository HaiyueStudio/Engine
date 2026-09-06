import { AmbientLight, BasicMaterial, BlinnPhongMaterial, Camera3D, ColorLinear, Entity, Geometry3D, Mesh3D, PlanarMirror, RenderView, Transform3D, Fog, Sky } from '../../engine/dist/experimental.js';
import { ToonMaterial } from '../../engine/dist/material.js';
import { ToonRenderSystem } from '../../engine/dist/systems.js';
import { PbrMaterial } from '../../engine/dist/index.js';
import { RttEngine } from '../../engine/dist/rtt.js';
import { FxaaPass, TaaPass } from '../../engine/dist/postprocess.js';
import { createAuditTarget, createRealRendererBenchmarkScenario, destroyRealRendererBenchmarkScenario, resetRealRendererBenchmarkMetrics, runRealRendererBenchmarkFrame, warmRealRendererBenchmarkPipelines } from '../benchmark/real-renderer-scenario.mjs';
import { readFloatTexture } from './float-texture-readback.mjs';

const result = document.querySelector('#result');
const check = (condition, message) => { if (!condition) throw Error(message); };
const encode = value => value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055;
const display = value => encode(value / (1 + value));
function expect(actual, expected, label, epsilon = 0.008) {
  check(actual.every((value, i) => Math.abs(value - expected[i]) <= epsilon), `${label}: expected ${expected}, got ${actual}`);
}
function quad(left, right) {
  return new Geometry3D({ positions: new Float32Array([left, -.8, 0, right, -.8, 0, right, .8, 0, left, .8, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]), indices: new Uint32Array([0, 1, 2, 0, 2, 3]) });
}
async function pixel(device, texture, x, y) {
  const values = await readFloatTexture(device, texture);
  const offset = (y * texture.width + x) * 4;
  return [...values.slice(offset, offset + 4)];
}

try {
  const adapter = await navigator.gpu?.requestAdapter({ powerPreference: 'high-performance' });
  check(adapter, 'WebGPU adapter unavailable');
  const device = await adapter.requestDevice();
  const errors = [], cases = [];
  device.addEventListener('uncapturederror', event => errors.push(event.error.message));
  device.pushErrorScope('validation');
  const target = createAuditTarget(device, 64, 64);
  const owned = [];
  let state;
  try {
    state = await createRealRendererBenchmarkScenario({ device, target, entityCount: 0 });
    state.render3d.passes.length = 0;
    state.world.removeEntity(state.world.getEntity('fog'));
    state.world.removeEntity(state.world.getEntity('shadow-sun'));
    for (let i = 0; i < 7; i++) state.world.removeEntity(state.world.getEntity(`real-point-light:${i}`));
    state.world.addEntity(new Entity('output-ambient').addComponent(new AmbientLight({ intensity: 1 })));
    // Pure emission makes expected radiance independent of the scenario's lights.
    const pbr = new PbrMaterial({ baseColor: [0, 0, 0, 1], metallic: 1, emissiveFactor: [4, 2, 1] });
    const basic = new BasicMaterial({ color: new ColorLinear(4, 2, 1) });
    const pbrMesh = new Mesh3D(quad(-.9, -.1), pbr);
    const basicMesh = new Mesh3D(quad(.1, .9), basic);
    state.world.addEntity(new Entity('output-pbr').addComponent(new Transform3D()).addComponent(pbrMesh));
    state.world.addEntity(new Entity('output-basic').addComponent(new Transform3D()).addComponent(basicMesh));
    const camera = new Entity('output-camera').addComponent(new Transform3D().setTranslation(0, 0, 3))
      .addComponent(new Camera3D({ type: 'orthographic', left: -1, right: 1, bottom: -1, top: 1, near: .1, far: 10 }));
    state.world.addEntity(camera);
    const hdr = new RttEngine(state.engine, 32, 32, undefined, 'output.hdr', null, 'rgba16float'); owned.push(hdr);
    const srgb = new RttEngine(state.engine, 64, 64, undefined, 'output.srgb', null, 'rgba8unorm-srgb'); owned.push(srgb);
    const msaa = new RttEngine(state.engine, 64, 64, undefined, 'output.msaa'); owned.push(msaa);
    const view = (key, destination, options = {}) => new RenderView({ key, target: destination, camera, ...options }).snapshot();
    const mainView = view('output-display', target), hdrView = view('output-hdr', hdr);
    state.views = [mainView, hdrView];
    state.render3d.checkEntityManager(state.world);
    await warmRealRendererBenchmarkPipelines(state);
    resetRealRendererBenchmarkMetrics(state);
    async function frame(name) {
      await runRealRendererBenchmarkFrame(state);
      const validation = await device.popErrorScope();
      check(!validation, `${name}: ${validation?.message}`);
      device.pushErrorScope('validation');
      const color = await pixel(device, target.colorTexture, 16, 32);
      cases.push({ name, display: color });
      return color;
    }
    expect(await frame('empty-chain-display'), [display(4), display(2), display(1), 1], 'PBR output');
    expect(await pixel(device, target.colorTexture, 48, 32), [display(4), display(2), display(1), 1], 'Basic/PBR shared output');
    expect(await pixel(device, hdr.colorTexture, 8, 16), [4, 2, 1, 1], 'unmapped HDR capture');
    cases.push({ name: 'mixed-material-and-hdr-target' });
    pbr.baseColor = [0, 0, 0, .2]; basic.color = new ColorLinear(4, 2, 1, .2);
    expect(await frame('opaque-alpha-is-coverage-one'), [display(4), display(2), display(1), 1], 'opaque PBR alpha');
    expect(await pixel(device, target.colorTexture, 48, 32), [display(4), display(2), display(1), 1], 'opaque Basic alpha');
    pbr.baseColor = [0, 0, 0, 1]; basic.color = new ColorLinear(4, 2, 1);

    const taa = new TaaPass({ jitterScale: 0, sharpness: 0 });
    state.render3d.passes.push(taa);
    expect(await frame('taa-chain-display'), [display(4), display(2), display(1), 1], 'TAA maps exactly once');
    const history = taa._historyStore.histories.get(mainView.key);
    expect(await pixel(device, history.colors[history.readIndex], 16, 32), [4, 2, 1, 1], 'TAA scene-linear HDR history');
    state.render3d.exposure = .5;
    expect(await frame('exposure-after-history'), [display(2), display(1), display(.5), 1], 'output exposure');
    expect(await pixel(device, history.colors[history.readIndex], 16, 32), [4, 2, 1, 1], 'exposure did not contaminate history');
    expect(await pixel(device, hdr.colorTexture, 8, 16), [4, 2, 1, 1], 'exposure did not contaminate capture');
    state.render3d.passes.length = 0;
    state.render3d.exposure = 1;

    state.views = [view('output-srgb', srgb), view('output-msaa', msaa, { sampleCount: 4 })];
    await frame('srgb-and-msaa-targets');
    expect(await pixel(device, srgb.colorTexture, 16, 32), [4 / 5, 2 / 3, 1 / 2, 1], 'sRGB hardware transfer sampled back to linear');
    expect(await pixel(device, msaa.colorTexture, 16, 32), [display(4), display(2), display(1), 1], 'MSAA display');
    // A later UI/display pass loads the destination MSAA samples and resolves again.
    const descriptor = msaa.getRenderPassDescriptor({ clearColor: { r: 0, g: 0, b: 0, a: 1 }, sampleCount: 4, depthConvention: 'standard' });
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({ colorAttachments: [{ ...descriptor.colorAttachments[0], loadOp: 'load', storeOp: 'store' }] });
    pass.end(); device.queue.submit([encoder.finish()]);
    expect(await pixel(device, msaa.colorTexture, 16, 32), [display(4), display(2), display(1), 1], 'later UI resolve preserved scene output');
    cases.push({ name: 'msaa-display-load-preserves-scene' });

    state.views = [mainView, hdrView];
    const fogEntity = new Entity('output-fog').addComponent(new Fog({ color: new ColorLinear(0, 0, 1), distanceStart: 0, distanceEnd: 1, maxOpacity: .5 }));
    state.world.addEntity(fogEntity);
    expect(await frame('fog-before-output'), [display(2), display(1), display(1), 1], 'linear fog');
    state.world.removeEntity(fogEntity);

    // A perfectly transmitting front layer must sample the original linear emission.
    const glass = new PbrMaterial({ baseColor: [1, 1, 1, 1], metallic: 0, transmissionFactor: 1, ior: 1, specularFactor: 0, roughness: 0 });
    const glassEntity = new Entity('output-glass').addComponent(new Transform3D().setTranslation(0, 0, .2)).addComponent(new Mesh3D(quad(-.9, -.1), glass));
    state.world.addEntity(glassEntity); state.render3d.checkEntityManager(state.world);
    expect(await frame('linear-framebuffer-transmission'), [display(4), display(2), display(1), 1], 'transmission');
    expect(await pixel(device, hdr.colorTexture, 8, 16), [4, 2, 1, 1], 'transmission retained HDR', .04);
    state.world.removeEntity(glassEntity);

    pbrMesh.material = new BlinnPhongMaterial({ ambient: new ColorLinear(4, 2, 1), diffuse: [0, 0, 0, 1], specular: [0, 0, 0, 1] });
    expect(await frame('blinn-shared-output'), [display(4), display(2), display(1), 1], 'Blinn output');
    state.world.addSystem(new ToonRenderSystem(state.engine, null, { render3DSystem: state.render3d }));
    pbrMesh.material = new ToonMaterial({ baseColor: new ColorLinear(4, 2, 1, .2), layers: [{ minLight: 0, color: [1, 1, 1, .3] }] });
    expect(await frame('toon-shared-output-and-opaque-coverage'), [display(4), display(2), display(1), 1], 'Toon output');
    pbrMesh.material = pbr;
    const overlay = new RttEngine(state.engine, 64, 64); owned.push(overlay);
    pbrMesh.material = new PbrMaterial({ metallic: 1, baseColor: [0, 0, 0, .5], alphaMode: 'blend', emissiveFactor: [1, .5, .25] });
    basicMesh.material = new BasicMaterial({ blending: 'additive', color: new ColorLinear(.5, .25, .1, .4) });
    const background = [.1, .2, .3];
    for (const fxaa of [false, true]) {
      const encoder = device.createCommandEncoder();
      encoder.beginRenderPass({ colorAttachments: [{ view: overlay.getOutputView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: .1, g: .2, b: .3, a: 1 } }] }).end();
      device.queue.submit([encoder.finish()]);
      state.views = [view('output-overlay', overlay, { loadOp: 'load' })];
      if (fxaa) state.render3d.passes.push(new FxaaPass());
      await frame(`alpha-and-additive-overlay${fxaa ? '-fxaa' : ''}`);
      expect(await pixel(device, overlay.colorTexture, 16, 32), [...[1, .5, .25].map((v, i) => display(v) * .5 + background[i] * .5), 1], 'alpha output composition');
      expect(await pixel(device, overlay.colorTexture, 48, 32), [...[.2, .1, .04].map((v, i) => display(v) + background[i]), 1], 'zero coverage additive output');
      expect(await pixel(device, overlay.colorTexture, 32, 1), [...background, 1], 'uncovered output preserved destination');
    }
    state.render3d.passes.length = 0;
    pbrMesh.material = pbr; basicMesh.material = basic; state.views = [mainView, hdrView];
    state.render3d.toneMapping = 'none'; state.render3d.exposure = .1;
    expect(await frame('tone-mapping-disabled'), [encode(.4), encode(.2), encode(.1), 1], 'disabled curve retains transfer');
    state.render3d.toneMapping = 'reinhard'; state.render3d.exposure = 1;

    // Render a local viewport into only the right half of the existing output.
    state.views = [view('output-viewport', target, { viewport: { x: 32, y: 0, width: 32, height: 64 } })];
    const preserved = await pixel(device, target.colorTexture, 16, 32);
    await frame('offset-viewport');
    expect(await pixel(device, target.colorTexture, 16, 32), preserved, 'viewport preserved other view');
    expect(await pixel(device, target.colorTexture, 40, 32), [display(4), display(2), display(1), 1], 'viewport source coordinates');

    const skyEntity = new Entity('output-sky').addComponent(new Sky({ exposure: 20 }));
    state.world.addEntity(skyEntity); state.views = [hdrView];
    await frame('sky-linear-radiance');
    const sky = await pixel(device, hdr.colorTexture, 16, 1);
    check(sky.slice(0, 3).some(value => value > 1), `sky was mapped before output: ${sky}`);
    state.world.removeEntity(skyEntity);
    pbr.doubleSided = true;
    const mirror = new PlanarMirror({ width: 64, height: 64, maxBounces: 1, localNormal: [0, 0, 1] });
    state.world.addEntity(new Entity('output-mirror').addComponent(new Transform3D().setTranslation(0, 0, -1))
      .addComponent(new Mesh3D(quad(-.9, .9), new BasicMaterial())).addComponent(mirror));
    state.views = [mainView]; state.render3d.checkEntityManager(state.world);
    await frame('reflection-retains-linear-hdr');
    const reflection = mirror.material.getReflection(mainView.key);
    check(reflection?.texture.format === 'rgba16float', `reflection target must retain HDR: ${reflection?.texture.format}, ${JSON.stringify(state.render3d.lastMirrorPlanStats)}`);
    const reflected = await readFloatTexture(device, reflection.texture);
    check(reflected.some((r, i) => i % 4 === 0 && Math.abs(r - 4) < .02 && Math.abs(reflected[i + 1] - 2) < .02 && Math.abs(reflected[i + 2] - 1) < .02), 'reflection lost original emission radiance');

    await device.queue.onSubmittedWorkDone();
    const validation = await device.popErrorScope(); if (validation) errors.push(validation.message);
    check(errors.length === 0, errors.join('\n'));
  } finally {
    if (state) await destroyRealRendererBenchmarkScenario(state);
    for (const resource of owned) resource.destroy(); target.destroy(); device.destroy();
  }
  result.textContent = JSON.stringify({ schemaVersion: 1, suite: 'scene.linear-hdr-output', status: 'passed', role: 'diagnostic-regression',
    generatedAt: new Date().toISOString(), browser: navigator.userAgent, adapter: { vendor: adapter.info.vendor, architecture: adapter.info.architecture }, cases, validationErrors: errors });
  result.dataset.status = 'passed';
} catch (error) { result.textContent = error.stack ?? String(error); result.dataset.status = 'failed'; }
