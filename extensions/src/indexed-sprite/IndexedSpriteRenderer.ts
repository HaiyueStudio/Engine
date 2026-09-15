import indexedSpriteWgsl from '../shaders/generated/2d-ui-indexed-sprite.generated.wgsl';
import { prepareIndexedSpriteAtlas } from './AtlasLayout';
import {
  DEFAULT_INDEXED_SPRITE_ATLAS_LIMITS,
  type IndexedSpriteAtlasLayout,
  type IndexedSpriteAtlasLimits,
  type IndexedSpriteAtlasPage,
  type IndexedSpriteBlend,
  type IndexedSpriteDrawCommand,
  type IndexedSpritePaletteDescriptor,
  type IndexedSpritePlaneDescriptor,
  type IndexedSpriteRendererStats,
  type IndexedSpriteSampling,
} from './contracts';

const INSTANCE_BYTES = 144;
const INSTANCE_WORDS = INSTANCE_BYTES / 4;
const WHITE = [1, 1, 1, 1] as const;
const IDENTITY_COLOR = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0] as const;
const compareCommands = (a: PreparedCommand, b: PreparedCommand) =>
  (a.command!.priority ?? 0) - (b.command!.priority ?? 0) || a.sourceOrder - b.sourceOrder;

interface GpuPage {
  readonly page: IndexedSpriteAtlasPage;
  readonly texture: GPUTexture;
  readonly nearestBindGroup: GPUBindGroup;
  readonly linearBindGroup: GPUBindGroup;
}

interface UploadJob {
  readonly texture: GPUTexture;
  readonly width: number;
  readonly height: number;
  readonly bytesPerPixel: number;
  readonly pixels: Uint8Array;
  nextRow: number;
}

interface PreparedCommand {
  command: IndexedSpriteDrawCommand | null;
  pageIndex: number;
  pageKind: 'indexed' | 'color';
  sampling: IndexedSpriteSampling;
  blend: IndexedSpriteBlend;
  sourceOrder: number;
}

export interface IndexedSpriteRendererOptions {
  readonly targetFormat: GPUTextureFormat;
  readonly limits?: IndexedSpriteAtlasLimits;
  readonly label?: string;
  readonly sampleCount?: 1 | 4;
}

export class IndexedSpriteRenderer {
  readonly layout: IndexedSpriteAtlasLayout;
  readonly limits: IndexedSpriteAtlasLimits;
  readonly targetFormat: GPUTextureFormat;
  readonly label: string;
  readonly sampleCount: 1 | 4;
  #device: GPUDevice;
  #pipelines = new Map<IndexedSpriteBlend, GPURenderPipeline>();
  #pages: GpuPage[] = [];
  #paletteTexture: GPUTexture | null = null;
  #dummyIndexTexture: GPUTexture | null = null;
  #dummyColorTexture: GPUTexture | null = null;
  #nearestSampler: GPUSampler | null = null;
  #linearSampler: GPUSampler | null = null;
  #frameBindGroup: GPUBindGroup | null = null;
  #viewportBuffer: GPUBuffer | null = null;
  #instanceBuffer: GPUBuffer | null = null;
  #uploadJobs: UploadJob[] = [];
  #uploadedBytes = 0;
  #drawCommands = 0;
  #drawCalls = 0;
  #batches = 0;
  #generation = 0;
  #disposed = false;
  #prepared: PreparedCommand[] = [];
  #commandPool: PreparedCommand[] = [];
  #instanceData = new ArrayBuffer(0);
  #instanceFloats = new Float32Array(this.#instanceData);
  #instanceUints = new Uint32Array(this.#instanceData);
  #viewportData = new Float32Array(4);

  constructor(
    device: GPUDevice,
    sprites: readonly IndexedSpritePlaneDescriptor[],
    palettes: readonly IndexedSpritePaletteDescriptor[],
    options: IndexedSpriteRendererOptions,
  ) {
    this.#device = device;
    this.targetFormat = options.targetFormat;
    this.limits = options.limits ?? DEFAULT_INDEXED_SPRITE_ATLAS_LIMITS;
    this.label = options.label ?? 'IndexedSpriteRenderer';
    this.sampleCount = options.sampleCount ?? 1;
    this.layout = prepareIndexedSpriteAtlas(sprites, palettes, this.limits);
    this.#createGpuResources();
  }

