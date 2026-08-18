import { Mesh3D, type Entity, type Geometry3D } from '@haiyue/engine';
import {
  disposeGltfModel,
  loadGltfModel,
  type LoadedGltfModel,
} from '@haiyue/extensions/gltf';
import {
  createGltfAnimation3DRuntime,
  type GltfAnimation3DRuntime,
} from '@haiyue/extensions/gltf-animation3d';
import { SHADER_LANGUAGE_SHOWCASE } from './generated/showcase.generated';
import {
  alphaSilhouetteMismatch,
  copyPaddedTextureRows,
  createGpuBufferWithData,
  packReflectedUniforms,
  paintRgbaPixels,
  summarizeVisiblePixels,
} from './RuntimeSupport';

const WIDTH = 160;
const HEIGHT = 208;
const BYTES_PER_ROW = 768;

export type CharacterPass = 'forward' | 'depth' | 'shadow' | 'motion-vector' | 'outline-selection';

export interface CharacterPassSummary {
  readonly visiblePixelCount: number;
  readonly averageRgba8: readonly number[];
  readonly maximumNeutralChannelDelta: number;
}

export interface CharacterPassFrame {
  readonly passes: Readonly<Record<CharacterPass, CharacterPassSummary>>;
  readonly silhouetteMismatchPixels: number;
  readonly frameUploadCallCount: number;
  readonly multiPassDuplicateUploads: number;
  readonly totalUploadCallCount: number;
  readonly totalDrawCount: number;
  readonly totalSubmitCount: number;
  readonly pipelineRebuildCount: number;
  readonly mixerTime: number;
  readonly morphWeights: readonly number[];
}

export interface CharacterPassEvidence {
  readonly assetPath: string;
  readonly assetHttpBytes: number;
  readonly assetSha256: string;
  readonly jointCount: number;
  readonly vertexCount: number;
  readonly indexCount: number;
  readonly compilationErrorCount: number;
  readonly validationErrorCount: number;
  readonly usesAnimation3DMixer: boolean;
  readonly usesAnimation3DPoseBuffer: boolean;
  readonly deformationModuleHash: string;
  readonly passCount: number;
  readonly passModuleHashes: Readonly<Record<CharacterPass, string>>;
}

export type CharacterMaterialColor = readonly [number, number, number, number];

export interface CharacterMaterialState {
  readonly forwardColor: CharacterMaterialColor;
  readonly outlineColor: CharacterMaterialColor;
}

const DEFAULT_CHARACTER_MATERIAL: CharacterMaterialState = Object.freeze({
  forwardColor: Object.freeze([0.98, 0.38, 0.1, 1]) as CharacterMaterialColor,
  outlineColor: Object.freeze([0.08, 0.86, 1, 1]) as CharacterMaterialColor,
});

interface GpuPass {
  readonly pipeline: GPURenderPipeline;
  readonly bindGroup: GPUBindGroup;
  readonly target: GPUTexture;
  readonly depth: GPUTexture;
  readonly readback: GPUBuffer;
  readonly display: CanvasRenderingContext2D;
}

interface CharacterSnapshot {
  readonly modelMatrix: Float32Array<ArrayBuffer>;
  readonly viewProjectionMatrix: Float32Array<ArrayBuffer>;
  readonly morphWeights: Float32Array<ArrayBuffer>;
  readonly jointMatrices: Float32Array<ArrayBuffer>;
  readonly displacement: Float32Array<ArrayBuffer>;
}

export class CharacterPassRenderer {
  readonly evidence: CharacterPassEvidence;
  private previous: CharacterSnapshot | null = null;
  private totalUploadCallCount = 0;
  private totalDrawCount = 0;
  private totalSubmitCount = 0;

  private constructor(
    private readonly device: GPUDevice,
    private readonly model: LoadedGltfModel,
    private readonly runtime: GltfAnimation3DRuntime,
    private readonly geometry: Geometry3D,
    private readonly gpuPasses: Readonly<Record<CharacterPass, GpuPass>>,
    private readonly vertexBuffers: readonly GPUBuffer[],
    private readonly indexBuffer: GPUBuffer | null,
    private readonly objectBuffer: GPUBuffer,
    private readonly jointBuffer: GPUBuffer,
    private readonly jointBufferPreviousOffset: number,
    private readonly viewProjection: Float32Array<ArrayBuffer>,
    private readonly validationErrors: string[],
    evidence: CharacterPassEvidence,
  ) {
    this.evidence = evidence;
  }

