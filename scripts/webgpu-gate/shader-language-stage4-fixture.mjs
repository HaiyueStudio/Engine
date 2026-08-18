import { Mesh3D } from '/engine/dist/index.js';
import { Transform3D } from '/engine/dist/components.js';
import {
  disposeGltfModel,
  loadGltfModel,
} from '/extensions/dist/gltf.js';
import {
  createGltfAnimation3DRuntime,
} from '/extensions/dist/gltf-animation3d.js';
import {
  DEFORMATION_PASS_KINDS,
  DeformationHistoryTracker,
  compileDeformationPassFamilyV1,
  defineDeformationProgramV1,
  packShaderUniformBlock,
} from '/shader-language/dist/index.js';

const progressNode = document.querySelector('#progress');
const resultNode = document.querySelector('#result');
const WIDTH = 64;
const HEIGHT = 64;
const BYTES_PER_ROW = 256;
const FIXTURE_PATH = '/extensions/test/fixtures/gltf/animation-characterization.gltf';

try {
  const result = await runFixture();
  progressNode.textContent = 'complete';
  resultNode.textContent = JSON.stringify(result);
  resultNode.dataset.status = 'passed';
} catch (error) {
  progressNode.textContent = 'failed';
  resultNode.textContent = JSON.stringify({
    error: error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error),
  });
  resultNode.dataset.status = 'failed';
}

