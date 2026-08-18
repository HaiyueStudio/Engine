import assert from 'node:assert/strict';
import test from 'node:test';
import { getRenderProfile } from '../dist/core.js';
import { PBR_COMPATIBILITY_CONTRACT, PBR_SHADER_CONTRACT } from '../dist/material.js';
import { PipelineWarmupPlan } from '../dist/scene.js';
import { Render3DSystem } from '../dist/systems.js';
import {
  BasicMaterial,
  DirectionalLight,
  Entity,
  EnvironmentLight,
  Geometry3D,
  Mesh3D,
  PbrMaterial,
} from '../dist/index.js';
import { deserializeEntityCore, serializeEntityCore } from '../dist/serialization.js';
import { createRenderCapabilities, resolveRenderProfileSettings } from '../dist/experimental.js';

function ensureGpuConstants() {
  globalThis.GPUBufferUsage ??= {
    COPY_DST: 1 << 0,
    UNIFORM: 1 << 1,
    STORAGE: 1 << 2,
    VERTEX: 1 << 3,
    INDEX: 1 << 4,
  };
  globalThis.GPUTextureUsage ??= {
    TEXTURE_BINDING: 1 << 0,
    COPY_DST: 1 << 1,
    RENDER_ATTACHMENT: 1 << 2,
  };
  globalThis.GPUShaderStage ??= {
    VERTEX: 1 << 0,
    FRAGMENT: 1 << 1,
  };
}

function createPbrLifecycleEngine(log, loadTexture) {
  ensureGpuConstants();
  let nextId = 1;
  const device = {
    features: new Set(),
    queue: {
      writeBuffer(...args) { log.push(['writeBuffer', ...args]); },
      writeTexture() {},
    },
    createBuffer(descriptor) {
      const buffer = {
        id: `buffer-${nextId++}`,
        descriptor,
        destroyed: false,
        destroy() {
          if (this.destroyed) return;
          this.destroyed = true;
          log.push(['destroyBuffer', this.id]);
        },
      };
      log.push(['createBuffer', buffer.id, descriptor]);
      return buffer;
    },
    createTexture(descriptor) {
      const texture = {
        id: `texture-${nextId++}`,
        descriptor,
        destroyed: false,
        createView(viewDescriptor) { return { texture: this, descriptor: viewDescriptor }; },
        destroy() {
          if (this.destroyed) return;
          this.destroyed = true;
          log.push(['destroyTexture', this.id]);
        },
      };
      log.push(['createTexture', texture.id, descriptor]);
      return texture;
    },
    createSampler(descriptor = {}) { return { id: `sampler-${nextId++}`, descriptor }; },
    createBindGroupLayout(descriptor) { return { descriptor }; },
    createPipelineLayout(descriptor) { return { descriptor }; },
    createShaderModule(descriptor) { return { descriptor }; },
    createBindGroup(descriptor) {
      const bindGroup = { id: `bind-group-${nextId++}`, descriptor };
      log.push(['createBindGroup', bindGroup]);
      return bindGroup;
    },
    createRenderPipeline(descriptor) {
      const pipeline = { id: `pipeline-${nextId++}`, descriptor };
      log.push(['createRenderPipeline', pipeline]);
      return pipeline;
    },
  };
  return {
    device,
    assetManager: { loadTexture },
    defaults: {},
    format: 'bgra8unorm',
    reverseZ: false,
    msaaSamples: 1,
    renderProfile: 'batched',
    getDepthFormat() { return 'depth24plus'; },
    registerDeviceRecoveryParticipant() { return () => log.push(['unregisterRecovery']); },
  };
}

function externalTexture(label) {
  return {
    label,
    createView(descriptor) { return { externalTexture: this, descriptor }; },
  };
}

function capabilities(profile, features = []) {
  const supported = new Set(features);
  return createRenderCapabilities(profile, { features: supported }, { features: supported }, 'bgra8unorm');
}

test('stable RenderProfiles form an ordered product contract', () => {
  assert.equal(getRenderProfile('simple').settings.gpuDrivenBatches, false);
  assert.equal(getRenderProfile('batched').settings.gpuDrivenBatches, true);
  assert.equal(getRenderProfile('gpu-driven').settings.gpuDrivenIndirectDraws, true);
  assert.equal(getRenderProfile('diagnostic').settings.gpuTimestampQuery, true);
  assert.equal(Object.isFrozen(getRenderProfile('batched').settings), true);
});

test('shadow and environment product settings survive core scene serialization', () => {
  const entity = new Entity('Lighting');
  entity.addComponent(new DirectionalLight({ castShadow: true, shadow: { mapSize: 2048, extent: 36, bias: 0.002 } }));
  const environmentEntity = new Entity('Environment');
  environmentEntity.addComponent(new EnvironmentLight({ intensity: 1.4, rotation: 0.5, diffuseColor: [0.1, 0.2, 0.4] }));
  entity.addChild(environmentEntity);
  const restored = deserializeEntityCore(serializeEntityCore(entity));
  const sun = restored.getComponent(DirectionalLight);
  const environment = restored.children[0].getComponent(EnvironmentLight);
  assert.equal(sun.castShadow, true);
  assert.equal(sun.shadow.mapSize, 2048);
  assert.equal(sun.shadow.extent, 36);
  assert.equal(environment.intensity, 1.4);
  assert.equal(environment.rotation, 0.5);
  assert.equal(environment.diffuseColor.b, 0.4);
});

test('GPU-driven negotiation reports every fallback instead of silently disabling it', () => {
  const result = capabilities('diagnostic');
  assert.equal(result.report.requestedProfile, 'diagnostic');
  assert.equal(result.report.enabledProfile, 'batched');
  assert.equal(result.report.degraded, true);
  const indirect = result.report.decisions.find(item => item.capability === 'gpu-driven-indirect-draws');
  const timing = result.report.decisions.find(item => item.capability === 'gpu-timestamp-query');
  assert.deepEqual(
    [indirect.requested, indirect.enabled, indirect.fallback],
    [true, false, 'material-batching'],
  );
  assert.match(indirect.reason, /indirect-first-instance/);
  assert.equal(timing.fallback, 'cpu-frame-timing');
  assert.equal(resolveRenderProfileSettings('gpu-driven', new Set()).gpuDrivenCulling, false);
});

test('diagnostic profile remains enabled only when its optional device features exist', () => {
  const result = capabilities('diagnostic', ['indirect-first-instance', 'timestamp-query']);
  assert.equal(result.report.enabledProfile, 'diagnostic');
  assert.equal(result.report.degraded, false);
});

