import { PostProcessPass, getPostProcessTextureView } from './PostProcessPass';
import type { PipelineWarmupPlan } from '../renderer/PipelineWarmup';
import { getBuiltinPostprocessShader } from './BuiltinPostprocessShader';
import { PrecompiledUniformBlockWriter } from '../shader/PrecompiledShaderRuntime';

export interface SobelPassOptions {
  /** RGB color used for detected edges. Defaults to white. */
  edgeColor?: [number, number, number];
  /** Multiplier applied to the Sobel magnitude. Defaults to 1.5. */
  strength?: number;
  /** Edge cutoff in luma-gradient space. Defaults to 0.08. */
  threshold?: number;
  /** Amount of edge color blended over the original scene. Defaults to 1.0. */
  blend?: number;
  /** Render only the Sobel edge image instead of compositing over the scene. Defaults to false. */
  edgeOnly?: boolean;
}

export class SobelPass extends PostProcessPass {
  readonly label = 'Sobel';

  edgeColor: [number, number, number];
  strength: number;
  threshold: number;
  blend: number;
  edgeOnly: boolean;

  private _pipeline: GPURenderPipeline | null = null;
  private _module!: GPUShaderModule;
  private _pipelineLayout!: GPUPipelineLayout;
  private _format!: GPUTextureFormat;
  private _bgl!: GPUBindGroupLayout;
  private _sampler!: GPUSampler;
  private _uniformBuffer!: GPUBuffer;
  private _uniformWriter!: PrecompiledUniformBlockWriter;
  private _lastSrc: GPUTexture | null = null;
  private _bg: GPUBindGroup | null = null;

  constructor(options: SobelPassOptions = {}) {
    super();
    this.edgeColor = options.edgeColor ?? [1, 1, 1];
    this.strength = options.strength ?? 1.5;
    this.threshold = options.threshold ?? 0.08;
    this.blend = options.blend ?? 1;
    this.edgeOnly = options.edgeOnly ?? false;
  }

  prepare(device: GPUDevice, format: GPUTextureFormat): void {
    const shader = getBuiltinPostprocessShader(device, 'sobel');
    this._module = shader.module;
    this._bgl = shader.bindGroupLayout;
    this._pipelineLayout = shader.pipelineLayout;
    this._uniformWriter = new PrecompiledUniformBlockWriter(shader.pass, 'pass.sobelParameters');
    this._format = format;

    this._sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
    this._uniformBuffer = device.createBuffer({
      label: 'SobelPass.params',
      size: this._uniformWriter.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
  }

  override contributePipelineWarmup(plan: PipelineWarmupPlan, device: GPUDevice): void {
    this.addPipelineWarmup(plan, 'main', 'Sobel', device, () => this._pipelineDescriptor(),
      () => this._pipeline !== null, pipeline => { this._pipeline = pipeline; });
  }

  apply(
    encoder: GPUCommandEncoder,
    src: GPUTexture,
    dstView: GPUTextureView,
    device: GPUDevice,
  ): void {
    this._writeUniforms(device);

    if (src !== this._lastSrc) {
      this._bg = device.createBindGroup({
        layout: this._bgl,
        entries: [
          { binding: 0, resource: getPostProcessTextureView(src) },
          { binding: 1, resource: this._sampler },
          { binding: 2, resource: { buffer: this._uniformBuffer } },
        ],
      });
      this._lastSrc = src;
    }

    const pass = encoder.beginRenderPass({
      label: 'SobelPass.renderPass',
      colorAttachments: [{
        view: dstView,
        loadOp: 'clear',
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
        storeOp: 'store',
      }],
    });
    pass.setPipeline(this._pipeline ??= device.createRenderPipeline(this._pipelineDescriptor()));
    pass.setBindGroup(0, this._bg!);
    pass.draw(3);
    pass.end();
  }

  override destroy(): void {
    this._pipeline = null;
    this._uniformBuffer?.destroy();
    this._lastSrc = null;
    this._bg = null;
  }

  private _pipelineDescriptor(): GPURenderPipelineDescriptor {
    return {
      label: 'SobelPass.pipeline',
      layout: this._pipelineLayout,
      vertex: { module: this._module, entryPoint: 'vs_main' },
      fragment: { module: this._module, entryPoint: 'fs_main', targets: [{ format: this._format }] },
      primitive: { topology: 'triangle-list' },
    };
  }

  private _writeUniforms(device: GPUDevice): void {
    const writer = this._uniformWriter;
    writer.setF32('edgeColorStrength', 0, this.edgeColor[0]);
    writer.setF32('edgeColorStrength', 1, this.edgeColor[1]);
    writer.setF32('edgeColorStrength', 2, this.edgeColor[2]);
    writer.setF32('edgeColorStrength', 3, this.strength);
    writer.setF32('thresholdBlendMode', 0, this.threshold);
    writer.setF32('thresholdBlendMode', 1, this.blend);
    writer.setF32('thresholdBlendMode', 2, this.edgeOnly ? 1 : 0);
    writer.setF32('thresholdBlendMode', 3, 0);
    device.queue.writeBuffer(this._uniformBuffer, 0, writer.buffer);
  }
}
