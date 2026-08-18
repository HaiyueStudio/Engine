import { PostProcessPass, getPostProcessTextureView } from './PostProcessPass';
import type { PipelineWarmupPlan } from '../renderer/PipelineWarmup';
import { getBuiltinPostprocessShader } from './BuiltinPostprocessShader';
import { PrecompiledUniformBlockWriter } from '../shader/PrecompiledShaderRuntime';

export interface GaussianBlurPassOptions {
  /** Number of texels to sample on each side of centre (default 4). */
  radius?: number;
  /** Gaussian standard deviation in texels (default radius / 2). */
  sigma?: number;
}

export class GaussianBlurPass extends PostProcessPass {
  readonly label = 'GaussianBlur';

  private _radius: number;
  private _sigma:  number;

  private _pipeline: GPURenderPipeline | null = null;
  private _module!: GPUShaderModule;
  private _pipelineLayout!: GPUPipelineLayout;
  private _format!: GPUTextureFormat;
  private _bgl!: GPUBindGroupLayout;
  private _sampler!: GPUSampler;

  // Horizontal intermediate buffer
  private _hTex!: GPUTexture;
  private _hView!: GPUTextureView;

  // Per-direction uniform buffers (H and V)
  private _hParamsBuf!: GPUBuffer;
  private _vParamsBuf!: GPUBuffer;
  private _paramsWriter!: PrecompiledUniformBlockWriter;

  // Bind groups (src-texture changes between frames only on resize)
  private _lastSrc: GPUTexture | null = null;
  private _hBG: GPUBindGroup | null = null;
  private _vBG!: GPUBindGroup;

  constructor(options: GaussianBlurPassOptions = {}) {
    super();
    this._radius = options.radius ?? 4;
    this._sigma  = options.sigma  ?? this._radius / 2;
  }

  prepare(device: GPUDevice, format: GPUTextureFormat, width: number, height: number): void {
    const shader = getBuiltinPostprocessShader(device, 'gaussian-blur');
    this._module = shader.module;
    this._bgl = shader.bindGroupLayout;
    this._pipelineLayout = shader.pipelineLayout;
    this._paramsWriter = new PrecompiledUniformBlockWriter(shader.pass, 'pass.gaussianBlurParameters');
    this._format = format;

    this._sampler = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });

    this._createSizedResources(device, format, width, height);
  }

  override contributePipelineWarmup(plan: PipelineWarmupPlan, device: GPUDevice): void {
    this.addPipelineWarmup(plan, 'main', 'Gaussian blur', device, () => this._pipelineDescriptor(),
      () => this._pipeline !== null, pipeline => { this._pipeline = pipeline; });
  }

  resize(device: GPUDevice, format: GPUTextureFormat, width: number, height: number): void {
    this._createSizedResources(device, format, width, height);
    // Force hBG rebuild on next apply() since src dimensions changed
    this._lastSrc = null;
  }

  apply(
    encoder: GPUCommandEncoder,
    src: GPUTexture,
    dstView: GPUTextureView,
    device: GPUDevice,
  ): void {
    // Rebuild H bind group if src texture changed (e.g. on resize / chain reorder)
    if (src !== this._lastSrc) {
      this._hBG = device.createBindGroup({
        layout: this._bgl,
        entries: [
          { binding: 0, resource: getPostProcessTextureView(src) },
          { binding: 1, resource: this._sampler },
          { binding: 2, resource: { buffer: this._hParamsBuf } },
        ],
      });
      this._lastSrc = src;
    }

    // ── Horizontal pass: src → _hTex ──────────────────────────────────────
    const hPass = encoder.beginRenderPass({
      label: 'GaussianBlurPass.H',
      colorAttachments: [{
        view: this._hView,
        loadOp:     'clear',
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
        storeOp:    'store',
      }],
    });
    const pipeline = this._pipeline ??= device.createRenderPipeline(this._pipelineDescriptor());
    hPass.setPipeline(pipeline);
    hPass.setBindGroup(0, this._hBG!);
    hPass.draw(3);
    hPass.end();

    // ── Vertical pass: _hTex → dstView ────────────────────────────────────
    const vPass = encoder.beginRenderPass({
      label: 'GaussianBlurPass.V',
      colorAttachments: [{
        view: dstView,
        loadOp:     'clear',
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
        storeOp:    'store',
      }],
    });
    vPass.setPipeline(pipeline);
    vPass.setBindGroup(0, this._vBG);
    vPass.draw(3);
    vPass.end();
  }

  destroy(): void {
    this._pipeline = null;
    this._hTex?.destroy();
    this._hParamsBuf?.destroy();
    this._vParamsBuf?.destroy();
    this._lastSrc = null;
    this._hBG = null;
  }

  private _pipelineDescriptor(): GPURenderPipelineDescriptor {
    return {
      label: 'GaussianBlurPass.pipeline',
      layout: this._pipelineLayout,
      vertex: { module: this._module, entryPoint: 'vs_main' },
      fragment: { module: this._module, entryPoint: 'fs_main', targets: [{ format: this._format }] },
      primitive: { topology: 'triangle-list' },
    };
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private _createSizedResources(
    device: GPUDevice,
    format: GPUTextureFormat,
    width: number,
    height: number,
  ): void {
    this._hTex?.destroy();
    this._hParamsBuf?.destroy();
    this._vParamsBuf?.destroy();

    this._hTex = device.createTexture({
      size:   [width, height],
      format,
      usage:  GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    this._hView = this._hTex.createView();

    const texelW = 1 / width;
    const texelH = 1 / height;

    this._hParamsBuf = this._writeParamsBuf(device, 1, 0, texelW, texelH);
    this._vParamsBuf = this._writeParamsBuf(device, 0, 1, texelW, texelH);

    // V bind group uses the fixed _hTex as source — created once here
    this._vBG = device.createBindGroup({
      layout: this._bgl,
      entries: [
        { binding: 0, resource: this._hView },
        { binding: 1, resource: this._sampler },
        { binding: 2, resource: { buffer: this._vParamsBuf } },
      ],
    });
    // Force hBG rebuild next apply()
    this._lastSrc = null;
  }

  private _writeParamsBuf(
    device: GPUDevice,
    dx: number,
    dy: number,
    texelW: number,
    texelH: number,
  ): GPUBuffer {
    // BlurParams layout (32 bytes):
    //   direction (vec2<f32>) : 8
    //   texelSize (vec2<f32>) : 8
    //   sigma     (f32)       : 4
    //   radius    (i32)       : 4
    //   _pad      (vec2<u32>) : 8
    const buf = device.createBuffer({
      size: this._paramsWriter.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const writer = this._paramsWriter;
    writer.setF32('direction', 0, dx);
    writer.setF32('direction', 1, dy);
    writer.setF32('texelSize', 0, texelW);
    writer.setF32('texelSize', 1, texelH);
    writer.setF32('sigma', 0, this._sigma);
    writer.setI32('radius', 0, this._radius);
    writer.setU32('padding', 0, 0);
    writer.setU32('padding', 1, 0);
    device.queue.writeBuffer(buf, 0, writer.buffer);
    return buf;
  }
}