test('Render3DSystem switches profiles through resolved runtime capabilities', () => {
  const engine = createPbrLifecycleEngine([], async () => { throw new Error('not used'); });
  engine.device.features.add('indirect-first-instance');
  const system = new Render3DSystem(engine, new Entity('Camera'), {
    registerDefaultMaterialRenderers: false,
    renderProfile: 'batched',
  });
  assert.equal(system.renderProfile, 'batched');
  assert.equal(system.renderSettings.gpuDrivenBatches, true);
  assert.equal(system.setRenderProfile('simple'), system);
  assert.equal(system.renderSettings.gpuDrivenBatches, false);
  system.setRenderProfile('gpu-driven');
  assert.equal(system.renderProfile, 'gpu-driven');
  assert.equal(system.renderSettings.gpuDrivenIndirectDraws, true);
  system.destroy();
});

test('PBR material variants preserve a base state and share one extensible shader contract', () => {
  const material = new PbrMaterial({
    baseColor: [0.2, 0.4, 0.8, 1],
    metallic: 0.2,
    roughness: 0.7,
    clearcoatFactor: 0.35,
    clearcoatRoughnessFactor: 0.4,
    clearcoatNormalScale: 0.8,
    ior: 1.33,
    specularFactor: 0.72,
    specularColorFactor: [1.2, 0.8, 0.6],
    sheenColorFactor: [0.7, 0.2, 0.4],
    sheenRoughnessFactor: 0.48,
    transmissionFactor: 0.65,
    thicknessFactor: 0.5,
    attenuationDistance: 3,
    attenuationColor: [0.9, 0.7, 0.5],
    textureMappings: { baseColor: { texCoord: 1, offset: [0.25, 0.5], rotation: 0.3, scale: [2, 3] } },
    variants: [{
      name: 'metal',
      state: {
        metallic: 1,
        roughness: 0.16,
        clearcoatFactor: 1,
        clearcoatRoughnessFactor: 0.12,
        ior: 1.8,
        specularFactor: 0.4,
        sheenColorFactor: [0.1, 0.6, 0.8],
        sheenRoughnessFactor: 0.24,
        transmissionFactor: 0.2,
        thicknessFactor: 0.1,
      },
    }],
  });
  const initialVersion = material.revision;
  assert.equal(material.getShaderContract(), PBR_SHADER_CONTRACT);
  assert.equal(PBR_SHADER_CONTRACT.version, 8);
  assert.equal(PBR_SHADER_CONTRACT.features.includes('clearcoat'), true);
  assert.equal(PBR_SHADER_CONTRACT.features.includes('ior'), true);
  assert.equal(PBR_SHADER_CONTRACT.features.includes('specular'), true);
  assert.equal(PBR_SHADER_CONTRACT.features.includes('sheen'), true);
  assert.equal(PBR_SHADER_CONTRACT.features.includes('transmission'), true);
  assert.equal(PBR_SHADER_CONTRACT.features.includes('volume'), true);
  assert.equal(PBR_SHADER_CONTRACT.features.includes('gpu-morph'), true);
  assert.equal(PBR_SHADER_CONTRACT.features.includes('skinning'), true);
  assert.deepEqual(PBR_SHADER_CONTRACT.vertexSemantics, ['POSITION', 'NORMAL', 'TEXCOORD_0', 'TEXCOORD_1']);
  assert.deepEqual(material.getTextureMapping('baseColor'), {
    texCoord: 1,
    offset: [0.25, 0.5],
    rotation: 0.3,
    scale: [2, 3],
  });
  assert.equal(material.getTextureMapping('normal').texCoord, 0);
  assert.deepEqual(material.variantNames, ['metal']);
  material.setVariant('metal');
  assert.equal(material.metallic, 1);
  assert.equal(material.roughness, 0.16);
  assert.equal(material.clearcoatFactor, 1);
  assert.equal(material.clearcoatRoughnessFactor, 0.12);
  assert.equal(material.ior, 1.8);
  assert.equal(material.specularFactor, 0.4);
  assert.deepEqual(material.sheenColorFactor, [0.1, 0.6, 0.8]);
  assert.equal(material.sheenRoughnessFactor, 0.24);
  assert.equal(material.transmissionFactor, 0.2);
  assert.equal(material.thicknessFactor, 0.1);
  assert.ok(material.revision > initialVersion);
  const clone = material.clone();
  assert.equal(clone.activeVariant, 'metal');
  assert.equal(clone.clearcoatNormalScale, 0.8);
  assert.deepEqual(clone.specularColorFactor, [1.2, 0.8, 0.6]);
  assert.deepEqual(clone.sheenColorFactor, [0.1, 0.6, 0.8]);
  assert.deepEqual(clone.attenuationColor, [0.9, 0.7, 0.5]);
  assert.deepEqual(clone.getTextureMapping('baseColor'), material.getTextureMapping('baseColor'));
  clone.setVariant(null);
  assert.equal(clone.metallic, 0.2);
  assert.deepEqual(clone.sheenColorFactor, [0.7, 0.2, 0.4]);
  material.setVariant(null);
  assert.equal(material.metallic, 0.2);
  assert.equal(material.roughness, 0.7);
  assert.equal(material.clearcoatFactor, 0.35);
  assert.equal(material.ior, 1.33);
  assert.equal(material.specularFactor, 0.72);
  assert.deepEqual(material.sheenColorFactor, [0.7, 0.2, 0.4]);
  assert.equal(material.sheenRoughnessFactor, 0.48);
  assert.equal(material.transmissionFactor, 0.65);
  assert.equal(material.thicknessFactor, 0.5);
  assert.equal(material.attenuationDistance, 3);
  assert.throws(() => material.setVariant('missing'), /Unknown PBR material variant/);
  assert.throws(() => material.setTextureMapping('baseColor', { texCoord: 2 }), /texCoord must be 0 or 1/);
  assert.throws(() => { material.attenuationDistance = 0; }, /greater than 0 or Infinity/);
  const defaultVolume = new PbrMaterial();
  assert.equal(defaultVolume.transmissionFactor, 0);
  assert.equal(defaultVolume.thicknessFactor, 0);
  assert.equal(defaultVolume.attenuationDistance, Infinity);
  assert.deepEqual(defaultVolume.attenuationColor, [1, 1, 1]);
});

