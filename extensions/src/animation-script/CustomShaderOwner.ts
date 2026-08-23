import { AnimationScriptRuntimeError, scriptRuntimeFail } from './diagnostics.js';
import { validateSandboxedWgsl, type ValidatedSandboxedShader } from './WgslSandboxValidator.js';
import type { RuntimeScriptLimits, SandboxedShaderModule } from './runtime-types.js';

interface PipelineRecord {
  readonly generation: number;
  readonly validated: ValidatedSandboxedShader;
  readonly pipeline: GPURenderPipeline;
  readonly layout: GPUBindGroupLayout;
}

export interface CustomShaderOwnerOptions {
  readonly pipelineTimeoutMs?: number | undefined;
}

export class CustomShaderOwner {
  private generation = 1;
  private readonly pipelines = new Map<string, PipelineRecord>();
  private readonly buffers = new Map<GPUBuffer, number>();
  private uniformBytes = 0;
  private drawCount = 0;
  private disposed = false;
  private deviceLost = false;
  private readonly pipelineTimeoutMs: number;

  constructor(private device: GPUDevice, private readonly limits: RuntimeScriptLimits, options: CustomShaderOwnerOptions = {}) {
    this.pipelineTimeoutMs = options.pipelineTimeoutMs ?? 250;
    this.watchDevice(device, this.generation);
  }

  async compile(module: SandboxedShaderModule): Promise<GPURenderPipeline> {
    this.assertReady();
    const validated = validateSandboxedWgsl(module, this.limits);
    const cached = this.pipelines.get(validated.canonicalKey);
    if (cached !== undefined && cached.generation === this.generation) return cached.pipeline;
    if (this.pipelines.size >= this.limits.maxPipelines) scriptRuntimeFail('E_SHADER_BUDGET', 'Pipeline cache budget exceeded.');
    const generation = this.generation;
    const device = this.device;
    const shaderModule = device.createShaderModule({ label: `sandbox:${module.id}`, code: module.source });
    await compilationCheck(shaderModule, module.id);
    const layout = device.createBindGroupLayout({ entries: module.bindings.map(bindingLayout) });
    const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] });
    const creation = device.createRenderPipelineAsync({
      label: `sandbox:${module.id}`,
      layout: pipelineLayout,
      vertex: { module: shaderModule, entryPoint: module.vertexEntryPoint },
      fragment: { module: shaderModule, entryPoint: module.fragmentEntryPoint, targets: [{ format: module.targetFormat }] },
      primitive: { topology: 'triangle-list' },
    });
    let pipeline: GPURenderPipeline;
    try { pipeline = await withTimeout(creation, this.pipelineTimeoutMs); }
    catch (error) {
      if (error instanceof AnimationScriptRuntimeError) throw error;
      scriptRuntimeFail('E_SHADER_VALIDATION', error instanceof Error ? error.message : 'Pipeline creation failed.');
    }
    if (this.disposed || generation !== this.generation || device !== this.device) scriptRuntimeFail('E_SHADER_DEVICE_LOST', 'Late pipeline result belongs to a retired device generation.');
    this.pipelines.set(validated.canonicalKey, { generation, validated, pipeline, layout });
    return pipeline;
  }

  createUniformBuffer(maxBytes: number): GPUBuffer {
    this.assertReady();
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > this.limits.maxUniformBytes) scriptRuntimeFail('E_SHADER_BUDGET', 'Uniform buffer size exceeds the declared budget.');
    const size = align(maxBytes, 16);
    if (this.uniformBytes + size > this.limits.maxUniformBytes) scriptRuntimeFail('E_SHADER_BUDGET', 'Aggregate uniform buffer budget exceeded.');
    const buffer = this.device.createBuffer({ size, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.buffers.set(buffer, size);
    this.uniformBytes += size;
    return buffer;
  }

  releaseBuffer(buffer: GPUBuffer): void {
    const bytes = this.buffers.get(buffer);
    if (bytes === undefined) return;
    this.buffers.delete(buffer);
    this.uniformBytes -= bytes;
    buffer.destroy();
  }

  beginFrame(): void { this.drawCount = 0; }

  recordDraw(): void {
    this.assertReady();
    if (++this.drawCount > this.limits.maxDrawsPerFrame) scriptRuntimeFail('E_SHADER_BUDGET', 'Per-frame custom draw budget exceeded.');
  }

  replaceDevice(device: GPUDevice): void {
    this.assertAlive();
    this.retireResources();
    this.generation += 1;
    this.device = device;
    this.deviceLost = false;
    this.watchDevice(device, this.generation);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation += 1;
    this.retireResources();
  }

  stats(): Readonly<{ generation: number; pipelines: number; buffers: number; uniformBytes: number; draws: number; deviceLost: boolean; disposed: boolean }> {
    return Object.freeze({ generation: this.generation, pipelines: this.pipelines.size, buffers: this.buffers.size, uniformBytes: this.uniformBytes, draws: this.drawCount, deviceLost: this.deviceLost, disposed: this.disposed });
  }

  private watchDevice(device: GPUDevice, generation: number): void {
    void device.lost.then(() => {
      if (this.disposed || this.device !== device || this.generation !== generation) return;
      this.deviceLost = true;
      this.generation += 1;
      this.retireResources();
    });
  }

  private retireResources(): void {
    for (const buffer of this.buffers.keys()) buffer.destroy();
    this.buffers.clear();
    this.uniformBytes = 0;
    this.pipelines.clear();
    this.drawCount = 0;
  }

  private assertAlive(): void { if (this.disposed) scriptRuntimeFail('E_SHADER_DEVICE_LOST', 'Custom shader owner is disposed.'); }
  private assertReady(): void { this.assertAlive(); if (this.deviceLost) scriptRuntimeFail('E_SHADER_DEVICE_LOST', 'GPU device generation is lost.'); }
}

function bindingLayout(binding: SandboxedShaderModule['bindings'][number]): GPUBindGroupLayoutEntry {
  const visibility = binding.visibility === 'vertex' ? GPUShaderStage.VERTEX
    : binding.visibility === 'fragment' ? GPUShaderStage.FRAGMENT
      : GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT;
  const base = { binding: binding.binding, visibility };
  if (binding.kind === 'uniform-buffer') return { ...base, buffer: { type: 'uniform', minBindingSize: binding.maxBytes ?? 1 } };
  if (binding.kind === 'sampled-texture') return { ...base, texture: { sampleType: 'float', viewDimension: '2d', multisampled: false } };
  return { ...base, sampler: { type: 'filtering' } };
}

async function compilationCheck(module: GPUShaderModule, id: string): Promise<void> {
  if (module.getCompilationInfo === undefined) return;
  const info = await module.getCompilationInfo();
  const error = info.messages.find(message => message.type === 'error');
  if (error !== undefined) scriptRuntimeFail(
    'E_SHADER_VALIDATION',
    `${id}:${error.lineNum}:${error.linePos}: ${error.message}`,
    {
      path: 'shader.source',
      location: { sourceId: `shader/${id}.wgsl`, line: error.lineNum, column: error.linePos },
    },
  );
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new AnimationScriptRuntimeError('E_SHADER_BUDGET', 'Pipeline compilation deadline exceeded.')), timeoutMs);
    promise.then(value => { clearTimeout(timeout); resolve(value); }, error => { clearTimeout(timeout); reject(error); });
  });
}

function align(value: number, alignment: number): number { return Math.ceil(value / alignment) * alignment; }