  static async create(canvases: Readonly<Record<CharacterPass, HTMLCanvasElement>>): Promise<CharacterPassRenderer> {
    if (!navigator.gpu) throw new Error('WebGPU is unavailable; character pass consistency cannot run.');
    const displayContexts = {} as Record<CharacterPass, CanvasRenderingContext2D>;
    for (const pass of characterPasses()) {
      const canvas = canvases[pass];
      canvas.width = WIDTH;
      canvas.height = HEIGHT;
      const context = canvas.getContext('2d', { alpha: false });
      if (!context) throw new Error(`Character ${pass} display canvas is unavailable.`);
      displayContexts[pass] = context;
    }

    const asset = SHADER_LANGUAGE_SHOWCASE.character.asset;
    const assetUrl = new URL(asset.path, window.location.href).href;
    const decoderScriptUrl = new URL(asset.decoderScriptPath, window.location.href).href;
    const decoderWasmUrl = new URL(asset.decoderWasmPath, window.location.href).href;
    const [assetResponse, decoderResponse] = await Promise.all([
      fetch(assetUrl, { cache: 'no-store' }),
      fetch(decoderWasmUrl, { cache: 'force-cache' }),
    ]);
    if (!assetResponse.ok) throw new Error(`Character glTF HTTP ${assetResponse.status}.`);
    if (!decoderResponse.ok) throw new Error(`Draco decoder HTTP ${decoderResponse.status}.`);
    const assetBytes = await assetResponse.arrayBuffer();
    const assetSha256 = hex(await crypto.subtle.digest('SHA-256', assetBytes));
    const model = await loadGltfModel(assetUrl, {
      dracoDecoderConfig: {
        scriptUrl: decoderScriptUrl,
        wasmBinary: await decoderResponse.arrayBuffer(),
      },
    });
    const runtime = createGltfAnimation3DRuntime(model, { clipIdPrefix: 'shader-language-lab' });
    const clip = runtime.clips[0];
    if (!clip) throw new Error('The real character glTF contains no Animation3D clip.');
    runtime.mixer.createAction(clip, { id: 'CharacterLoop', loop: 'repeat' }).play();
    runtime.evaluate();
    const mesh = findFirstMesh(model.root);
    if (!mesh) throw new Error('The real character glTF does not contain a mesh.');
    const geometry = mesh.geometry;
    const skinning = geometry.skinning;
    if (!skinning) throw new Error('The real character glTF does not expose skinning geometry.');
    const jointCount = skinning.jointMatrices.length / 16;
    if (jointCount !== asset.expectedJointCount) {
      throw new Error(`Expected ${asset.expectedJointCount} character joints, received ${jointCount}.`);
    }

    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error('WebGPU did not return an adapter for the character passes.');
    const device = await adapter.requestDevice();
    const validationErrors: string[] = [];
    device.addEventListener('uncapturederror', event => validationErrors.push(event.error.message));
    device.pushErrorScope('validation');
    const compilationErrors: string[] = [];
    const pipelines = {} as Record<CharacterPass, GPURenderPipeline>;
    for (const pass of characterPasses()) {
      const generated = generatedPass(pass);
      const module = device.createShaderModule({ label: `shader-language-lab.character-${pass}`, code: generated.code });
      const info = await module.getCompilationInfo();
      compilationErrors.push(...info.messages.filter(message => message.type === 'error')
        .map(message => `${pass}:${message.lineNum}:${message.linePos} ${message.message}`));
      pipelines[pass] = await device.createRenderPipelineAsync({
        label: `shader-language-lab.character-${pass}-pipeline`,
        layout: 'auto',
        vertex: {
          module,
          entryPoint: generated.reflection.vertexEntryPoint,
          buffers: generated.reflection.vertexAttributes.map(attribute => ({
            arrayStride: attribute.format === 'float32x3' ? 12 : 16,
            attributes: [{ shaderLocation: attribute.location, offset: 0, format: attribute.format }],
          })),
        },
        fragment: {
          module,
          entryPoint: generated.reflection.fragmentEntryPoint,
          targets: [{ format: 'rgba8unorm' }],
        },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
        depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less' },
      });
    }
    if (compilationErrors.length > 0) throw new Error(`Character pass WGSL failed:\n${compilationErrors.join('\n')}`);

    const morph = createSyntheticMorphTargets(geometry);
    const vertexSources = [
      geometry.positions,
      geometry.normals ?? createDefaultNormals(geometry.vertexCount),
      skinning.joints,
      skinning.weights,
      morph.position0,
      morph.position1,
      morph.normal0,
      morph.normal1,
    ];
    const vertexBuffers = vertexSources.map((source, index) => createGpuBufferWithData(
      device, `shader-language-lab.character-vertex-${index}`, source as ArrayBufferView<ArrayBuffer>, GPUBufferUsage.VERTEX,
    ));
    const indexBuffer = geometry.indices
      ? createGpuBufferWithData(device, 'shader-language-lab.character-indices', geometry.indices as Uint16Array<ArrayBuffer> | Uint32Array<ArrayBuffer>, GPUBufferUsage.INDEX)
      : null;
    const objectBlock = generatedPass('forward').reflection.uniformBlocks[0];
    if (!objectBlock) throw new Error('Character deformation object ABI is missing.');
    const objectBuffer = device.createBuffer({
      label: 'shader-language-lab.character-object-state', size: objectBlock.byteSize,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const jointBytes = skinning.jointMatrices.byteLength;
    const previousOffset = align(jointBytes, 256);
    const jointBuffer = device.createBuffer({
      label: 'shader-language-lab.character-current-previous-joints', size: previousOffset + jointBytes,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    const gpuPasses = {} as Record<CharacterPass, GpuPass>;
    for (const pass of characterPasses()) {
      const pipeline = pipelines[pass];
      const bindGroup = device.createBindGroup({
        label: `shader-language-lab.character-${pass}-shared-abi`,
        layout: pipeline.getBindGroupLayout(1),
        entries: [
          { binding: 0, resource: { buffer: objectBuffer, size: objectBlock.byteSize } },
          { binding: 1, resource: { buffer: jointBuffer, offset: 0, size: jointBytes } },
          { binding: 2, resource: { buffer: jointBuffer, offset: previousOffset, size: jointBytes } },
        ],
      });
      const target = device.createTexture({
        label: `shader-language-lab.character-${pass}-target`, size: [WIDTH, HEIGHT], format: 'rgba8unorm',
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
      });
      const depth = device.createTexture({
        label: `shader-language-lab.character-${pass}-depth`, size: [WIDTH, HEIGHT], format: 'depth24plus',
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
      });
      const readback = device.createBuffer({
        label: `shader-language-lab.character-${pass}-readback`, size: BYTES_PER_ROW * HEIGHT,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });
      gpuPasses[pass] = { pipeline, bindGroup, target, depth, readback, display: displayContexts[pass] };
    }
    const validationError = await device.popErrorScope();
    if (validationError) validationErrors.push(validationError.message);
    if (validationErrors.length > 0) throw new Error(`Character WebGPU validation failed: ${validationErrors.join('; ')}`);
    const viewProjection = createZUpFitProjection(geometry.positions);
    const passModuleHashes = Object.freeze(Object.fromEntries(characterPasses().map(pass => [
      pass, generatedPass(pass).deformationModuleHash,
    ]))) as Readonly<Record<CharacterPass, string>>;
    const evidence = Object.freeze({
      assetPath: asset.path,
      assetHttpBytes: assetBytes.byteLength,
      assetSha256,
      jointCount,
      vertexCount: geometry.vertexCount,
      indexCount: geometry.indexCount,
      compilationErrorCount: compilationErrors.length,
      validationErrorCount: validationErrors.length,
      usesAnimation3DMixer: runtime.mixer.constructor.name === 'Animation3DMixer',
      usesAnimation3DPoseBuffer: runtime.pose.constructor.name === 'Animation3DPoseBuffer',
      deformationModuleHash: SHADER_LANGUAGE_SHOWCASE.character.deformationModuleHash,
      passCount: characterPasses().length,
      passModuleHashes,
    });
    return new CharacterPassRenderer(
      device, model, runtime, geometry, gpuPasses, vertexBuffers, indexBuffer, objectBuffer, jointBuffer,
      previousOffset, viewProjection, validationErrors, evidence,
    );
  }

  async render(
    deltaSeconds: number,
    timeSeconds: number,
    resetHistory = false,
    material: CharacterMaterialState = DEFAULT_CHARACTER_MATERIAL,
  ): Promise<CharacterPassFrame> {
    this.runtime.update(Math.min(0.1, Math.max(0, deltaSeconds)));
    const skinning = this.geometry.skinning;
    if (!skinning) throw new Error('Character skinning was released before rendering.');
    const current = snapshotCharacter(
      this.viewProjection,
      skinning.jointMatrices,
      timeSeconds,
    );
    const previous = resetHistory || !this.previous ? current : this.previous;
    const objectBlock = generatedPass('forward').reflection.uniformBlocks[0]!;
    const objectState = packReflectedUniforms(objectBlock, {
      currentModel: current.modelMatrix,
      previousModel: previous.modelMatrix,
      currentViewProjection: current.viewProjectionMatrix,
      previousViewProjection: previous.viewProjectionMatrix,
      shadowViewProjection: current.viewProjectionMatrix,
      currentMorphWeights: current.morphWeights,
      previousMorphWeights: previous.morphWeights,
      currentDisplacement: current.displacement,
      previousDisplacement: previous.displacement,
      forwardColor: material.forwardColor,
      outlineColor: material.outlineColor,
    });
    this.device.queue.writeBuffer(this.objectBuffer, 0, objectState);
    const jointUpload = new Float32Array((this.jointBufferPreviousOffset + current.jointMatrices.byteLength) / 4);
    jointUpload.set(current.jointMatrices, 0);
    jointUpload.set(previous.jointMatrices, this.jointBufferPreviousOffset / 4);
    this.device.queue.writeBuffer(this.jointBuffer, 0, jointUpload.buffer);
    this.totalUploadCallCount += 2;

    const encoder = this.device.createCommandEncoder({ label: 'shader-language-lab.character-five-pass-frame' });
    for (const pass of characterPasses()) {
      const gpu = this.gpuPasses[pass];
      const renderPass = encoder.beginRenderPass({
        label: `shader-language-lab.character-${pass}`,
        colorAttachments: [{
          view: gpu.target.createView(), loadOp: 'clear', storeOp: 'store',
          clearValue: { r: 0.006, g: 0.01, b: 0.026, a: 0 },
        }],
        depthStencilAttachment: {
          view: gpu.depth.createView(), depthLoadOp: 'clear', depthStoreOp: 'discard', depthClearValue: 1,
        },
      });
      renderPass.setPipeline(gpu.pipeline);
      renderPass.setBindGroup(1, gpu.bindGroup);
      this.vertexBuffers.forEach((buffer, slot) => renderPass.setVertexBuffer(slot, buffer));
      if (this.indexBuffer && this.geometry.indices) {
        renderPass.setIndexBuffer(this.indexBuffer, this.geometry.indices instanceof Uint32Array ? 'uint32' : 'uint16');
        renderPass.drawIndexed(this.geometry.indices.length);
      } else {
        renderPass.draw(this.geometry.vertexCount);
      }
      renderPass.end();
      encoder.copyTextureToBuffer(
        { texture: gpu.target },
        { buffer: gpu.readback, bytesPerRow: BYTES_PER_ROW, rowsPerImage: HEIGHT },
        [WIDTH, HEIGHT],
      );
      this.totalDrawCount++;
    }
    this.device.queue.submit([encoder.finish()]);
    this.totalSubmitCount++;
    await this.device.queue.onSubmittedWorkDone();
    const pixels = {} as Record<CharacterPass, Uint8Array>;
    await Promise.all(characterPasses().map(async pass => {
      const gpu = this.gpuPasses[pass];
      await gpu.readback.mapAsync(GPUMapMode.READ);
      const result = copyPaddedTextureRows(gpu.readback.getMappedRange(), WIDTH, HEIGHT, BYTES_PER_ROW);
      gpu.readback.unmap();
      pixels[pass] = result;
      paintRgbaPixels(gpu.display, result, WIDTH, HEIGHT, false);
    }));
    this.previous = current;
    const summaries = Object.freeze(Object.fromEntries(characterPasses().map(pass => [
      pass,
      summarizeVisiblePixels(pixels[pass], pass === 'motion-vector'),
    ]))) as Readonly<Record<CharacterPass, CharacterPassSummary>>;
    return Object.freeze({
      passes: summaries,
      silhouetteMismatchPixels: alphaSilhouetteMismatch(characterPasses().map(pass => pixels[pass])),
      frameUploadCallCount: 2,
      multiPassDuplicateUploads: 0,
      totalUploadCallCount: this.totalUploadCallCount,
      totalDrawCount: this.totalDrawCount,
      totalSubmitCount: this.totalSubmitCount,
      pipelineRebuildCount: 0,
      mixerTime: this.runtime.mixer.time,
      morphWeights: Object.freeze([...current.morphWeights]),
    });
  }

  dispose(): void {
    for (const buffer of this.vertexBuffers) buffer.destroy();
    this.indexBuffer?.destroy();
    this.objectBuffer.destroy();
    this.jointBuffer.destroy();
    for (const pass of characterPasses()) {
      const gpu = this.gpuPasses[pass];
      gpu.target.destroy();
      gpu.depth.destroy();
      gpu.readback.destroy();
    }
    this.runtime.destroy();
    if (!this.model.root.destroyed) disposeGltfModel(this.model);
    this.device.destroy();
  }
}

function generatedPass(pass: CharacterPass): (typeof SHADER_LANGUAGE_SHOWCASE.character.passes)[CharacterPass] {
  return SHADER_LANGUAGE_SHOWCASE.character.passes[pass];
}

function characterPasses(): readonly CharacterPass[] {
  return SHADER_LANGUAGE_SHOWCASE.character.passOrder;
}

function findFirstMesh(entity: Entity): Mesh3D | null {
  const mesh = entity.getComponent(Mesh3D);
  if (mesh) return mesh;
  for (const child of entity.children) {
    const found = findFirstMesh(child);
    if (found) return found;
  }
  return null;
}

function createSyntheticMorphTargets(geometry: Geometry3D): Readonly<Record<'position0' | 'position1' | 'normal0' | 'normal1', Float32Array<ArrayBuffer>>> {
  const position0 = new Float32Array(geometry.positions.length);
  const position1 = new Float32Array(geometry.positions.length);
  const normal0 = new Float32Array(geometry.positions.length);
  const normal1 = new Float32Array(geometry.positions.length);
  const normals = geometry.normals ?? createDefaultNormals(geometry.vertexCount);
  for (let index = 0; index < geometry.vertexCount; index++) {
    const offset = index * 3;
    const z = geometry.positions[offset + 2] ?? 0;
    const pulse = 0.018 + Math.max(0, z - 0.55) * 0.025;
    position0[offset] = (normals[offset] ?? 0) * pulse;
    position0[offset + 1] = (normals[offset + 1] ?? 0) * pulse;
    position0[offset + 2] = (normals[offset + 2] ?? 1) * pulse;
    position1[offset] = Math.sin(z * 5.2) * 0.035;
    position1[offset + 1] = Math.cos(z * 3.8) * 0.018;
  }
  return Object.freeze({ position0, position1, normal0, normal1 });
}

function createDefaultNormals(vertexCount: number): Float32Array<ArrayBuffer> {
  const normals = new Float32Array(vertexCount * 3);
  for (let index = 0; index < vertexCount; index++) normals[index * 3 + 2] = 1;
  return normals;
}

function snapshotCharacter(
  viewProjection: Float32Array<ArrayBuffer>,
  jointMatrices: Float32Array,
  timeSeconds: number,
): CharacterSnapshot {
  const morph0 = 0.42 + Math.sin(timeSeconds * 1.8) * 0.28;
  const morph1 = 0.34 + Math.cos(timeSeconds * 1.25) * 0.22;
  return Object.freeze({
    modelMatrix: identityMatrix(),
    viewProjectionMatrix: Float32Array.from(viewProjection),
    morphWeights: new Float32Array([morph0, morph1, 0, 0]),
    jointMatrices: Float32Array.from(jointMatrices),
    displacement: new Float32Array([0.012, 5.2, timeSeconds * 2.1, 0]),
  });
}

function createZUpFitProjection(positions: Float32Array): Float32Array<ArrayBuffer> {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (let offset = 0; offset < positions.length; offset += 3) {
    const x = positions[offset]!;
    const y = positions[offset + 1]!;
    const z = positions[offset + 2]!;
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
  }
  const centerX = (minX + maxX) * 0.5;
  const centerY = (minY + maxY) * 0.5;
  const centerZ = (minZ + maxZ) * 0.5;
  const scale = 1.62 / Math.max(maxX - minX, maxZ - minZ, 0.001);
  return new Float32Array([
    scale, 0, 0, 0,
    0, 0, 0.18 / Math.max(maxY - minY, 0.001), 0,
    0, scale, 0, 0,
    -centerX * scale, -centerZ * scale, 0.5 - centerY * 0.18, 1,
  ]);
}

function identityMatrix(): Float32Array<ArrayBuffer> {
  return new Float32Array([
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    0, 0, 0, 1,
  ]);
}

function align(value: number, alignment: number): number {
  return Math.ceil(value / alignment) * alignment;
}

function hex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map(value => value.toString(16).padStart(2, '0')).join('');
}