test('PBR compatibility contract fixes color-space, UV, mip and per-slot sampler semantics', () => {
  assert.deepEqual(PBR_COMPATIBILITY_CONTRACT.supportedUvSets, [0, 1]);
  assert.equal(PBR_COMPATIBILITY_CONTRACT.uvSemanticMapping, 'dynamic-per-primitive');
  assert.equal(PBR_COMPATIBILITY_CONTRACT.uvChannelCapacity, 2);
  assert.equal(PBR_COMPATIBILITY_CONTRACT.textureSlots.baseColor.colorSpace, 'srgb');
  assert.equal(PBR_COMPATIBILITY_CONTRACT.textureSlots.emissive.format, 'rgba8unorm-srgb');
  assert.equal(PBR_COMPATIBILITY_CONTRACT.textureSlots.normal.colorSpace, 'linear');
  assert.equal(PBR_COMPATIBILITY_CONTRACT.textureSlots.clearcoat.colorSpace, 'linear');
  assert.equal(PBR_COMPATIBILITY_CONTRACT.textureSlots.clearcoatRoughness.format, 'rgba8unorm');
  assert.equal(PBR_COMPATIBILITY_CONTRACT.textureSlots.clearcoatNormal.colorSpace, 'linear');
  assert.equal(PBR_COMPATIBILITY_CONTRACT.textureSlots.specular.colorSpace, 'linear');
  assert.equal(PBR_COMPATIBILITY_CONTRACT.textureSlots.specularColor.format, 'rgba8unorm-srgb');
  assert.equal(PBR_COMPATIBILITY_CONTRACT.textureSlots.sheenColor.format, 'rgba8unorm-srgb');
  assert.equal(PBR_COMPATIBILITY_CONTRACT.textureSlots.sheenRoughness.colorSpace, 'linear');
  assert.equal(PBR_COMPATIBILITY_CONTRACT.textureSlots.transmission.colorSpace, 'linear');
  assert.equal(PBR_COMPATIBILITY_CONTRACT.textureSlots.thickness.format, 'rgba8unorm');
  assert.equal(PBR_COMPATIBILITY_CONTRACT.runtimeImageMipmaps, 'generated-full-chain');
  assert.equal(PBR_COMPATIBILITY_CONTRACT.compressedTextureMipmaps, 'source-provided');

  const material = new PbrMaterial({
    samplers: {
      baseColor: { addressModeU: 'clamp-to-edge', minFilter: 'nearest' },
      normal: { addressModeU: 'mirror-repeat', minFilter: 'linear' },
      clearcoatNormal: { addressModeV: 'clamp-to-edge', minFilter: 'linear' },
    },
  });
  assert.equal('sampler' in material, false);
  assert.equal(material.getTextureSampler('baseColor').addressModeU, 'clamp-to-edge');
  assert.equal(material.getTextureSampler('normal').addressModeU, 'mirror-repeat');
  assert.equal(material.getTextureSampler('emissive'), null);
  assert.equal(material.getTextureSampler('clearcoatNormal').addressModeV, 'clamp-to-edge');
  material.setTextureSampler('occlusion', { addressModeV: 'clamp-to-edge' });
  assert.equal(material.getTextureSampler('occlusion').addressModeV, 'clamp-to-edge');
  assert.equal(material.clone().getTextureSampler('normal').addressModeU, 'mirror-repeat');
});

test('PBR clearcoat on/off variants use distinct pipeline cache entries', () => {
  const log = [];
  const engine = createPbrLifecycleEngine(log, async () => { throw new Error('not used'); });
  const system = new Render3DSystem(engine, new Entity('Camera'), { registerDefaultMaterialRenderers: false });
  const renderer = system._requirePbrRenderer();
  const geometry = {
    topology: 'triangle-list',
    cullMode: 'back',
    frontFace: 'ccw',
    textureCoordinateLayoutKey: 'none',
  };
  const basePipeline = renderer._getPipeline(geometry, new PbrMaterial());
  const clearcoatPipeline = renderer._getPipeline(geometry, new PbrMaterial({ clearcoatFactor: 1 }));
  assert.notEqual(basePipeline, clearcoatPipeline);
  assert.equal(renderer.getPipelineCacheDiagnostics().misses, 2);
  assert.equal(renderer.getPipelineCacheDiagnostics().size, 2);
  const warmup = new PipelineWarmupPlan('PBR clearcoat variants');
  renderer.contributePipelineWarmup(warmup);
  assert.equal(warmup.snapshot().total, 24, 'opaque/mask/blend × no-UV/UV0 × clearcoat off/on × transmission off/on');
  system.destroy();
});

test('PBR renders GPU morph normals and skinning through one deformation ABI', () => {
  const log = [];
  const engine = createPbrLifecycleEngine(log, async () => { throw new Error('not used'); });
  const system = new Render3DSystem(engine, new Entity('Camera'), { registerDefaultMaterialRenderers: false });
  const renderer = system._requirePbrRenderer();
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const normals = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]);
  const joints = new Float32Array(12);
  const weights = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]);
  const geometry = new Geometry3D({
    positions,
    normals,
    morphTargets: [{
      positions: new Float32Array([0, 0, 0, 0.2, 0, 0, 0, 0.2, 0]),
      normals: new Float32Array([0, 0.1, 0, 0, 0.1, 0, 0, 0.1, 0]),
    }],
    morphWeights: [0.25],
    skinning: { joints, weights, jointMatrices: identityMatrix() },
  });
  const material = new PbrMaterial();
  const worldMatrix = identityMatrix();
  const sceneFrame = {
    frameId: 1,
    phaseRevision: 1,
    cameraEntityId: 1,
    data: new Float32Array(68),
  };
  renderer.beginView(sceneFrame);
  renderer.prepareObjects([{ entityId: 501, geometry, material, worldMatrix }]);
  renderer.flushUploads();

  const object = renderer._objects.get(501);
  const base = object.modelSlot * renderer._objectTable.floatsPerSlot;
  assert.deepEqual(Array.from(renderer._objectTable.data.subarray(base + 32, base + 38)), [0.25, 0, 0, 0, 1, 1]);

  const bindGroups = [];
  const vertexBuffers = [];
  renderer.render({
    setPipeline() {},
    setBindGroup(index) { bindGroups.push(index); },
    setVertexBuffer(index) { vertexBuffers.push(index); },
    setIndexBuffer() {},
    draw() {},
    drawIndexed() {},
  }, 501, geometry, material, worldMatrix);
  renderer.endView();

  assert.deepEqual(bindGroups, [0, 1, 2, 3]);
  assert.deepEqual(vertexBuffers, [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.equal(renderer._pipelineLayout.descriptor.bindGroupLayouts.length, 4);
  assert.equal(renderer._baseShader.descriptor.code.includes('fn applyMorphNormal'), true);
  assert.equal(renderer._baseShader.descriptor.code.includes('@group(3) @binding(8) var<storage, read> skin'), true);
  assert.equal(renderer._getPipeline(geometry, material).descriptor.vertex.buffers.length, 8);

  const writesBeforePose = log.filter(entry => entry[0] === 'writeBuffer'
    && entry[1]?.descriptor?.label === 'PbrRenderer.skinMatrices').length;
  const nextPose = identityMatrix();
  nextPose[12] = 0.5;
  geometry.updateSkinningMatrices(nextPose);
  renderer.prepareObjects([{ entityId: 501, geometry, material, worldMatrix }]);
  assert.equal(log.filter(entry => entry[0] === 'writeBuffer'
    && entry[1]?.descriptor?.label === 'PbrRenderer.skinMatrices').length, writesBeforePose + 1);

  system.destroy();
});