  get ready(): boolean { return !this.#disposed && this.#uploadJobs.length === 0; }

  upload(maxBytes = this.limits.maxUploadBytesPerFrame): IndexedSpriteRendererStats {
    this.#assertAlive();
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > this.limits.maxUploadBytesPerFrame) throw new RangeError(`Indexed sprite upload budget must be between 1 and ${this.limits.maxUploadBytesPerFrame}.`);
    let remaining = maxBytes;
    while (remaining > 0 && this.#uploadJobs.length > 0) {
      const job = this.#uploadJobs[0]!;
      const sourceBytesPerRow = job.width * job.bytesPerPixel;
      const alignedBytesPerRow = align(sourceBytesPerRow, 256);
      if (alignedBytesPerRow > maxBytes) throw new RangeError(`One indexed sprite atlas row requires ${alignedBytesPerRow} upload bytes, exceeding maxUploadBytesPerFrame=${maxBytes}.`);
      const rows = Math.min(job.height - job.nextRow, Math.floor(remaining / alignedBytesPerRow));
      if (rows < 1) break;
      const upload = new Uint8Array(alignedBytesPerRow * rows);
      for (let row = 0; row < rows; row++) {
        const sourceOffset = (job.nextRow + row) * sourceBytesPerRow;
        upload.set(job.pixels.subarray(sourceOffset, sourceOffset + sourceBytesPerRow), row * alignedBytesPerRow);
      }
      this.#device.queue.writeTexture(
        { texture: job.texture, origin: { x: 0, y: job.nextRow, z: 0 } },
        upload,
        { offset: 0, bytesPerRow: alignedBytesPerRow, rowsPerImage: rows },
        { width: job.width, height: rows, depthOrArrayLayers: 1 },
      );
      const sourceUploaded = sourceBytesPerRow * rows;
      this.#uploadedBytes += sourceUploaded;
      remaining -= alignedBytesPerRow * rows;
      job.nextRow += rows;
      if (job.nextRow === job.height) this.#uploadJobs.shift();
    }
    return this.stats();
  }

  uploadAll(): IndexedSpriteRendererStats {
    while (!this.ready) this.upload(this.limits.maxUploadBytesPerFrame);
    return this.stats();
  }

  render(pass: GPURenderPassEncoder, commands: readonly IndexedSpriteDrawCommand[], viewportWidth: number, viewportHeight: number): IndexedSpriteRendererStats {
    this.#assertAlive();
    if (!this.ready) throw new Error('Indexed sprite renderer cannot draw until all bounded uploads are complete.');
    if (!Number.isFinite(viewportWidth) || !Number.isFinite(viewportHeight) || viewportWidth <= 0 || viewportHeight <= 0) throw new RangeError('Indexed sprite viewport must be finite and positive.');
    if (commands.length > this.limits.maxDrawCommandsPerFrame) throw new RangeError(`Indexed sprite draw command count exceeds ${this.limits.maxDrawCommandsPerFrame}.`);
    const prepared = this.#prepared;
    const bytes = commands.length * INSTANCE_BYTES;
    if (bytes > this.#instanceData.byteLength) {
      const capacity = Math.min(this.limits.maxDrawCommandsPerFrame, Math.max(64, 2 ** Math.ceil(Math.log2(commands.length))));
      this.#instanceData = new ArrayBuffer(capacity * INSTANCE_BYTES);
      this.#instanceFloats = new Float32Array(this.#instanceData);
      this.#instanceUints = new Uint32Array(this.#instanceData);
    }
    try {
    let ordered = true, previousPriority = -Infinity;
    for (let i = 0; i < commands.length; i++) {
      const value = this.#prepareCommand(commands[i]!, i);
      prepared.push(value);
      const priority = commands[i]!.priority ?? 0;
      if (priority < previousPriority) ordered = false;
      previousPriority = priority;
    }
    if (!ordered) prepared.sort(compareCommands);
    for (let i = 0; i < prepared.length; i++) this.#writeInstance(prepared[i]!, i * INSTANCE_WORDS, this.#instanceFloats, this.#instanceUints);
    // writeBuffer copies immediately; CPU scratch can be reused after this call.
    if (bytes > 0) this.#device.queue.writeBuffer(this.#instanceBuffer!, 0, this.#instanceData, 0, bytes);
    this.#viewportData[0] = viewportWidth; this.#viewportData[1] = viewportHeight;
    this.#device.queue.writeBuffer(this.#viewportBuffer!, 0, this.#viewportData);
    pass.setBindGroup(0, this.#frameBindGroup!);
    let batchStart = 0;
    let drawCalls = 0;
    while (batchStart < prepared.length) {
      const first = prepared[batchStart]!;
      let batchEnd = batchStart + 1;
      while (batchEnd < prepared.length) {
        const next = prepared[batchEnd]!;
        if (next.pageIndex !== first.pageIndex || next.sampling !== first.sampling || next.blend !== first.blend) break;
        batchEnd++;
      }
      const page = this.#pages[first.pageIndex]!;
      pass.setPipeline(this.#pipelines.get(first.blend)!);
      pass.setBindGroup(1, first.sampling === 'linear' ? page.linearBindGroup : page.nearestBindGroup);
      pass.draw(6, batchEnd - batchStart, 0, batchStart);
      drawCalls++;
      batchStart = batchEnd;
    }
    this.#drawCommands = prepared.length;
    this.#drawCalls = drawCalls;
    this.#batches = drawCalls;
    return this.stats();
    } finally {
      for (const value of prepared) value.command = null;
      prepared.length = 0;
    }
  }

  recover(device: GPUDevice): void {
    this.#assertAlive();
    this.#destroyGpuResources();
    this.#device = device;
    this.#generation++;
    this.#uploadedBytes = 0;
    this.#createGpuResources();
  }

  stats(): IndexedSpriteRendererStats {
    const pendingUploadBytes = Math.max(0, this.layout.gpuBytes - this.#uploadedBytes);
    return Object.freeze({
      pageCount: this.layout.pages.length,
      indexedPageCount: this.layout.pages.filter(page => page.kind === 'indexed').length,
      colorPageCount: this.layout.pages.filter(page => page.kind === 'color').length,
      paletteCount: this.layout.paletteRows.size,
      cpuBytes: this.layout.cpuBytes,
      gpuBytes: this.layout.gpuBytes,
      uploadedBytes: this.#uploadedBytes,
      pendingUploadBytes,
      textureCount: this.#disposed ? 0 : this.#pages.length + 3,
      drawCommands: this.#drawCommands,
      drawCalls: this.#drawCalls,
      batches: this.#batches,
      generation: this.#generation,
      ready: this.ready,
      disposed: this.#disposed,
    });
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#destroyGpuResources();
    this.#prepared.length = 0; this.#commandPool.length = 0;
    this.#instanceData = new ArrayBuffer(0);
    this.#instanceFloats = new Float32Array(this.#instanceData);
    this.#instanceUints = new Uint32Array(this.#instanceData);
  }

  #createGpuResources(): void {
    const maximumDimension = this.#device.limits.maxTextureDimension2D;
    for (const page of this.layout.pages) if (page.width > maximumDimension || page.height > maximumDimension) throw new RangeError(`Indexed sprite atlas page ${page.index} exceeds the device texture limit ${maximumDimension}.`);
    if (this.layout.paletteWidth > maximumDimension || this.layout.paletteHeight > maximumDimension) throw new RangeError('Indexed sprite palette bank exceeds the device texture limit.');
    const module = this.#device.createShaderModule({ label: `${this.label}.shader`, code: indexedSpriteWgsl });
    const frameLayout = this.#device.createBindGroupLayout({
      label: `${this.label}.frameLayout`,
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
      ],
    });
    const materialLayout = this.#device.createBindGroupLayout({
      label: `${this.label}.materialLayout`,
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'uint' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
      ],
    });
    const pipelineLayout = this.#device.createPipelineLayout({ label: `${this.label}.pipelineLayout`, bindGroupLayouts: [frameLayout, materialLayout] });
    for (const blend of ['alpha', 'additive', 'subtractive', 'opaque'] as const) this.#pipelines.set(blend, this.#device.createRenderPipeline({
      label: `${this.label}.pipeline.${blend}`,
      layout: pipelineLayout,
      vertex: { module, entryPoint: 'vs_main' },
      fragment: { module, entryPoint: 'fs_main', targets: [colorTarget(this.targetFormat, blend)] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      multisample: { count: this.sampleCount },
    }));
    this.#viewportBuffer = this.#device.createBuffer({ label: `${this.label}.viewport`, size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.#instanceBuffer = this.#device.createBuffer({ label: `${this.label}.instances`, size: this.limits.maxDrawCommandsPerFrame * INSTANCE_BYTES, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.#frameBindGroup = this.#device.createBindGroup({ label: `${this.label}.frame`, layout: frameLayout, entries: [{ binding: 0, resource: { buffer: this.#viewportBuffer } }, { binding: 1, resource: { buffer: this.#instanceBuffer } }] });
    this.#nearestSampler = this.#device.createSampler({ label: `${this.label}.nearest`, magFilter: 'nearest', minFilter: 'nearest', mipmapFilter: 'nearest', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
    this.#linearSampler = this.#device.createSampler({ label: `${this.label}.linear`, magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'nearest', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
    this.#dummyIndexTexture = createTexture(this.#device, `${this.label}.dummyIndex`, 1, 1, 'r8uint');
    this.#dummyColorTexture = createTexture(this.#device, `${this.label}.dummyColor`, 1, 1, 'rgba8unorm');
    this.#paletteTexture = createTexture(this.#device, `${this.label}.palettes`, this.layout.paletteWidth, this.layout.paletteHeight, 'rgba8unorm');
    this.#uploadJobs.push({ texture: this.#paletteTexture, width: this.layout.paletteWidth, height: this.layout.paletteHeight, bytesPerPixel: 4, pixels: this.layout.palettePixels, nextRow: 0 });
    for (const page of this.layout.pages) {
      const texture = createTexture(this.#device, `${this.label}.${page.kind}.${page.index}`, page.width, page.height, page.kind === 'indexed' ? 'r8uint' : 'rgba8unorm');
      this.#uploadJobs.push({ texture, width: page.width, height: page.height, bytesPerPixel: page.bytesPerPixel, pixels: page.pixels, nextRow: 0 });
      const entriesWithoutSampler: GPUBindGroupEntry[] = [
        { binding: 0, resource: (page.kind === 'indexed' ? texture : this.#dummyIndexTexture).createView() },
        { binding: 1, resource: (page.kind === 'color' ? texture : this.#dummyColorTexture).createView() },
        { binding: 2, resource: this.#paletteTexture.createView() },
      ];
      const makeBindGroup = (sampling: IndexedSpriteSampling, sampler: GPUSampler) => this.#device.createBindGroup({ label: `${this.label}.${page.index}.${sampling}`, layout: materialLayout, entries: [...entriesWithoutSampler, { binding: 3, resource: sampler }] });
      this.#pages.push({ page, texture, nearestBindGroup: makeBindGroup('nearest', this.#nearestSampler), linearBindGroup: makeBindGroup('linear', this.#linearSampler) });
    }
  }

  #prepareCommand(command: IndexedSpriteDrawCommand, sourceOrder: number): PreparedCommand {
    const placement = this.layout.placements.get(command.spriteId);
    if (!placement) throw new RangeError(`Indexed sprite draw references unknown sprite ${command.spriteId}.`);
    if (placement.pageKind === 'indexed' && (!command.paletteId || !this.layout.paletteRows.has(command.paletteId))) throw new RangeError(`Indexed sprite ${command.spriteId} requires a known paletteId.`);
    if (!Number.isFinite(command.x) || !Number.isFinite(command.y) || !Number.isFinite(command.axisX ?? 0) || !Number.isFinite(command.axisY ?? 0) || !Number.isFinite(command.scaleX ?? 1) || !Number.isFinite(command.scaleY ?? 1) || !Number.isFinite(command.rotationRadians ?? 0) || !Number.isFinite(command.opacity ?? 1) || !Number.isFinite(command.priority ?? 0) || !Number.isFinite(command.depth ?? 0.5)) throw new RangeError('Indexed sprite draw contains a non-finite number.');
    const opacity = command.opacity ?? 1;
    if (opacity < 0 || opacity > 1) throw new RangeError('Indexed sprite opacity must be in [0,1].');
    const value = this.#commandPool[sourceOrder] ??= { command: null, pageIndex: 0, pageKind: 'color', sampling: 'nearest', blend: 'alpha', sourceOrder };
    value.command = command; value.pageIndex = placement.pageIndex; value.pageKind = placement.pageKind;
    value.sampling = command.sampling ?? 'nearest'; value.blend = command.blend ?? 'alpha';
    return value;
  }

  #writeInstance(prepared: PreparedCommand, offset: number, floats: Float32Array, uints: Uint32Array): void {
    const command = prepared.command!;
    const placement = this.layout.placements.get(command.spriteId)!;
    floats[offset] = command.x; floats[offset + 1] = command.y; floats[offset + 2] = command.scaleX ?? 1; floats[offset + 3] = command.scaleY ?? 1;
    floats[offset + 4] = placement.width; floats[offset + 5] = placement.height; floats[offset + 6] = command.axisX ?? 0; floats[offset + 7] = command.axisY ?? 0;
    floats[offset + 8] = placement.x; floats[offset + 9] = placement.y; floats[offset + 10] = placement.width; floats[offset + 11] = placement.height;
    floats[offset + 12] = command.rotationRadians ?? 0; floats[offset + 13] = command.depth ?? 0.5; floats[offset + 14] = command.opacity ?? 1; floats[offset + 15] = 0;
    uints[offset + 16] = prepared.pageKind === 'indexed' ? this.layout.paletteRows.get(command.paletteId!)! : 0;
    uints[offset + 17] = (prepared.pageKind === 'indexed' ? 1 : 0) | (prepared.sampling === 'linear' ? 2 : 0) | (command.flipX ? 4 : 0) | (command.flipY ? 8 : 0);
    uints[offset + 18] = 0; uints[offset + 19] = 0;
    const tint = command.tint ?? WHITE;
    for (let index = 0; index < 4; index++) { const value = tint[index]!; if (!Number.isFinite(value)) throw new RangeError('Indexed sprite tint must be finite.'); floats[offset + 20 + index] = value; }
    const colorMatrix = command.colorMatrix ?? IDENTITY_COLOR;
    if (colorMatrix.length !== 12) throw new RangeError('Indexed sprite colorMatrix must contain twelve values.');
    for (let index = 0; index < 12; index++) { const value = colorMatrix[index]!; if (!Number.isFinite(value)) throw new RangeError('Indexed sprite colorMatrix must be finite.'); floats[offset + 24 + index] = value; }
  }

  #destroyGpuResources(): void {
    for (const page of this.#pages) page.texture.destroy();
    this.#paletteTexture?.destroy(); this.#dummyIndexTexture?.destroy(); this.#dummyColorTexture?.destroy();
    this.#viewportBuffer?.destroy(); this.#instanceBuffer?.destroy();
    this.#pages = []; this.#pipelines.clear(); this.#uploadJobs = [];
    this.#paletteTexture = null; this.#dummyIndexTexture = null; this.#dummyColorTexture = null;
    this.#nearestSampler = null; this.#linearSampler = null; this.#frameBindGroup = null;
    this.#viewportBuffer = null; this.#instanceBuffer = null;
  }

  #assertAlive(): void { if (this.#disposed) throw new Error('Indexed sprite renderer is disposed.'); }
}

function createTexture(device: GPUDevice, label: string, width: number, height: number, format: GPUTextureFormat): GPUTexture { return device.createTexture({ label, size: { width, height, depthOrArrayLayers: 1 }, format, usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST }); }
function align(value: number, alignment: number): number { return Math.ceil(value / alignment) * alignment; }
function blendState(blend: IndexedSpriteBlend): GPUBlendState | undefined {
  if (blend === 'opaque') return undefined;
  if (blend === 'additive') return { color: { operation: 'add', srcFactor: 'src-alpha', dstFactor: 'one' }, alpha: { operation: 'add', srcFactor: 'one', dstFactor: 'one' } };
  if (blend === 'subtractive') return { color: { operation: 'reverse-subtract', srcFactor: 'src-alpha', dstFactor: 'one' }, alpha: { operation: 'add', srcFactor: 'zero', dstFactor: 'one' } };
  return { color: { operation: 'add', srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' }, alpha: { operation: 'add', srcFactor: 'one', dstFactor: 'one-minus-src-alpha' } };
}

function colorTarget(format: GPUTextureFormat, blend: IndexedSpriteBlend): GPUColorTargetState {
  const state = blendState(blend);
  return state
    ? { format, blend: state, writeMask: GPUColorWrite.ALL }
    : { format, writeMask: GPUColorWrite.ALL };
}
