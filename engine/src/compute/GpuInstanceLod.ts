import type { IEngine } from '../core/IEngine';
import type { RenderCommandContext } from '../core/RenderCommandContext';
import type { GpuInstanceSource } from '../renderer/GpuInstanceSource';
import { getBuiltinComputeShader } from '../shader/BuiltinComputeShader';
export interface GpuInstanceLodView {
  readonly planes: ArrayLike<number>;
  readonly viewMatrix: ArrayLike<number>;
  /** abs(projection[5]) * viewportHeight / 2; works for orthographic zoom too. */
  readonly projectionPixelScale: number;
  readonly perspective: boolean;
  readonly nearPixels?: number;
  readonly middlePixels?: number;
  readonly hysteresis?: number;
  /** Must conservatively include animation, weapons and death poses. */
  readonly localSphere: readonly [number, number, number, number];
}
/** Three opaque LOD buckets with stable application IDs, no CPU visibility
 * readback. Own one classifier per view to keep hysteresis view-local. */
export class GpuInstanceLod {
  readonly visibleIndices: GPUBuffer;
  readonly counts: GPUBuffer;
  readonly levels: GPUBuffer;
  readonly strideBytes: number;
  private params: GPUBuffer;
  private device: GPUDevice;
  private pipeline: GPUComputePipeline;
  private layout: GPUBindGroupLayout;
  private bound: GPUBuffer | null = null;
  private bindings: GPUBindGroup | null = null;
  private data = new ArrayBuffer(224);
  private floats = new Float32Array(this.data);
  private words = new Uint32Array(this.data);
  private destroyed = false;
  private encoded = new WeakSet<GPUCommandEncoder>();
  constructor(private engine: IEngine, readonly capacity: number) {
    const device = this.device = engine.device;
    if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity * 64 > device.limits.maxStorageBufferBindingSize) throw new RangeError('LOD capacity exceeds storage limits.');
    const alignment = Math.max(4, device.limits.minStorageBufferOffsetAlignment);
    this.strideBytes = Math.ceil(capacity * 4 / alignment) * alignment;
    if (this.strideBytes * 3 > device.limits.maxStorageBufferBindingSize || Math.ceil(capacity / 64) > device.limits.maxComputeWorkgroupsPerDimension) throw new RangeError('LOD visibility or dispatch exceeds device limits.');
    const shader = getBuiltinComputeShader(device, 'instanced-lod');
    this.layout = shader.bindGroupLayout;
    this.pipeline = device.createComputePipeline({ label: 'GpuInstanceLod', layout: shader.pipelineLayout, compute: { module: shader.module, entryPoint: 'cs_main' } });
    const storage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST;
    this.visibleIndices = device.createBuffer({ label: 'GpuInstanceLod.visible', size: this.strideBytes * 3, usage: storage });
    this.counts = device.createBuffer({ label: 'GpuInstanceLod.counts', size: 12, usage: storage });
    this.levels = device.createBuffer({ label: 'GpuInstanceLod.history', size: capacity * 4, usage: storage });
    this.params = device.createBuffer({ label: 'GpuInstanceLod.params', size: 224, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.reset();
  }
  reset(): void { this.assertDevice(); this.device.queue.writeBuffer(this.levels, 0, new Uint32Array(this.capacity).fill(3)); }
  encode(context: RenderCommandContext, transforms: GPUBuffer, count: number, view: GpuInstanceLodView): void {
    this.assertDevice();
    if (this.encoded.has(context.encoder)) throw new Error('Use a separate LOD owner per view/dispatch; uniform data must remain immutable within a submission.');
    if (context.device !== this.device || context.passEncoder) throw new Error('LOD requires its device and an encoder outside render passes.');
    if (!Number.isSafeInteger(count) || count < 0 || count > this.capacity || transforms.size < this.capacity * 64 || !(transforms.usage & GPUBufferUsage.STORAGE)) throw new RangeError('Invalid LOD input.');
    const near = view.nearPixels ?? 48, middle = view.middlePixels ?? 16, hysteresis = view.hysteresis ?? .15;
    if (view.planes.length !== 24 || view.viewMatrix.length !== 16 || ![...Array.from(view.planes), ...Array.from(view.viewMatrix), ...view.localSphere, view.projectionPixelScale, near, middle, hysteresis].every(Number.isFinite) || view.localSphere[3] < 0 || middle <= 0 || near <= middle || hysteresis < 0 || hysteresis >= .5 || view.projectionPixelScale <= 0) throw new RangeError('Invalid LOD camera/bounds/thresholds.');
    if (this.bound !== transforms) {
      this.bindings = this.device.createBindGroup({ layout: this.layout, entries: [transforms, this.visibleIndices, this.counts, this.levels, this.params].map((buffer, binding) => ({ binding, resource: { buffer } })) });
      this.bound = transforms;
    }
    this.floats.set(Array.from(view.planes), 0); this.floats.set(Array.from(view.viewMatrix), 24);
    this.floats.set([view.projectionPixelScale, Number(view.perspective), near, middle], 40);
    this.floats[44] = hysteresis; this.floats.set(view.localSphere, 48);
    this.words.set([count, this.capacity, this.strideBytes / 4, 0], 52);
    this.encoded.add(context.encoder);
    this.device.queue.writeBuffer(this.params, 0, this.data);
    context.encoder.clearBuffer(this.counts);
    if (count === 0) return;
    const pass = context.encoder.beginComputePass({ label: 'GpuInstanceLod.classify' });
    pass.setPipeline(this.pipeline); pass.setBindGroup(0, this.bindings!); pass.dispatchWorkgroups(Math.ceil(count / 64)); pass.end();
  }
  source(lod: number, transforms: GPUBuffer, colors: GPUBuffer): GpuInstanceSource {
    this.checkLevel(lod); this.assertDevice();
    return { device: this.device, transforms, colors, visibleIndices: this.visibleIndices, visibleOffset: lod * this.strideBytes, capacity: this.capacity, count: this.capacity };
  }
  /** Initialize the rest of the indexed command once, then copy only its GPU
   * count. firstInstance must be zero: no indirect-first-instance requirement. */
  encodeDrawCount(context: RenderCommandContext, lod: number, command: GPUBuffer, offset = 0): void {
    this.checkLevel(lod); this.assertDevice();
    if (context.device !== this.device || context.passEncoder || !Number.isSafeInteger(offset) || offset < 0 || offset % 4 || offset + 20 > command.size || !(command.usage & GPUBufferUsage.INDIRECT) || !(command.usage & GPUBufferUsage.COPY_DST)) throw new RangeError('Invalid LOD indexed draw command.');
    context.encoder.copyBufferToBuffer(this.counts, lod * 4, command, offset + 4, 4);
  }
  destroy(): void { if (this.destroyed) return; this.destroyed = true; for (const b of [this.visibleIndices, this.counts, this.levels, this.params]) b.destroy(); }
  private checkLevel(lod: number): void { if (!Number.isInteger(lod) || lod < 0 || lod > 2) throw new RangeError('LOD must be 0, 1 or 2.'); }
  private assertDevice(): void { if (this.destroyed || this.engine.device !== this.device) throw new Error('LOD owner is destroyed or belongs to a lost device; rebuild it.'); }
}