test('motion vectors retain per-view previous morph weights and skin poses', () => {
  const log = [];
  const engine = createPbrLifecycleEngine(log, async () => { throw new Error('not used'); });
  const system = new Render3DSystem(engine, new Entity('Camera'), { registerDefaultMaterialRenderers: false });
  const renderer = system._postScenePasses._requireMotionVectorRenderer();
  const joints = new Float32Array(12);
  const weights = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]);
  const geometry = new Geometry3D({
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    morphTargets: [{ positions: new Float32Array([0, 0, 0, 0.2, 0, 0, 0, 0.2, 0]) }],
    morphWeights: [0.25],
    skinning: { joints, weights, jointMatrices: identityMatrix() },
  });
  const worldMatrix = identityMatrix();
  const context = {};
  const passLog = [];
  const pass = {
    setPipeline() {},
    setBindGroup(index) { passLog.push(['bindGroup', index]); },
    setVertexBuffer(index) { passLog.push(['vertexBuffer', index]); },
    setIndexBuffer() {},
    draw() {},
    drawIndexed() {},
  };
  const sceneFrame = frameId => ({
    frameId,
    phaseRevision: frameId,
    cameraEntityId: 1,
    data: new Float32Array(68),
  });
  const view = frameId => ({ viewKey: 'main', frameId, cameraId: 1, historyRevision: 0 });

  renderer.beginView(sceneFrame(1), view(1), context);
  renderer.render(pass, 701, geometry, worldMatrix);
  renderer.endView(view(1));

  const nextPose = identityMatrix();
  nextPose[12] = 0.5;
  geometry.setMorphWeights([0.75]);
  geometry.updateSkinningMatrices(nextPose);
  passLog.length = 0;
  renderer.beginView(sceneFrame(2), view(2), context);
  renderer.render(pass, 701, geometry, worldMatrix);
  const entity = renderer._views.get('main').entities.get(701);
  assert.equal(entity.uniformData[48], 0.75);
  assert.equal(entity.uniformData[52], 0.25, 'continuous frames use the prior morph weight');
  assert.equal(entity.previousSkinMatrices[12], 0.5);
  assert.notEqual(entity.currentSkinBuffer, entity.previousSkinBuffer);
  assert.deepEqual(passLog.filter(entry => entry[0] === 'bindGroup').map(entry => entry[1]), [0, 1, 2]);
  assert.deepEqual(passLog.filter(entry => entry[0] === 'vertexBuffer').map(entry => entry[1]), [0, 1, 2, 3, 4]);
  renderer.endView(view(2));

  geometry.setMorphWeights([1]);
  const resetView = { viewKey: 'main', frameId: 3, cameraId: 1, historyRevision: 1 };
  renderer.beginView(sceneFrame(3), resetView, context);
  renderer.render(pass, 701, geometry, worldMatrix);
  assert.equal(entity.uniformData[48], 1);
  assert.equal(entity.uniformData[52], 1, 'history reset makes previous deformation equal current deformation');
  renderer.endView(resetView);

  system.destroy();
});

test('PBR scene lighting uniforms upload only when their revisions change', () => {
  const log = [];
  const engine = createPbrLifecycleEngine(log, async () => { throw new Error('not used'); });
  const system = new Render3DSystem(engine, new Entity('Camera'), { registerDefaultMaterialRenderers: false });
  const pbr = system._requirePbrRenderer();
  const environment = new EnvironmentLight({ intensity: 1 });
  const shadow = {
    enabled: true,
    view: { label: 'revision-shadow-view' },
    sampler: { label: 'revision-shadow-sampler' },
    lightViewProjection: new Float32Array(16),
    mapSize: 256,
    bias: 0.001,
    normalBias: 0.02,
  };
  const scene = {
    lightingRevision: 1,
    shadowRevision: 1,
    lights: [],
    environment,
    shadow,
  };
  const countSceneWrites = label => log.filter(entry => (
    entry[0] === 'writeBuffer' && entry[1]?.descriptor?.label === label
  )).length;

  log.length = 0;
  pbr.beginScene(scene);
  assert.deepEqual([
    countSceneWrites('PbrRenderer.lights'),
    countSceneWrites('PbrRenderer.environment'),
    countSceneWrites('PbrRenderer.shadow'),
  ], [1, 1, 1]);
  assert.equal(
    log.find(entry => entry[0] === 'writeBuffer' && entry[1]?.descriptor?.label === 'PbrRenderer.shadow')?.[5],
    80,
    'a one-shadow scene uploads one packed slot instead of the full fixed-capacity buffer',
  );

  pbr.beginScene(scene);
  assert.deepEqual([
    countSceneWrites('PbrRenderer.lights'),
    countSceneWrites('PbrRenderer.environment'),
    countSceneWrites('PbrRenderer.shadow'),
  ], [1, 1, 1], 'another view only performs the constant-time revision check');

  environment.intensity = 2;
  environment.rotation = Math.PI / 2;
  scene.lightingRevision++;
  pbr.beginScene(scene);
  assert.deepEqual([
    countSceneWrites('PbrRenderer.lights'),
    countSceneWrites('PbrRenderer.environment'),
    countSceneWrites('PbrRenderer.shadow'),
  ], [2, 2, 1]);
  assert.ok(
    Math.abs(pbr._environmentData[9] - Math.PI / 2) < 1e-6,
    'environment rotation reaches the PBR uniform payload',
  );

  scene.shadowRevision++;
  pbr.beginScene(scene);
  assert.deepEqual([
    countSceneWrites('PbrRenderer.lights'),
    countSceneWrites('PbrRenderer.environment'),
    countSceneWrites('PbrRenderer.shadow'),
  ], [2, 2, 2]);
  system.destroy();
});

test('PBR environment is disabled without a component and default fallback colors are achromatic', () => {
  const log = [];
  const engine = createPbrLifecycleEngine(log, async () => { throw new Error('not used'); });
  const system = new Render3DSystem(engine, new Entity('Camera'), { registerDefaultMaterialRenderers: false });
  const pbr = system._requirePbrRenderer();

  pbr.updateEnvironment(null, false);
  assert.deepEqual(Array.from(pbr._environmentData.slice(0, 12)), [
    0, 0, 0, 1,
    0, 0, 0, 1,
    0, 0, 0, 0,
  ]);

  pbr.updateEnvironment(new EnvironmentLight(), false);
  assert.ok(Math.abs(pbr._environmentData[0] - pbr._environmentData[1]) < 1e-7);
  assert.ok(Math.abs(pbr._environmentData[1] - pbr._environmentData[2]) < 1e-7);
  assert.ok(Math.abs(pbr._environmentData[4] - pbr._environmentData[5]) < 1e-7);
  assert.ok(Math.abs(pbr._environmentData[5] - pbr._environmentData[6]) < 1e-7);
  assert.equal(pbr._environmentData[8], 1);
  system.destroy();
});

