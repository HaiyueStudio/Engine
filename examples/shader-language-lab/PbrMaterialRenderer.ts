import { mat4 } from 'wgpu-matrix';
import { SHADER_LANGUAGE_SHOWCASE } from './generated/showcase.generated';
import {
  createGpuBufferWithData,
  copyPaddedTextureRows,
  packReflectedUniforms,
  paintRgbaPixels,
  summarizeVisiblePixels,
} from './RuntimeSupport';

const WIDTH = 384;
const HEIGHT = 384;
const BYTES_PER_ROW = WIDTH * 4;
const TEXTURE_SIZE = 64;

export interface PbrMaterialState {
  readonly time: number;
  readonly metallic: number;
  readonly roughness: number;
  readonly noiseScale: number;
  readonly noiseStrength: number;
}

export interface PbrMaterialFrame {
  readonly visiblePixelCount: number;
  readonly averageRgba8: readonly number[];
  readonly uniformWriteCount: number;
  readonly pipelineRebuildCount: number;
}

export class PbrMaterialRenderer {
  readonly compilationErrorCount: number;
  get validationErrorCount(): number { return this.validationErrors.length; }

  private uniformWriteCount = 0;
  private readonly model = mat4.identity();
  private readonly modelX = mat4.identity();
  private readonly modelY = mat4.identity();
  private readonly view = mat4.identity();
  private readonly projection = mat4.identity();
  private readonly viewProjection = mat4.identity();
  private readonly modelViewProjection = mat4.identity();

  private constructor(
    private readonly device: GPUDevice,
    private readonly pipeline: GPURenderPipeline,
    private readonly frameBuffer: GPUBuffer,
    private readonly objectBuffer: GPUBuffer,
    private readonly materialBuffer: GPUBuffer,
    private readonly vertexBuffer: GPUBuffer,
    private readonly indexBuffer: GPUBuffer,
    private readonly indexCount: number,
    private readonly albedoTexture: GPUTexture,
    private readonly normalTexture: GPUTexture,
    private readonly target: GPUTexture,
    private readonly depth: GPUTexture,
    private readonly readback: GPUBuffer,
    private readonly bindGroups: readonly GPUBindGroup[],
    private readonly displayContext: CanvasRenderingContext2D,
    private readonly validationErrors: string[],
    compilationErrorCount: number,
  ) {
    this.compilationErrorCount = compilationErrorCount;
  }

