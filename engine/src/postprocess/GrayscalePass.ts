import { PostProcessPass, getPostProcessTextureView } from './PostProcessPass';
import type { PipelineWarmupPlan } from '../renderer/PipelineWarmup';
import { getBuiltinPostprocessShader } from './BuiltinPostprocessShader';

export class GrayscalePass extends PostProcessPass {
  readonly label = 'Grayscale';

  private _pipeline: GPURenderPipeline | null = null;
  private _module!: GPUShaderModule;
  private _pipelineLayout!: GPUPipelineLayout;
  private _format!: GPUTextureFormat;
  private _bgl!: GPUBindGroupLayout;
  private _sampler!: GPUSampler;
  private _lastSrc: GPUTexture | null = null;
  private _bg: GPUBindGroup | null = null;

  prepare(device: GPUDevice, format: GPUTextureFormat): void {
    const shader = getBuiltinPostprocessShader(device, 'grayscale');
    this._module = shader.module;
    this._bgl = shader.bindGroupLayout;
    this._pipelineLayout = shader.pipelineLayout;
    this._format = format;

    this._sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
  }

  override contributePipelineWarmup(plan: PipelineWarmupPlan, device: GPUDevice): void {
    this.addPipelineWarmup(plan, 'main', 'Grayscale', device, () => this._pipelineDescriptor(),
      () => this._pipeline !== null, pipeline => { this._pipeline = pipeline; });
  }

  apply(
    encoder: GPUCommandEncoder,
    src: GPUTexture,
    dstView: GPUTextureView,
    device: GPUDevice,
  ): void {
    if (src !== this._lastSrc) {
      this._bg = device.createBindGroup({
        layout: this._bgl,
        entries: [
          { binding: 0, resource: getPostProcessTextureView(src) },
          { binding: 1, resource: this._sampler },
        ],
      });
      this._lastSrc = src;
    }

    const pass = encoder.beginRenderPass({
      label: 'GrayscalePass.renderPass',
      colorAttachments: [{
        view:       dstView,
        loadOp:     'clear',
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
        storeOp:    'store',
      }],
    });
    pass.setPipeline(this._pipeline ??= device.createRenderPipeline(this._pipelineDescriptor()));
    pass.setBindGroup(0, this._bg!);
    pass.draw(3);
    pass.end();
  }

  override destroy(): void {
    this._pipeline = null;
    this._lastSrc = null;
    this._bg = null;
  }

  private _pipelineDescriptor(): GPURenderPipelineDescriptor {
    return {
      label: 'GrayscalePass.pipeline',
      layout: this._pipelineLayout,
      vertex: { module: this._module, entryPoint: 'vs_main' },
      fragment: { module: this._module, entryPoint: 'fs_main', targets: [{ format: this._format }] },
      primitive: { topology: 'triangle-list' },
    };
  }
}