test('PBR packs three directional shadow matrices and array layers into one scene binding', () => {
  const log = [];
  const engine = createPbrLifecycleEngine(log, async () => { throw new Error('not used'); });
  const system = new Render3DSystem(engine, new Entity('Camera'), { registerDefaultMaterialRenderers: false });
  const pbr = system._requirePbrRenderer();
  const arrayView = { label: 'three-layer-shadow-array' };
  const sampler = { label: 'shadow-comparison-sampler' };
  const shadows = Array.from({ length: 3 }, (_, layer) => {
    const lightViewProjection = new Float32Array(16);
    lightViewProjection[0] = layer + 11;
    return {
      enabled: true,
      view: { label: `shadow-layer-${layer}` },
      arrayView,
      layer,
      sampler,
      lightViewProjection,
      mapSize: 512,
      bias: 0.001 + layer * 0.001,
      normalBias: 0.02 + layer * 0.01,
    };
  });

  pbr.beginScene({
    lightingRevision: 1,
    shadowRevision: 1,
    lights: [],
    environment: null,
    shadow: shadows[0],
    shadows,
  });

  assert.deepEqual(
    [pbr._directionalShadowBinding.data[0], pbr._directionalShadowBinding.data[20], pbr._directionalShadowBinding.data[40]],
    [11, 12, 13],
  );
  assert.deepEqual(
    [pbr._directionalShadowBinding.data[16], pbr._directionalShadowBinding.data[36], pbr._directionalShadowBinding.data[56]],
    [1, 2, 3],
    'params.x encodes the sampled array layer plus one; zero stays the disabled sentinel',
  );
  assert.equal(
    log.find(entry => entry[0] === 'writeBuffer' && entry[1]?.descriptor?.label === 'PbrRenderer.shadow')?.[5],
    240,
    'three active shadows upload the complete three-slot ABI',
  );
  const sceneBindGroups = log
    .filter(entry => entry[0] === 'createBindGroup')
    .map(entry => entry[1].descriptor)
    .filter(descriptor => descriptor.entries.length === 12);
  assert.equal(sceneBindGroups.at(-1).entries[6].resource, arrayView);

  log.length = 0;
  pbr.beginScene({
    lightingRevision: 1,
    shadowRevision: 2,
    lights: [],
    environment: null,
    shadow: shadows[0],
    shadows: [shadows[0]],
  });
  assert.equal(
    log.find(entry => entry[0] === 'writeBuffer' && entry[1]?.descriptor?.label === 'PbrRenderer.shadow')?.[5],
    240,
    'the first shrink upload clears previously enabled trailing slots',
  );
  assert.deepEqual(
    [pbr._directionalShadowBinding.data[16], pbr._directionalShadowBinding.data[36], pbr._directionalShadowBinding.data[56]],
    [1, 0, 0],
  );

  log.length = 0;
  pbr.beginScene({
    lightingRevision: 1,
    shadowRevision: 3,
    lights: [],
    environment: null,
    shadow: shadows[0],
    shadows: [shadows[0]],
  });
  assert.equal(
    log.find(entry => entry[0] === 'writeBuffer' && entry[1]?.descriptor?.label === 'PbrRenderer.shadow')?.[5],
    80,
    'steady one-shadow updates stay on the single-slot upload path',
  );
  system.destroy();
});