  static async create(canvas: HTMLCanvasElement): Promise<PbrMaterialRenderer> {
    if (!navigator.gpu) throw new Error('WebGPU is unavailable; the PBR material composition cannot run.');
    canvas.width = WIDTH;
    canvas.height = HEIGHT;
    const displayContext = canvas.getContext('2d', { alpha: false });
    if (!displayContext) throw new Error('PBR display canvas 2D context is unavailable.');
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error('WebGPU did not return an adapter for the PBR material.');
    const device = await adapter.requestDevice();
    const validationErrors: string[] = [];
    device.addEventListener('uncapturederror', event => validationErrors.push(event.error.message));
    device.pushErrorScope('validation');

    const module = device.createShaderModule({
      label: 'shader-language-lab.real-pbr',
      code: SHADER_LANGUAGE_SHOWCASE.pbr.wgsl.code,
    });
    const info = await module.getCompilationInfo();
    const compilationErrors = info.messages.filter(message => message.type === 'error');
    if (compilationErrors.length > 0) {
      throw new Error(`Generated PBR WGSL failed:\n${compilationErrors.map(message => `${message.lineNum}:${message.linePos} ${message.message}`).join('\n')}`);
    }
    const pipeline = await device.createRenderPipelineAsync({
      label: 'shader-language-lab.real-pbr-pipeline',
      layout: 'auto',
      vertex: {
        module,
        entryPoint: SHADER_LANGUAGE_SHOWCASE.pbr.wgsl.vertexEntryPoint,
        buffers: [{
          arrayStride: 44,
          attributes: [
            { shaderLocation: 0, offset: 0, format: 'float32x3' },
            { shaderLocation: 1, offset: 12, format: 'float32x3' },
            { shaderLocation: 2, offset: 24, format: 'float32x3' },
            { shaderLocation: 3, offset: 36, format: 'float32x2' },
          ],
        }],
      },
      fragment: {
        module,
        entryPoint: SHADER_LANGUAGE_SHOWCASE.pbr.wgsl.fragmentEntryPoint,
        targets: [{ format: 'rgba8unorm' }],
      },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less' },
    });

    const mesh = createSphereMesh(48, 32);
    const vertexBuffer = createGpuBufferWithData(device, 'shader-language-lab.pbr-sphere-vertices', mesh.vertices, GPUBufferUsage.VERTEX);
    const indexBuffer = createGpuBufferWithData(device, 'shader-language-lab.pbr-sphere-indices', mesh.indices, GPUBufferUsage.INDEX);
    const frameBlock = requiredUniformBlock('frame.scene');
    const materialBlock = requiredUniformBlock('material.parameters');
    const objectBlock = SHADER_LANGUAGE_SHOWCASE.pbr.wgsl.objectUniformBlock;
    const frameBuffer = device.createBuffer({ label: 'shader-language-lab.pbr-frame', size: frameBlock.byteSize, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const objectBuffer = device.createBuffer({ label: 'shader-language-lab.pbr-object', size: objectBlock.byteSize, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const materialBuffer = device.createBuffer({ label: 'shader-language-lab.pbr-material', size: materialBlock.byteSize, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const albedoTexture = createRgbaTexture(device, 'shader-language-lab.pbr-albedo', createAlbedoTexture());
    const normalTexture = createRgbaTexture(device, 'shader-language-lab.pbr-normal', createNormalTexture());
    const sampler = device.createSampler({
      label: 'shader-language-lab.pbr-sampler',
      magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear',
      addressModeU: 'repeat', addressModeV: 'repeat',
    });
    const resources = new Map(SHADER_LANGUAGE_SHOWCASE.pbr.wgsl.reflection.resources.map(resource => [resource.id, resource]));
    const frameResource = requiredResource(resources, 'frame.scene');
    const materialResource = requiredResource(resources, 'material.parameters');
    const albedoResource = requiredResource(resources, 'material.albedoTexture');
    const normalResource = requiredResource(resources, 'material.normalTexture');
    const samplerResource = requiredResource(resources, 'material.surfaceSampler');
    const bindGroups = [
      device.createBindGroup({
        label: 'shader-language-lab.pbr-frame-bind-group',
        layout: pipeline.getBindGroupLayout(frameResource.group),
        entries: [{ binding: frameResource.binding, resource: { buffer: frameBuffer } }],
      }),
      device.createBindGroup({
        label: 'shader-language-lab.pbr-object-bind-group',
        layout: pipeline.getBindGroupLayout(1),
        entries: [{ binding: 0, resource: { buffer: objectBuffer } }],
      }),
      device.createBindGroup({
        label: 'shader-language-lab.pbr-material-bind-group',
        layout: pipeline.getBindGroupLayout(materialResource.group),
        entries: [
          { binding: materialResource.binding, resource: { buffer: materialBuffer } },
          { binding: albedoResource.binding, resource: albedoTexture.createView() },
          { binding: normalResource.binding, resource: normalTexture.createView() },
          { binding: samplerResource.binding, resource: sampler },
        ],
      }),
    ];
    const target = device.createTexture({
      label: 'shader-language-lab.pbr-target', size: [WIDTH, HEIGHT], format: 'rgba8unorm',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
    const depth = device.createTexture({
      label: 'shader-language-lab.pbr-depth', size: [WIDTH, HEIGHT], format: 'depth24plus',
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    const readback = device.createBuffer({
      label: 'shader-language-lab.pbr-readback', size: BYTES_PER_ROW * HEIGHT,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    const validationError = await device.popErrorScope();
    if (validationError) validationErrors.push(validationError.message);
    if (validationErrors.length > 0) throw new Error(`PBR WebGPU validation failed: ${validationErrors.join('; ')}`);
    return new PbrMaterialRenderer(
      device, pipeline, frameBuffer, objectBuffer, materialBuffer, vertexBuffer, indexBuffer, mesh.indices.length,
      albedoTexture, normalTexture, target, depth, readback, bindGroups, displayContext,
      validationErrors, compilationErrors.length,
    );
  }

  async render(state: PbrMaterialState): Promise<PbrMaterialFrame> {
    mat4.rotationX(-0.18, this.modelX);
    mat4.rotationY(state.time * 0.42, this.modelY);
    mat4.multiply(this.modelY, this.modelX, this.model);
    mat4.lookAt([0, 0.22, 3.65], [0, 0, 0], [0, 1, 0], this.view);
    mat4.perspective(Math.PI / 4.1, 1, 0.1, 20, this.projection);
    mat4.multiply(this.projection, this.view, this.viewProjection);
    mat4.multiply(this.viewProjection, this.model, this.modelViewProjection);

    const frameBlock = requiredUniformBlock('frame.scene');
    const materialBlock = requiredUniformBlock('material.parameters');
    this.device.queue.writeBuffer(this.frameBuffer, 0, packReflectedUniforms(frameBlock, {
      cameraPosition: [0, 0.22, 3.65],
      lightDirection: [0.45, 0.72, 1],
      lightColor: [3.2, 2.85, 2.45],
      ambientColor: [0.11, 0.14, 0.22],
      fogColor: [0.015, 0.025, 0.055],
      fogStart: 3.1,
      fogEnd: 7.4,
    }));
    this.device.queue.writeBuffer(this.objectBuffer, 0, packReflectedUniforms(SHADER_LANGUAGE_SHOWCASE.pbr.wgsl.objectUniformBlock, {
      modelViewProjection: this.modelViewProjection,
      model: this.model,
    }));
    this.device.queue.writeBuffer(this.materialBuffer, 0, packReflectedUniforms(materialBlock, {
      metallic: state.metallic,
      roughness: state.roughness,
      noiseScale: state.noiseScale,
      noiseStrength: state.noiseStrength,
    }));
    this.uniformWriteCount += 3;

    const encoder = this.device.createCommandEncoder({ label: 'shader-language-lab.pbr-frame' });
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: this.target.createView(), loadOp: 'clear', storeOp: 'store',
        clearValue: { r: 0.006, g: 0.01, b: 0.026, a: 0 },
      }],
      depthStencilAttachment: {
        view: this.depth.createView(), depthLoadOp: 'clear', depthStoreOp: 'discard', depthClearValue: 1,
      },
    });
    pass.setPipeline(this.pipeline);
    this.bindGroups.forEach((bindGroup, index) => pass.setBindGroup(index, bindGroup));
    pass.setVertexBuffer(0, this.vertexBuffer);
    pass.setIndexBuffer(this.indexBuffer, 'uint32');
    pass.drawIndexed(this.indexCount);
    pass.end();
    encoder.copyTextureToBuffer(
      { texture: this.target },
      { buffer: this.readback, bytesPerRow: BYTES_PER_ROW, rowsPerImage: HEIGHT },
      [WIDTH, HEIGHT],
    );
    this.device.queue.submit([encoder.finish()]);
    await this.readback.mapAsync(GPUMapMode.READ);
    const pixels = copyPaddedTextureRows(this.readback.getMappedRange(), WIDTH, HEIGHT, BYTES_PER_ROW);
    this.readback.unmap();
    paintRgbaPixels(this.displayContext, pixels, WIDTH, HEIGHT, false);
    const summary = summarizeVisiblePixels(pixels);
    return Object.freeze({
      visiblePixelCount: summary.visiblePixelCount,
      averageRgba8: summary.averageRgba8,
      uniformWriteCount: this.uniformWriteCount,
      pipelineRebuildCount: 0,
    });
  }

  dispose(): void {
    this.frameBuffer.destroy();
    this.objectBuffer.destroy();
    this.materialBuffer.destroy();
    this.vertexBuffer.destroy();
    this.indexBuffer.destroy();
    this.albedoTexture.destroy();
    this.normalTexture.destroy();
    this.target.destroy();
    this.depth.destroy();
    this.readback.destroy();
    this.device.destroy();
  }
}

function requiredUniformBlock(id: string): typeof SHADER_LANGUAGE_SHOWCASE.pbr.wgsl.reflection.uniformBlocks[number] {
  const block = SHADER_LANGUAGE_SHOWCASE.pbr.wgsl.reflection.uniformBlocks.find(candidate => candidate.id === id);
  if (!block) throw new Error(`Generated PBR uniform block ${id} is missing.`);
  return block;
}

function requiredResource<T extends { readonly id: string }>(resources: ReadonlyMap<string, T>, id: string): T {
  const resource = resources.get(id);
  if (!resource) throw new Error(`Generated PBR resource ${id} is missing.`);
  return resource;
}

function createRgbaTexture(device: GPUDevice, label: string, pixels: Uint8Array<ArrayBuffer>): GPUTexture {
  const texture = device.createTexture({
    label, size: [TEXTURE_SIZE, TEXTURE_SIZE], format: 'rgba8unorm',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  device.queue.writeTexture(
    { texture }, pixels.buffer, { bytesPerRow: TEXTURE_SIZE * 4, rowsPerImage: TEXTURE_SIZE },
    [TEXTURE_SIZE, TEXTURE_SIZE],
  );
  return texture;
}

function createAlbedoTexture(): Uint8Array<ArrayBuffer> {
  const pixels = new Uint8Array(TEXTURE_SIZE * TEXTURE_SIZE * 4);
  for (let y = 0; y < TEXTURE_SIZE; y++) for (let x = 0; x < TEXTURE_SIZE; x++) {
    const offset = (y * TEXTURE_SIZE + x) * 4;
    const checker = ((x >> 3) + (y >> 3)) % 2;
    const vein = Math.sin(x * 0.34 + Math.sin(y * 0.19) * 3) > 0.72;
    pixels[offset] = vein ? 248 : checker ? 72 : 210;
    pixels[offset + 1] = vein ? 225 : checker ? 202 : 74;
    pixels[offset + 2] = vein ? 92 : checker ? 235 : 188;
    pixels[offset + 3] = 255;
  }
  return pixels;
}

function createNormalTexture(): Uint8Array<ArrayBuffer> {
  const pixels = new Uint8Array(TEXTURE_SIZE * TEXTURE_SIZE * 4);
  for (let y = 0; y < TEXTURE_SIZE; y++) for (let x = 0; x < TEXTURE_SIZE; x++) {
    const offset = (y * TEXTURE_SIZE + x) * 4;
    const nx = Math.sin(x * 0.32) * 0.16;
    const ny = Math.cos(y * 0.28 + x * 0.08) * 0.16;
    const nz = Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny));
    pixels[offset] = Math.round((nx * 0.5 + 0.5) * 255);
    pixels[offset + 1] = Math.round((ny * 0.5 + 0.5) * 255);
    pixels[offset + 2] = Math.round((nz * 0.5 + 0.5) * 255);
    pixels[offset + 3] = 255;
  }
  return pixels;
}

function createSphereMesh(widthSegments: number, heightSegments: number): {
  readonly vertices: Float32Array<ArrayBuffer>;
  readonly indices: Uint32Array<ArrayBuffer>;
} {
  const vertices: number[] = [];
  const indices: number[] = [];
  for (let y = 0; y <= heightSegments; y++) {
    const v = y / heightSegments;
    const phi = v * Math.PI;
    for (let x = 0; x <= widthSegments; x++) {
      const u = x / widthSegments;
      const theta = u * Math.PI * 2;
      const sinPhi = Math.sin(phi);
      const px = Math.cos(theta) * sinPhi;
      const py = Math.cos(phi);
      const pz = Math.sin(theta) * sinPhi;
      vertices.push(px, py, pz, px, py, pz, -Math.sin(theta), 0, Math.cos(theta), u * 3, v * 2);
    }
  }
  const stride = widthSegments + 1;
  for (let y = 0; y < heightSegments; y++) for (let x = 0; x < widthSegments; x++) {
    const a = y * stride + x;
    const b = a + stride;
    indices.push(a, b, a + 1, a + 1, b, b + 1);
  }
  return { vertices: new Float32Array(vertices), indices: new Uint32Array(indices) };
}