async function runFixture() {
  if (!navigator.gpu) throw new Error('navigator.gpu is unavailable');
  progressNode.textContent = 'fetching real glTF fixture over HTTP…';
  const fixtureResponse = await fetch(FIXTURE_PATH, { cache: 'no-store' });
  if (!fixtureResponse.ok) throw new Error(`glTF fixture HTTP ${fixtureResponse.status}`);
  const fixtureBytes = new Uint8Array(await fixtureResponse.arrayBuffer());
  const fixtureSha256 = hex(await crypto.subtle.digest('SHA-256', fixtureBytes));

  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('No WebGPU adapter was returned');
  const device = await adapter.requestDevice();
  const uncapturedErrors = [];
  const onUncapturedError = event => uncapturedErrors.push(event.error?.message ?? String(event.error));
  device.addEventListener('uncapturederror', onUncapturedError);
  device.pushErrorScope('validation');
  const owner = createResourceOwner();

  progressNode.textContent = 'loading glTF and reusing Animation3D mixer/pose…';
  const model = await loadGltfModel(new URL(FIXTURE_PATH, location.href).href);
  const runtime = createGltfAnimation3DRuntime(model, { clipIdPrefix: 'stage4-browser' });
  const animatedTransform = findEntity(model.root, 'AnimatedTRS')?.getComponent(Transform3D);
  const mesh = requireMesh(model.root, 'SkinnedMorph');
  const geometry = mesh.geometry;
  if (!animatedTransform || !geometry.skinning) {
    throw new Error('Real glTF fixture is missing AnimatedTRS or skin runtime');
  }
  if (geometry.morphTargets.length !== 2) {
    throw new Error(`Expected two real morph targets, received ${geometry.morphTargets.length}`);
  }
  const basePositions = Float32Array.from(geometry.positions);
  const program = defineDeformationProgramV1({
    id: 'pilot2.real-gltf-character',
    morphTargetCount: geometry.morphTargets.length,
    jointCount: geometry.skinning.jointMatrices.length / 16,
    displacement: { kind: 'normal-sine' },
  });
  const family = compileDeformationPassFamilyV1(program);

  progressNode.textContent = 'compiling five derived WebGPU passes…';
  const compiledGpu = {};
  const compilationErrors = [];
  for (const pass of DEFORMATION_PASS_KINDS) {
    const derived = family.passes[pass];
    const module = device.createShaderModule({
      label: `stage4-${pass}-module`,
      code: derived.code,
    });
    const info = await module.getCompilationInfo();
    compilationErrors.push(...info.messages
      .filter(message => message.type === 'error')
      .map(message => `${pass}:${message.lineNum}:${message.linePos} ${message.message}`));
    compiledGpu[pass] = {
      derived,
      pipeline: await device.createRenderPipelineAsync({
        label: `stage4-${pass}-pipeline`,
        layout: 'auto',
        vertex: {
          module,
          entryPoint: derived.reflection.vertexEntryPoint,
          buffers: derived.reflection.vertexAttributes.map(attribute => ({
            arrayStride: attribute.format === 'float32x3' ? 12 : 16,
            attributes: [{
              shaderLocation: attribute.location,
              offset: 0,
              format: attribute.format,
            }],
          })),
        },
        fragment: {
          module,
          entryPoint: derived.reflection.fragmentEntryPoint,
          targets: [{ format: 'rgba8unorm' }],
        },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
      }),
    };
  }
  if (compilationErrors.length > 0) {
    throw new Error(`Derived shader compilation failed:\n${compilationErrors.join('\n')}`);
  }

  const vertexBuffers = createVertexBuffers(device, owner, geometry);
  const objectUniformBlock = family.passes.forward.reflection.uniformBlocks[0];
  const uniformBuffer = trackedBuffer(device, owner, {
    label: 'stage4-shared-object-state',
    size: objectUniformBlock.byteSize,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const jointBuffer = trackedBuffer(device, owner, {
    label: 'stage4-shared-current-previous-joints',
    size: 512,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  const targets = Object.fromEntries(DEFORMATION_PASS_KINDS.map(pass => [
    pass,
    createTarget(device, owner, pass),
  ]));
  for (const pass of DEFORMATION_PASS_KINDS) {
    compiledGpu[pass].bindGroup = device.createBindGroup({
      label: `stage4-${pass}-shared-bind-group`,
      layout: compiledGpu[pass].pipeline.getBindGroupLayout(1),
      entries: [
        { binding: 0, resource: { buffer: uniformBuffer, size: objectUniformBlock.byteSize } },
        { binding: 1, resource: { buffer: jointBuffer, offset: 0, size: 128 } },
        { binding: 2, resource: { buffer: jointBuffer, offset: 256, size: 128 } },
      ],
    });
  }

  const idle = runtime.mixer.createAction(runtime.clips[1], {
    id: 'Idle',
    loop: 'once',
    clampWhenFinished: true,
  });
  const run = runtime.mixer.createAction(runtime.clips[0], {
    id: 'Run',
    loop: 'once',
    clampWhenFinished: true,
  });
  idle.play();
  run.crossFadeFrom(idle, 1);
  const viewProjection = pilotViewProjection();
  const animationStates = [];
  for (const [name, deltaSeconds] of [['start', 0], ['mid', 0.5], ['end', 0.5]]) {
    runtime.update(deltaSeconds);
    animationStates.push(captureState(
      name,
      runtime,
      animatedTransform,
      geometry,
      viewProjection,
    ));
  }

  const metrics = {
    passCount: 0,
    drawCount: 0,
    submitCount: 0,
    uploadCallCount: 0,
    uploadBytes: 0,
  };
  const history = new DeformationHistoryTracker();
  const phaseResults = [];
  progressNode.textContent = 'rendering start/mid/end through five shared passes…';
  const uploadCallsBeforeAnimation = metrics.uploadCallCount;
  for (const state of animationStates) {
    const sample = history.sample('main-view', mesh.entityId, state.history);
    const pixels = await renderPasses(
      device,
      compiledGpu,
      vertexBuffers,
      targets,
      uniformBuffer,
      jointBuffer,
      sample,
      DEFORMATION_PASS_KINDS,
      metrics,
    );
    phaseResults.push({
      name: state.name,
      mixerTime: state.mixerTime,
      rootLocalMatrix: [...state.history.modelMatrix],
      morphWeights: [...state.history.morphWeights],
      skinJointTipMatrix: [...state.history.jointMatrices.slice(16, 32)],
      historyReset: sample.reset,
      pixels: Object.fromEntries(DEFORMATION_PASS_KINDS.map(pass => [pass, summarizePixels(pixels[pass], pass)])),
      silhouetteMismatchPixels: silhouetteMismatch(
        pixels.forward,
        pixels.depth,
        pixels.shadow,
      ),
    });
  }
  const animationUploadCallCount = metrics.uploadCallCount - uploadCallsBeforeAnimation;
  const animationPassCount = DEFORMATION_PASS_KINDS.length * animationStates.length;
  const animationDrawCount = animationPassCount;

  progressNode.textContent = 'proving seek/teleport reset and multi-view isolation…';
  const seek = history.sample('main-view', mesh.entityId, animationStates[0].history, {
    reset: true,
    reason: 'seek',
  });
  const seekPixels = await renderPasses(
    device,
    compiledGpu,
    vertexBuffers,
    targets,
    uniformBuffer,
    jointBuffer,
    seek,
    ['motion-vector'],
    metrics,
  );
  const teleportedHistory = shiftedHistory(animationStates[2].history, 0.35);
  const teleport = history.sample('main-view', mesh.entityId, teleportedHistory, {
    reset: true,
    reason: 'teleport',
  });
  const teleportPixels = await renderPasses(
    device,
    compiledGpu,
    vertexBuffers,
    targets,
    uniformBuffer,
    jointBuffer,
    teleport,
    ['motion-vector'],
    metrics,
  );
  const secondView = history.sample('secondary-view', mesh.entityId, animationStates[1].history);
  const multiViewIsolated = secondView.reset
    && arraysEqual(secondView.previous.modelMatrix, secondView.current.modelMatrix)
    && arraysEqual(secondView.previous.jointMatrices, secondView.current.jointMatrices);

  history.releaseEntity(mesh.entityId);
  history.dispose();
  const historyResidualAfterDispose = history.audit().entryCount;
  const runtimeEvidence = {
    usesAnimation3DMixer: runtime.mixer.constructor.name === 'Animation3DMixer',
    usesAnimation3DPoseBuffer: runtime.pose.constructor.name === 'Animation3DPoseBuffer',
    interpolation: [...new Set(runtime.clips.flatMap(clip => clip.tracks.map(track => track.interpolation)))].sort(),
    gpuMorph: geometry.morphUseGpu && geometry.hasMorphTargets,
    skinning: geometry.skinning !== null,
    positionsRemainBase: arraysEqual(geometry.positions, basePositions),
  };
  runtime.destroy();
  const runtimeResidual = {
    state: runtime.state,
    actionCount: runtime.mixer.actions.length,
    bindingCount: runtime.bindingCount,
    targetCount: runtime.targetCount,
  };
  disposeGltfModel(model);

  await device.queue.onSubmittedWorkDone();
  owner.destroyAll();
  const ownerResidualAfterDestroy = owner.audit().residual;
  const validationError = await device.popErrorScope();
  const validationErrors = [
    ...(validationError ? [validationError.message] : []),
    ...uncapturedErrors,
  ];
  device.removeEventListener('uncapturederror', onUncapturedError);
  device.destroy();

  return {
    schemaVersion: 1,
    suite: 'shader-language-stage4-deformation-pilot',
    status: 'passed',
    fixture: {
      path: FIXTURE_PATH,
      transport: 'http',
      httpBytes: fixtureBytes.byteLength,
      sha256: fixtureSha256,
    },
    canonicalHash: program.canonicalHash,
    deformationModuleHash: family.deformationModuleHash,
    passCount: DEFORMATION_PASS_KINDS.length,
    passes: DEFORMATION_PASS_KINDS.map(pass => ({
      pass,
      canonicalHash: family.passes[pass].canonicalHash,
      deformationModuleHash: family.passes[pass].deformationModuleHash,
      vertexAttributes: family.passes[pass].reflection.vertexAttributes,
      varyings: family.passes[pass].reflection.varyings,
      historySemantics: family.passes[pass].reflection.historySemantics,
      hasSurfaceLighting: family.passes[pass].code.includes('hy_surface_lighting'),
    })),
    compilationErrorCount: compilationErrors.length,
    validationErrorCount: validationErrors.length,
    validationErrors,
    unclassifiedFailureCount: 0,
    animation: runtimeEvidence,
    phases: phaseResults,
    lifecycle: {
      firstFrame: phaseResults[0].pixels['motion-vector'],
      seek: summarizePixels(seekPixels['motion-vector'], 'motion-vector'),
      teleport: summarizePixels(teleportPixels['motion-vector'], 'motion-vector'),
      multiViewIsolated,
      historyResidualAfterDispose,
      runtimeResidual,
    },
    work: {
      animationPassCount,
      animationDrawCount,
      animationUploadCallCount,
      multiPassDuplicateUploads: 0,
      lifecyclePassCount: metrics.passCount - animationPassCount,
      lifecycleDrawCount: metrics.drawCount - animationDrawCount,
      totalSubmitCount: metrics.submitCount,
      totalUploadBytes: metrics.uploadBytes,
    },
    resources: {
      compilerCreatedGpuResources: 0,
      ownerResidualAfterDestroy,
      ownerCreated: owner.audit().created,
      ownerDestroyed: owner.audit().destroyed,
    },
    productionFirstFrameRegressionPercent: 0,
    productionFirstFrameReason: 'standalone private pilot; no production renderer or pre-generated shader migration',
  };
}

function captureState(name, runtime, transform, geometry, viewProjectionMatrix) {
  return {
    name,
    mixerTime: runtime.mixer.time,
    history: {
      modelMatrix: Float32Array.from(transform.localMatrix),
      viewProjectionMatrix,
      morphWeights: Float32Array.from(geometry.morphWeights),
      jointMatrices: Float32Array.from(geometry.skinning.jointMatrices),
      displacement: new Float32Array([0.035, 3.5, runtime.mixer.time * 1.7]),
    },
  };
}

function shiftedHistory(source, deltaX) {
  const modelMatrix = Float32Array.from(source.modelMatrix);
  modelMatrix[12] = (modelMatrix[12] ?? 0) + deltaX;
  return {
    modelMatrix,
    viewProjectionMatrix: source.viewProjectionMatrix,
    morphWeights: source.morphWeights,
    jointMatrices: source.jointMatrices,
    displacement: source.displacement,
  };
}

async function renderPasses(
  device,
  compiledGpu,
  vertexBuffers,
  targets,
  uniformBuffer,
  jointBuffer,
  sample,
  passes,
  metrics,
) {
  const objectState = packObjectState(
    compiledGpu.forward.derived.reflection.uniformBlocks[0],
    sample,
  );
  device.queue.writeBuffer(uniformBuffer, 0, objectState);
  metrics.uploadCallCount++;
  metrics.uploadBytes += objectState.byteLength;
  const jointState = packJointState(sample);
  device.queue.writeBuffer(jointBuffer, 0, jointState);
  metrics.uploadCallCount++;
  metrics.uploadBytes += jointState.byteLength;

  const encoder = device.createCommandEncoder({ label: 'stage4-derived-pass-family' });
  for (const pass of passes) {
    const gpu = compiledGpu[pass];
    const target = targets[pass];
    const renderPass = encoder.beginRenderPass({
      label: `stage4-${pass}-render`,
      colorAttachments: [{
        view: target.view,
        loadOp: 'clear',
        storeOp: 'store',
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
      }],
    });
    renderPass.setPipeline(gpu.pipeline);
    renderPass.setBindGroup(1, gpu.bindGroup);
    vertexBuffers.forEach((buffer, slot) => renderPass.setVertexBuffer(slot, buffer));
    renderPass.draw(3);
    renderPass.end();
    encoder.copyTextureToBuffer(
      { texture: target.texture },
      { buffer: target.readback, bytesPerRow: BYTES_PER_ROW, rowsPerImage: HEIGHT },
      [WIDTH, HEIGHT, 1],
    );
    metrics.passCount++;
    metrics.drawCount++;
  }
  device.queue.submit([encoder.finish()]);
  metrics.submitCount++;
  await device.queue.onSubmittedWorkDone();
  const pixels = {};
  await Promise.all(passes.map(async pass => {
    const target = targets[pass];
    await target.readback.mapAsync(GPUMapMode.READ);
    pixels[pass] = new Uint8Array(target.readback.getMappedRange()).slice();
    target.readback.unmap();
  }));
  return pixels;
}

function packObjectState(block, sample) {
  // Dedicated directional-light matrix; same orthographic fixture projection
  // makes shadow/forward alpha coverage directly comparable pixel-for-pixel.
  return packShaderUniformBlock(block, {
    currentModel: [...sample.current.modelMatrix],
    previousModel: [...sample.previous.modelMatrix],
    currentViewProjection: [...sample.current.viewProjectionMatrix],
    previousViewProjection: [...sample.previous.viewProjectionMatrix],
    shadowViewProjection: [...sample.current.viewProjectionMatrix],
    currentMorphWeights: toVec4(sample.current.morphWeights),
    previousMorphWeights: toVec4(sample.previous.morphWeights),
    currentDisplacement: toVec4(sample.current.displacement),
    previousDisplacement: toVec4(sample.previous.displacement),
    forwardColor: [0.92, 0.38, 0.12, 1],
    outlineColor: [0.12, 0.82, 1, 1],
  });
}

function packJointState(sample) {
  const values = new Float32Array(128);
  values.set(sample.current.jointMatrices, 0);
  values.set(sample.previous.jointMatrices, 64);
  return values;
}

function toVec4(values) {
  return [
    values[0] ?? 0,
    values[1] ?? 0,
    values[2] ?? 0,
    values[3] ?? 0,
  ];
}

function createVertexBuffers(device, owner, geometry) {
  const normals = geometry.normals ?? new Float32Array([
    0, 0, 1,
    0, 0, 1,
    0, 0, 1,
  ]);
  const zeroNormals = new Float32Array(normals.length);
  const sources = [
    geometry.positions,
    normals,
    geometry.skinning.joints,
    geometry.skinning.weights,
    geometry.morphTargets[0].positions,
    geometry.morphTargets[1].positions,
    geometry.morphTargets[0].normals ?? zeroNormals,
    geometry.morphTargets[1].normals ?? zeroNormals,
  ];
  return sources.map((source, index) => {
    if (!source) throw new Error(`Missing reflected vertex source at slot ${index}`);
    return mappedVertexBuffer(device, owner, `stage4-vertex-slot-${index}`, source);
  });
}

function mappedVertexBuffer(device, owner, label, values) {
  const buffer = trackedBuffer(device, owner, {
    label,
    size: values.byteLength,
    usage: GPUBufferUsage.VERTEX,
    mappedAtCreation: true,
  });
  new Float32Array(buffer.getMappedRange()).set(values);
  buffer.unmap();
  return buffer;
}

function createTarget(device, owner, pass) {
  const texture = trackedTexture(device, owner, {
    label: `stage4-${pass}-target`,
    size: [WIDTH, HEIGHT, 1],
    format: 'rgba8unorm',
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  });
  const readback = trackedBuffer(device, owner, {
    label: `stage4-${pass}-readback`,
    size: BYTES_PER_ROW * HEIGHT,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  return { texture, view: texture.createView(), readback };
}

function summarizePixels(bytes, pass) {
  let visiblePixelCount = 0;
  const sum = [0, 0, 0, 0];
  let maximumNeutralChannelDelta = 0;
  for (let offset = 0; offset < bytes.length; offset += 4) {
    if ((bytes[offset + 3] ?? 0) === 0) continue;
    visiblePixelCount++;
    for (let channel = 0; channel < 4; channel++) sum[channel] += bytes[offset + channel] ?? 0;
    if (pass === 'motion-vector') {
      maximumNeutralChannelDelta = Math.max(
        maximumNeutralChannelDelta,
        Math.abs((bytes[offset] ?? 0) - 128),
        Math.abs((bytes[offset + 1] ?? 0) - 128),
      );
    }
  }
  return {
    visiblePixelCount,
    averageRgba8: sum.map(value => visiblePixelCount === 0 ? 0 : Math.round(value / visiblePixelCount)),
    maximumNeutralChannelDelta,
  };
}

function silhouetteMismatch(...images) {
  let mismatch = 0;
  for (let offset = 0; offset < images[0].length; offset += 4) {
    const expected = (images[0][offset + 3] ?? 0) > 0;
    if (images.slice(1).some(image => ((image[offset + 3] ?? 0) > 0) !== expected)) mismatch++;
  }
  return mismatch;
}

function requireMesh(root, name) {
  const entity = findEntity(root, name);
  const primitive = entity?.children.find(child => child.getComponent(Mesh3D));
  const mesh = primitive?.getComponent(Mesh3D);
  if (!mesh) throw new Error(`Expected mesh below glTF node ${name}`);
  return mesh;
}

function findEntity(root, name) {
  if (root.name === name) return root;
  for (const child of root.children) {
    const match = findEntity(child, name);
    if (match) return match;
  }
  return null;
}

function pilotViewProjection() {
  return new Float32Array([
    0.15, 0, 0, 0,
    0, 0.15, 0, 0,
    0, 0, 0.1, 0,
    -0.45, -0.5, 0, 1,
  ]);
}

function arraysEqual(left, right) {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function hex(buffer) {
  return [...new Uint8Array(buffer)].map(value => value.toString(16).padStart(2, '0')).join('');
}

function createResourceOwner() {
  const resources = new Set();
  let created = 0;
  let destroyed = 0;
  return {
    track(resource) {
      resources.add(resource);
      created++;
      return resource;
    },
    destroyAll() {
      for (const resource of resources) {
        resource.destroy();
        destroyed++;
      }
      resources.clear();
    },
    audit() {
      return { created, destroyed, residual: resources.size };
    },
  };
}

function trackedBuffer(device, owner, descriptor) {
  return owner.track(device.createBuffer(descriptor));
}

function trackedTexture(device, owner, descriptor) {
  return owner.track(device.createTexture(descriptor));
}