test('PBR and directional-shadow resources follow runtime ownership and late-load lifecycle', async () => {
  const log = [];
  const releases = [];
  const textureLoadOptions = new Map();
  let resolveLateTexture;
  const loadedTexture = externalTexture('loaded-material');
  const lateTexture = externalTexture('late-material');
  const engine = createPbrLifecycleEngine(log, (source, options) => {
    textureLoadOptions.set(source, options);
    if (source === 'late.png') {
      return new Promise(resolve => { resolveLateTexture = resolve; });
    }
    return Promise.resolve({ value: loadedTexture, release: () => releases.push(source) });
  });
  const system = new Render3DSystem(engine, new Entity('Camera'), { registerDefaultMaterialRenderers: false });
  const pbr = system._requirePbrRenderer();

  const environmentTexture = externalTexture('environment');
  const shadowView = { label: 'shadow-view' };
  const shadowSampler = { label: 'shadow-sampler' };
  pbr.updateFrame(
    { frameId: 1, cameraEntityId: 1, data: new Float32Array(32) },
    [],
    new EnvironmentLight({ diffuseTexture: environmentTexture, specularTexture: null, intensity: 1, rotation: 0 }),
    {
      enabled: true,
      view: shadowView,
      sampler: shadowSampler,
      lightViewProjection: new Float32Array(16),
      mapSize: 256,
      bias: 0.001,
      normalBias: 0.02,
    },
  );
  const sceneBindGroups = log
    .filter(entry => entry[0] === 'createBindGroup')
    .map(entry => entry[1].descriptor)
    .filter(descriptor => descriptor.entries.length === 12);
  assert.equal(sceneBindGroups.some(descriptor => descriptor.entries[2].resource.externalTexture === environmentTexture), true);
  assert.equal(sceneBindGroups.some(descriptor => descriptor.entries[6].resource === shadowView), true);
  assert.equal(
    pbr._environmentData[11],
    1,
    'the WGSL f32 environment-texture flag must be written through the Float32 view',
  );

  const loadedMaterial = new PbrMaterial({
    baseColorTexture: 'loaded.png',
    clearcoatFactor: 1,
    clearcoatTexture: 'clearcoat.png',
    clearcoatRoughnessTexture: 'clearcoat-roughness.png',
    clearcoatNormalTexture: 'clearcoat-normal.png',
    ior: 1.45,
    specularFactor: 0.65,
    specularColorFactor: [1.1, 0.9, 0.7],
    specularTexture: 'specular.png',
    specularColorTexture: 'specular-color.png',
    sheenColorFactor: [0.8, 0.25, 0.45],
    sheenRoughnessFactor: 0.36,
    sheenColorTexture: 'sheen-color.png',
    sheenRoughnessTexture: 'sheen-roughness.png',
  });
  const loadedData = pbr._materials.ensure(loadedMaterial.id, () => pbr._createMaterial(loadedMaterial));
  pbr._syncMaterial(loadedMaterial, loadedData);
  await Promise.resolve();
  await Promise.resolve();
  pbr._syncMaterial(loadedMaterial, loadedData);
  const materialWritesBeforeStableSync = log.filter(
    entry => entry[0] === 'writeBuffer' && entry[1] === loadedData.buffer,
  ).length;
  const bindGroupsBeforeStableSync = log.filter(entry => entry[0] === 'createBindGroup').length;
  const originalSamplerKey = pbr._samplerKey;
  let stableSamplerKeyCalls = 0;
  pbr._samplerKey = function (...args) {
    stableSamplerKeyCalls++;
    return originalSamplerKey.apply(this, args);
  };
  pbr._syncMaterial(loadedMaterial, loadedData);
  pbr._samplerKey = originalSamplerKey;
  assert.equal(stableSamplerKeyCalls, 0, 'unchanged materials skip sampler descriptor serialization');
  assert.equal(
    log.filter(entry => entry[0] === 'writeBuffer' && entry[1] === loadedData.buffer).length,
    materialWritesBeforeStableSync,
    'unchanged materials skip uniform uploads',
  );
  assert.equal(
    log.filter(entry => entry[0] === 'createBindGroup').length,
    bindGroupsBeforeStableSync,
    'unchanged materials skip bind-group rebuilding',
  );
  assert.equal(loadedData.f32[16], 1);
  assert.equal(loadedData.f32[19], new Float32Array([1.45])[0]);
  assert.equal(loadedData.u32[20], 7, 'factor, roughness, and normal textures use distinct Clearcoat flag bits');
  assert.equal(loadedData.u32[21], 3, 'factor and color textures use distinct Specular flag bits');
  assert.equal(loadedData.u32[22], 3, 'color and roughness textures use distinct Sheen flag bits');
  assert.deepEqual(
    Array.from(loadedData.f32.slice(24, 28)),
    Array.from(new Float32Array([0.65, 1.1, 0.9, 0.7])),
  );
  assert.deepEqual(
    Array.from(loadedData.f32.slice(28, 32)),
    Array.from(new Float32Array([0.8, 0.25, 0.45, 0.36])),
  );
  assert.deepEqual(textureLoadOptions.get('loaded.png'), {
    format: 'rgba8unorm-srgb',
    mipmaps: 'generate',
    signal: pbr._rendererCore.signal,
  });
  for (const source of ['clearcoat.png', 'clearcoat-roughness.png', 'clearcoat-normal.png']) {
    assert.deepEqual(textureLoadOptions.get(source), {
      format: 'rgba8unorm',
      mipmaps: 'generate',
      signal: pbr._rendererCore.signal,
    });
  }
  assert.deepEqual(textureLoadOptions.get('specular.png'), {
    format: 'rgba8unorm',
    mipmaps: 'generate',
    signal: pbr._rendererCore.signal,
  });
  assert.deepEqual(textureLoadOptions.get('specular-color.png'), {
    format: 'rgba8unorm-srgb',
    mipmaps: 'generate',
    signal: pbr._rendererCore.signal,
  });
  assert.deepEqual(textureLoadOptions.get('sheen-color.png'), {
    format: 'rgba8unorm-srgb',
    mipmaps: 'generate',
    signal: pbr._rendererCore.signal,
  });
  assert.deepEqual(textureLoadOptions.get('sheen-roughness.png'), {
    format: 'rgba8unorm',
    mipmaps: 'generate',
    signal: pbr._rendererCore.signal,
  });
  pbr.releaseMaterialsNotIn(new Set());
  assert.deepEqual(new Set(releases), new Set([
    'loaded.png', 'clearcoat.png', 'clearcoat-roughness.png', 'clearcoat-normal.png',
    'specular.png', 'specular-color.png',
    'sheen-color.png', 'sheen-roughness.png',
  ]));
  assert.equal(loadedData.buffer.destroyed, true);

  const lateMaterial = new PbrMaterial({ baseColorTexture: 'late.png' });
  const lateData = pbr._materials.ensure(lateMaterial.id, () => pbr._createMaterial(lateMaterial));
  pbr._syncMaterial(lateMaterial, lateData);
  pbr.releaseMaterialsNotIn(new Set());
  resolveLateTexture({ value: lateTexture, release: () => releases.push('late.png') });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(releases.includes('late.png'), true, 'a texture resolving after material disposal must be released');

  const recoveryMaterial = new PbrMaterial({ clearcoatFactor: 1, clearcoatTexture: 'recovery-clearcoat.png' });
  const recoveryData = pbr._materials.ensure(recoveryMaterial.id, () => pbr._createMaterial(recoveryMaterial));
  pbr._syncMaterial(recoveryMaterial, recoveryData);
  await Promise.resolve();
  await Promise.resolve();
  system.suspendForDeviceLoss();
  assert.equal(recoveryData.buffer.destroyed, true);
  assert.equal(releases.filter(source => source === 'recovery-clearcoat.png').length, 1);
  system.recoverGpuResource(engine.device, new AbortController().signal);
  const recoveredPbr = system._requirePbrRenderer();
  assert.notEqual(recoveredPbr, pbr);
  const recoveredData = recoveredPbr._materials.ensure(recoveryMaterial.id, () => recoveredPbr._createMaterial(recoveryMaterial));
  recoveredPbr._syncMaterial(recoveryMaterial, recoveredData);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(recoveredData.buffer.destroyed, false);

  const shadow = system._requireShadowRenderer();
  const encoder = {
    beginRenderPass() {
      return { setBindGroup() {}, end() {} };
    },
  };
  const firstShadow = shadow.render(encoder, [], new DirectionalLight({ shadow: { mapSize: 64 } }));
  const sameShadow = shadow.render(encoder, [], new DirectionalLight({ shadow: { mapSize: 64 } }));
  const resizedShadow = shadow.render(encoder, [], new DirectionalLight({ shadow: { mapSize: 128 } }));
  assert.equal(firstShadow.view, sameShadow.view, 'same-size shadow target should be reused');
  assert.notEqual(firstShadow.view, resizedShadow.view, 'resizing must replace the shadow target');
  const layerZeroMatrix = Array.from(resizedShadow.lightViewProjection);
  const secondLayerShadow = shadow.renderLayer(
    encoder,
    [],
    new DirectionalLight({ direction: [1, -1, 0], shadow: { mapSize: 128 } }),
    1,
  );
  assert.equal(secondLayerShadow.arrayView, resizedShadow.arrayView);
  assert.notEqual(secondLayerShadow.view, resizedShadow.view);
  assert.notEqual(secondLayerShadow.lightViewProjection, resizedShadow.lightViewProjection);
  assert.deepEqual(Array.from(resizedShadow.lightViewProjection), layerZeroMatrix,
    'rendering another layer must not mutate the first light matrix before submission');
  assert.notDeepEqual(Array.from(secondLayerShadow.lightViewProjection), layerZeroMatrix);
  const shadowTextures = log.filter(entry => entry[0] === 'createTexture' && entry[2].label === 'Haiyue.directional-shadow-map');
  assert.equal(shadowTextures.length, 2);
  assert.equal(log.some(entry => entry[0] === 'destroyTexture' && entry[1] === shadowTextures[0][1]), true);

  const ownedTextureIds = log
    .filter(entry => entry[0] === 'createTexture' && entry[2].label !== 'Haiyue.directional-shadow-map')
    .map(entry => entry[1]);
  system.destroy();
  const destroyedTextureIds = new Set(log.filter(entry => entry[0] === 'destroyTexture').map(entry => entry[1]));
  for (const id of ownedTextureIds) assert.equal(destroyedTextureIds.has(id), true, `owned texture ${id} was not destroyed`);
  assert.equal(destroyedTextureIds.has(shadowTextures[1][1]), true, 'active shadow target was not destroyed');
  assert.equal(releases.filter(source => source === 'recovery-clearcoat.png').length, 2);
});

test('directional shadows isolate caster object tables per layer and share Basic/PBR deformation variants', () => {
  const log = [];
  const engine = createPbrLifecycleEngine(log, async () => { throw new Error('not used'); });
  const system = new Render3DSystem(engine, new Entity('Camera'), { registerDefaultMaterialRenderers: false });
  const shadow = system._requireShadowRenderer();
  const triangle = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const morphDelta = new Float32Array([0, 0, 0, 0.2, 0, 0, 0, 0.2, 0]);
  const joints = new Float32Array(12);
  const weights = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]);
  const jointMatrices = identityMatrix();
  const staticGeometry = new Geometry3D({ positions: triangle });
  const morphGeometry = new Geometry3D({
    positions: triangle,
    morphTargets: [{ positions: morphDelta }],
    morphWeights: [0.5],
  });
  const skinnedGeometry = new Geometry3D({
    positions: triangle,
    skinning: { joints, weights, jointMatrices },
  });
  const combinedGeometry = new Geometry3D({
    positions: triangle,
    morphTargets: [{ positions: morphDelta }],
    morphWeights: [0.25],
    skinning: { joints, weights, jointMatrices },
  });
  const basic = new BasicMaterial();
  const pbr = new PbrMaterial();
  const items = [
    shadowItem(1, staticGeometry, basic),
    shadowItem(2, morphGeometry, basic),
    shadowItem(3, skinnedGeometry, basic),
    shadowItem(4, combinedGeometry, basic),
    shadowItem(5, combinedGeometry, pbr),
    shadowItem(6, staticGeometry, basic, { center: [1_000_000, 0, 0], radius: 1 }),
  ];
  const passLog = [];
  const encoder = shadowEncoder(passLog);

  shadow.render(encoder, items, new DirectionalLight({ castShadow: true, shadow: { mapSize: 64, extent: 20 } }));

  const objectTableBuffers = log.filter(entry =>
    entry[0] === 'createBuffer' && entry[2].label === 'ShadowMapRenderer.objectTable');
  assert.equal(objectTableBuffers.length, 4,
    'three isolated layer tables are created and the active layer grows once instead of allocating per caster');
  assert.equal(objectTableBuffers.every(entry => (entry[2].usage & GPUBufferUsage.STORAGE) !== 0), true);
  assert.equal(log.filter(entry =>
    entry[0] === 'createBuffer' && entry[2].label === 'ShadowMapRenderer.lightCamera').length, 3,
  'each depth-array layer owns an immutable-at-submit camera uniform buffer');
  assert.equal(passLog.filter(entry => entry[0] === 'bindGroup' && entry[1] === 1).length, 1);
  assert.equal(passLog.filter(entry => entry[0] === 'bindGroup' && entry[1] === 3).length, 2);
  assert.deepEqual(
    passLog.filter(entry => entry[0] === 'draw').map(entry => entry[4]),
    [0, 1, 2, 3],
    'firstInstance selects each stable caster run and the light-frustum-rejected caster is omitted',
  );
  assert.deepEqual(
    passLog.filter(entry => entry[0] === 'draw').map(entry => entry[2]),
    [1, 1, 1, 2],
    'casters sharing geometry and deformation bindings use one direct instanced draw',
  );
  assert.equal(log.filter(entry => entry[0] === 'createRenderPipeline').length, 4);
  assert.equal(log.filter(entry =>
    entry[0] === 'createRenderPipeline' && entry[1].descriptor.vertex.buffers.length === 5).length, 2);

  passLog.length = 0;
  const replacementItems = items.slice(0, 5).map((item, index) => ({ ...item, entityId: index + 11 }));
  shadow.render(encoder, replacementItems, new DirectionalLight({ castShadow: true, shadow: { mapSize: 64, extent: 20 } }));
  assert.equal(log.filter(entry =>
    entry[0] === 'createBuffer' && entry[2].label === 'ShadowMapRenderer.objectTable').length, 4,
    'replacing the whole caster set reuses released slots before pass encoding');
  assert.equal(passLog.filter(entry => entry[0] === 'bindGroup' && entry[1] === 1).length, 1);
  assert.deepEqual(
    passLog.filter(entry => entry[0] === 'draw').map(entry => entry[2]),
    [2, 1, 1, 1],
    'shadow-order-independent submission restores stable slot order and instances compatible adjacent slots',
  );
  assert.equal(log.filter(entry => entry[0] === 'createRenderPipeline').length, 4);

  const warmup = new PipelineWarmupPlan('Directional shadow variants');
  shadow.contributePipelineWarmup(warmup);
  assert.equal(warmup.snapshot().total, 4);

  system.destroy();
  const objectTableIds = new Set(objectTableBuffers.map(entry => entry[1]));
  const destroyedObjectTables = new Set(log
    .filter(entry => entry[0] === 'destroyBuffer' && objectTableIds.has(entry[1]))
    .map(entry => entry[1]));
  assert.deepEqual(destroyedObjectTables, objectTableIds);
});

test('directional shadow layer batches sweep shared GPU caches only after unioning every encoded layer', () => {
  const log = [];
  const engine = createPbrLifecycleEngine(log, async () => { throw new Error('not used'); });
  const system = new Render3DSystem(engine, new Entity('Camera'), { registerDefaultMaterialRenderers: false });
  const shadow = system._requireShadowRenderer();
  const morphDelta = new Float32Array([0, 0, 0, 0.1, 0, 0, 0, 0.1, 0]);
  const geometryA = new Geometry3D({
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    morphTargets: [{ positions: morphDelta }],
    morphWeights: [0.5],
  });
  const geometryB = new Geometry3D({
    positions: new Float32Array([0, 0, 0, -1, 0, 0, 0, 1, 0]),
    morphTargets: [{ positions: morphDelta }],
    morphWeights: [0.25],
  });
  const material = new PbrMaterial();
  const geometrySweeps = [];
  const deformationSweeps = [];
  const releaseUnused = shadow._geometryCache.releaseUnused;
  const releaseDeformations = shadow._deformations.releaseNotIn;
  shadow._geometryCache.releaseUnused = (_owner, live) => geometrySweeps.push(new Set(live));
  shadow._deformations.releaseNotIn = live => deformationSweeps.push(new Set(live));

  shadow.prepareTarget(64);
  shadow.beginLayerBatch();
  shadow.renderLayer(shadowEncoder([]), [shadowItem(301, geometryA, material)], new DirectionalLight({ shadow: { mapSize: 64 } }), 0);
  shadow.renderLayer(shadowEncoder([]), [shadowItem(302, geometryB, material)], new DirectionalLight({ direction: [1, -1, 0], shadow: { mapSize: 64 } }), 1);
  assert.equal(geometrySweeps.length, 0, 'no layer may sweep resources still referenced by another unsubmitted pass');
  assert.equal(deformationSweeps.length, 0);
  shadow.endLayerBatch();
  assert.deepEqual(geometrySweeps.map(live => [...live].sort()), [[geometryA.id, geometryB.id].sort()]);
  assert.deepEqual(deformationSweeps.map(live => [...live].sort()), [[geometryA.id, geometryB.id].sort()]);

  shadow._geometryCache.releaseUnused = releaseUnused;
  shadow._deformations.releaseNotIn = releaseDeformations;
  system.destroy();
});

test('directional shadows direct-instance only contiguous geometry, pipeline, cull, and index-compatible casters', () => {
  const log = [];
  const engine = createPbrLifecycleEngine(log, async () => { throw new Error('not used'); });
  const system = new Render3DSystem(engine, new Entity('Camera'), { registerDefaultMaterialRenderers: false });
  const shadow = system._requireShadowRenderer();
  const positions = new Float32Array([
    -0.5, 0, 0,
    0.5, 0, 0,
    0.5, 1, 0,
    -0.5, 1, 0,
  ]);
  const indexed16 = new Geometry3D({
    positions,
    indices: new Uint16Array([0, 1, 2, 0, 2, 3]),
  });
  const indexed32 = new Geometry3D({
    positions,
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
  });
  const back = new BasicMaterial();
  const front = new BasicMaterial();
  const passLog = [];
  const encoder = shadowEncoder(passLog);
  const resolveCullMode = material => material === front ? 'front' : 'back';

  shadow.render(encoder, [
    shadowItem(101, indexed16, back),
    shadowItem(102, indexed16, back),
    shadowItem(103, indexed16, front),
    shadowItem(104, indexed16, back),
    shadowItem(105, indexed32, back),
  ], new DirectionalLight({ shadow: { mapSize: 64, extent: 20 } }), undefined, undefined, resolveCullMode);

  assert.deepEqual(
    passLog.filter(entry => entry[0] === 'drawIndexed').map(entry => [entry[2], entry[5]]),
    [[2, 0], [1, 2], [1, 3], [1, 4]],
    'only the first two casters share every draw binding and a continuous object-table range',
  );
  assert.deepEqual(
    passLog.filter(entry => entry[0] === 'indexBuffer').map(entry => entry[2]),
    ['uint16', 'uint16', 'uint16', 'uint32'],
    'index format changes split direct instance runs',
  );

  passLog.length = 0;
  shadow.render(encoder, [
    shadowItem(101, indexed16, back),
    shadowItem(103, indexed16, back),
  ], new DirectionalLight({ shadow: { mapSize: 64, extent: 20 } }), undefined, undefined, resolveCullMode);
  assert.deepEqual(
    passLog.filter(entry => entry[0] === 'drawIndexed').map(entry => [entry[2], entry[5]]),
    [[1, 0], [1, 2]],
    'compatible casters separated by a released object slot do not instance across the gap',
  );

  system.destroy();
});

test('directional shadow skinning and morph casters instance only with identical deformation bindings', () => {
  const log = [];
  const engine = createPbrLifecycleEngine(log, async () => { throw new Error('not used'); });
  const system = new Render3DSystem(engine, new Entity('Camera'), { registerDefaultMaterialRenderers: false });
  const shadow = system._requireShadowRenderer();
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const morphDeltaA = new Float32Array([0, 0, 0, 0.2, 0, 0, 0, 0.2, 0]);
  const morphDeltaB = new Float32Array([0, 0, 0, -0.2, 0, 0, 0, -0.2, 0]);
  const joints = new Float32Array(12);
  const weights = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]);
  const skinnedA = new Geometry3D({ positions, skinning: { joints, weights, jointMatrices: identityMatrix() } });
  const skinnedB = new Geometry3D({ positions, skinning: { joints, weights, jointMatrices: identityMatrix() } });
  const morphA = new Geometry3D({ positions, morphTargets: [{ positions: morphDeltaA }], morphWeights: [0.25] });
  const morphB = new Geometry3D({ positions, morphTargets: [{ positions: morphDeltaB }], morphWeights: [0.75] });
  const material = new PbrMaterial();
  const passLog = [];

  shadow.render(shadowEncoder(passLog), [
    shadowItem(201, skinnedA, material),
    shadowItem(202, skinnedA, material),
    shadowItem(203, skinnedB, material),
    shadowItem(204, skinnedB, material),
    shadowItem(205, morphA, material),
    shadowItem(206, morphA, material),
    shadowItem(207, morphB, material),
  ], new DirectionalLight({ shadow: { mapSize: 64, extent: 20 } }));

  assert.deepEqual(
    passLog.filter(entry => entry[0] === 'draw').map(entry => [entry[2], entry[4]]),
    [[2, 0], [2, 2], [2, 4], [1, 6]],
    'shared skin/morph bindings instance, while distinct deformation buffers split runs',
  );
  assert.equal(
    passLog.filter(entry => entry[0] === 'bindGroup' && entry[1] === 3).length,
    2,
    'each distinct skin binding is installed once for its direct instance run',
  );
  assert.equal(
    passLog.filter(entry => entry[0] === 'vertexBuffer' && entry[1] > 0).length,
    8,
    'each distinct morph binding installs its four morph vertex buffers once',
  );

  system.destroy();
});

function identityMatrix() {
  return new Float32Array([
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    0, 0, 0, 1,
  ]);
}

function shadowItem(entityId, geometry, material, worldSphere = null) {
  return {
    entityId,
    mesh: new Mesh3D(geometry, material),
    geometry,
    material,
    worldMatrix: identityMatrix(),
    viewDepth: 0,
    transparentOrder: 0,
    transparentDepthSort: false,
    worldSphere,
    lodLevel: -1,
  };
}

function shadowEncoder(passLog) {
  return {
    beginRenderPass() {
      return {
        setBindGroup(index, bindGroup) { passLog.push(['bindGroup', index, bindGroup]); },
        setPipeline(pipeline) { passLog.push(['pipeline', pipeline]); },
        setVertexBuffer(index, buffer) { passLog.push(['vertexBuffer', index, buffer]); },
        setIndexBuffer(buffer, format) { passLog.push(['indexBuffer', buffer, format]); },
        draw(vertexCount, instanceCount, firstVertex, firstInstance) {
          passLog.push(['draw', vertexCount, instanceCount, firstVertex, firstInstance]);
        },
        drawIndexed(indexCount, instanceCount, firstIndex, baseVertex, firstInstance) {
          passLog.push(['drawIndexed', indexCount, instanceCount, firstIndex, baseVertex, firstInstance]);
        },
        end() {},
      };
    },
  };
}
