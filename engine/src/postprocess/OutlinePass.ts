import { PostProcessPass, getPostProcessTextureView } from './PostProcessPass';
import type { PostProcessSceneTextures } from './PostProcessPass';
import type { ColorValue } from '../color/Color';
import { resolveColor, type ColorLike } from '../color/ColorLike';
import type { PipelineWarmupPlan } from '../renderer/PipelineWarmup';
import { getBuiltinPostprocessShader } from './BuiltinPostprocessShader';
import { PrecompiledUniformBlockWriter } from '../shader/PrecompiledShaderRuntime';

export interface OutlinePassOptions {
  visibleEdgeColor?: ColorLike;
  hiddenEdgeColor?: ColorLike;
  edgeStrength?: number;
  edgeThickness?: number;
  edgeGlow?: number;
  /** How edge colors are composited over the rendered scene. Defaults to `add`. */
  blendMode?: 'add' | 'replace' | 'multiply';
}

export class OutlinePass extends PostProcessPass {
  readonly label = 'Outline';
  override readonly needsOutlineMask = true;

  private _visibleEdgeColor: ColorValue;
  private _hiddenEdgeColor: ColorValue;
  get visibleEdgeColor(): ColorValue { return this._visibleEdgeColor; }
  set visibleEdgeColor(value: ColorLike) { this._visibleEdgeColor = resolveColor(value); }
  get hiddenEdgeColor(): ColorValue { return this._hiddenEdgeColor; }
  set hiddenEdgeColor(value: ColorLike) { this._hiddenEdgeColor = resolveColor(value); }
  edgeStrength: number;
  edgeThickness: number;
  edgeGlow: number;
  blendMode: 'add' | 'replace' | 'multiply';

  private _edgePipeline: GPURenderPipeline | null = null;
  private _blurPipeline: GPURenderPipeline | null = null;
  private _overlayPipeline: GPURenderPipeline | null = null;
  private _edgeModule!: GPUShaderModule;
  private _blurModule!: GPUShaderModule;
  private _overlayModule!: GPUShaderModule;
  private _edgeLayout!: GPUPipelineLayout;
  private _blurLayout!: GPUPipelineLayout;
  private _overlayLayout!: GPUPipelineLayout;
  private _edgeBgl!: GPUBindGroupLayout;
  private _blurBgl!: GPUBindGroupLayout;
  private _overlayBgl!: GPUBindGroupLayout;
  private _sampler!: GPUSampler;
  private _paramsBuf!: GPUBuffer;
  private _blurHParamsBuf!: GPUBuffer;
  private _blurVParamsBuf!: GPUBuffer;
  private _paramsWriter!: PrecompiledUniformBlockWriter;
  private _blurWriter!: PrecompiledUniformBlockWriter;
  private _fallbackMask!: GPUTexture;
  private _edgeTex!: GPUTexture;
  private _edgeView!: GPUTextureView;
  private _blurTex!: GPUTexture;
  private _blurView!: GPUTextureView;
  private _glowTex!: GPUTexture;
  private _glowView!: GPUTextureView;
  private _maskTex: GPUTexture | null = null;
  private _visibleMaskTex: GPUTexture | null = null;
  private _lastMask: GPUTexture | null = null;
  private _lastVisibleMask: GPUTexture | null = null;
  private _lastSrc: GPUTexture | null = null;
  private _edgeBg: GPUBindGroup | null = null;
  private _blurHBg!: GPUBindGroup;
  private _blurVBg!: GPUBindGroup;
  private _overlayBg: GPUBindGroup | null = null;
  private _width = 1;
  private _height = 1;
  private _format!: GPUTextureFormat;
  private readonly _colorScratch = new Float32Array(4);

  constructor(options: OutlinePassOptions = {}) {
    super();
    this._visibleEdgeColor = resolveColor(options.visibleEdgeColor);
    this._hiddenEdgeColor = resolveColor(options.hiddenEdgeColor, [0.1, 0.04, 0.02, 1]);
    this.edgeStrength = options.edgeStrength ?? 3;
    this.edgeThickness = options.edgeThickness ?? 1;
    this.edgeGlow = options.edgeGlow ?? 0;
    this.blendMode = options.blendMode ?? 'add';
  }

  prepare(device: GPUDevice, format: GPUTextureFormat, width: number, height: number): void {
    this._format = format;
    this._width = width;
    this._height = height;
    this._sampler = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });
    const edge = getBuiltinPostprocessShader(device, 'outline-edge');
    const blur = getBuiltinPostprocessShader(device, 'outline-blur');
    const overlay = getBuiltinPostprocessShader(device, 'outline-overlay');
    this._edgeModule = edge.module;
    this._edgeBgl = edge.bindGroupLayout;
    this._edgeLayout = edge.pipelineLayout;
    this._blurModule = blur.module;
    this._blurBgl = blur.bindGroupLayout;
    this._blurLayout = blur.pipelineLayout;
    this._overlayModule = overlay.module;
    this._overlayBgl = overlay.bindGroupLayout;
    this._overlayLayout = overlay.pipelineLayout;
    this._paramsWriter = new PrecompiledUniformBlockWriter(overlay.pass, 'pass.outlineParameters');
    this._blurWriter = new PrecompiledUniformBlockWriter(blur.pass, 'pass.outlineBlurParameters');
    this._paramsBuf = device.createBuffer({
      size: this._paramsWriter.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this._blurHParamsBuf = device.createBuffer({
      size: this._blurWriter.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this._blurVParamsBuf = device.createBuffer({
      size: this._blurWriter.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this._fallbackMask = this._createFallbackTexture(device);

    this._createSizedResources(device, width, height);
  }

  override contributePipelineWarmup(plan: PipelineWarmupPlan, device: GPUDevice): void {
    this.addPipelineWarmup(
      plan, 'edge', 'Outline edge', device,
      () => this._pipelineDescriptor(this._edgeModule, this._edgeLayout, 'OutlinePass.edgePipeline'),
      () => this._edgePipeline !== null, pipeline => { this._edgePipeline = pipeline; },
    );
    this.addPipelineWarmup(
      plan, 'blur', 'Outline blur', device,
      () => this._pipelineDescriptor(this._blurModule, this._blurLayout, 'OutlinePass.blurPipeline'),
      () => this._blurPipeline !== null, pipeline => { this._blurPipeline = pipeline; },
    );
    this.addPipelineWarmup(
      plan, 'overlay', 'Outline overlay', device,
      () => this._pipelineDescriptor(this._overlayModule, this._overlayLayout, 'OutlinePass.overlayPipeline'),
      () => this._overlayPipeline !== null, pipeline => { this._overlayPipeline = pipeline; },
    );
  }

  override resize(device: GPUDevice, _format: GPUTextureFormat, width: number, height: number): void {
    this._width = width;
    this._height = height;
    this._createSizedResources(device, width, height);
    this._lastSrc = null;
    this._lastMask = null;
    this._lastVisibleMask = null;
  }

  override setSceneTextures(textures: PostProcessSceneTextures): void {
    this._maskTex = textures.outlineMask ?? null;
    this._visibleMaskTex = textures.outlineVisibleMask ?? null;
  }

  apply(
    encoder: GPUCommandEncoder,
    src: GPUTexture,
    dstView: GPUTextureView,
    device: GPUDevice,
  ): void {
    this._writeParams(device);
    this._ensureBindGroups(device, src);
    const edgePipeline = this._edgePipeline ??= device.createRenderPipeline(
      this._pipelineDescriptor(this._edgeModule, this._edgeLayout, 'OutlinePass.edgePipeline'),
    );
    const blurPipeline = this._blurPipeline ??= device.createRenderPipeline(
      this._pipelineDescriptor(this._blurModule, this._blurLayout, 'OutlinePass.blurPipeline'),
    );
    const overlayPipeline = this._overlayPipeline ??= device.createRenderPipeline(
      this._pipelineDescriptor(this._overlayModule, this._overlayLayout, 'OutlinePass.overlayPipeline'),
    );

    const edgePass = encoder.beginRenderPass({
      label: 'OutlinePass.edge',
      colorAttachments: [{
        view: this._edgeView,
        loadOp: 'clear',
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
        storeOp: 'store',
      }],
    });
    edgePass.setPipeline(edgePipeline);
    edgePass.setBindGroup(0, this._edgeBg!);
    edgePass.draw(3);
    edgePass.end();

    const blurH = encoder.beginRenderPass({
      label: 'OutlinePass.blurH',
      colorAttachments: [{
        view: this._blurView,
        loadOp: 'clear',
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
        storeOp: 'store',
      }],
    });
    blurH.setPipeline(blurPipeline);
    blurH.setBindGroup(0, this._blurHBg);
    blurH.draw(3);
    blurH.end();

    const blurV = encoder.beginRenderPass({
      label: 'OutlinePass.blurV',
      colorAttachments: [{
        view: this._glowView,
        loadOp: 'clear',
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
        storeOp: 'store',
      }],
    });
    blurV.setPipeline(blurPipeline);
    blurV.setBindGroup(0, this._blurVBg);
    blurV.draw(3);
    blurV.end();

    const overlay = encoder.beginRenderPass({
      label: 'OutlinePass.overlay',
      colorAttachments: [{
        view: dstView,
        loadOp: 'clear',
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
        storeOp: 'store',
      }],
    });
    overlay.setPipeline(overlayPipeline);
    overlay.setBindGroup(0, this._overlayBg!);
    overlay.draw(3);
    overlay.end();
  }

  override destroy(): void {
    this._edgePipeline = null;
    this._blurPipeline = null;
    this._overlayPipeline = null;
    this._paramsBuf?.destroy();
    this._blurHParamsBuf?.destroy();
    this._blurVParamsBuf?.destroy();
    this._fallbackMask?.destroy();
    this._edgeTex?.destroy();
    this._blurTex?.destroy();
    this._glowTex?.destroy();
    this._maskTex = null;
    this._visibleMaskTex = null;
    this._lastMask = null;
    this._lastVisibleMask = null;
    this._lastSrc = null;
    this._edgeBg = null;
    this._overlayBg = null;
  }

  private _pipelineDescriptor(
    module: GPUShaderModule,
    layout: GPUPipelineLayout,
    label: string,
  ): GPURenderPipelineDescriptor {
    return {
      label,
      layout,
      vertex: { module, entryPoint: 'vs_main' },
      fragment: { module, entryPoint: 'fs_main', targets: [{ format: this._format }] },
      primitive: { topology: 'triangle-list' },
    };
  }

  private _createSizedResources(device: GPUDevice, width: number, height: number): void {
    this._edgeTex?.destroy();
    this._blurTex?.destroy();
    this._glowTex?.destroy();
    const desc = {
      size: [Math.max(1, width), Math.max(1, height)] as [number, number],
      format: this._format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    };
    this._edgeTex = device.createTexture({ ...desc, label: 'OutlinePass.edgeTex' });
    this._edgeView = this._edgeTex.createView();
    this._blurTex = device.createTexture({ ...desc, label: 'OutlinePass.blurTex' });
    this._blurView = this._blurTex.createView();
    this._glowTex = device.createTexture({ ...desc, label: 'OutlinePass.glowTex' });
    this._glowView = this._glowTex.createView();
    this._blurHBg = device.createBindGroup({
      layout: this._blurBgl,
      entries: [
        { binding: 0, resource: this._edgeView },
        { binding: 1, resource: this._sampler },
        { binding: 2, resource: { buffer: this._blurHParamsBuf } },
      ],
    });
    this._blurVBg = device.createBindGroup({
      layout: this._blurBgl,
      entries: [
        { binding: 0, resource: this._blurView },
        { binding: 1, resource: this._sampler },
        { binding: 2, resource: { buffer: this._blurVParamsBuf } },
      ],
    });
  }

  private _ensureBindGroups(device: GPUDevice, src: GPUTexture): void {
    const maskTex = this._maskTex ?? this._fallbackMask;
    const visibleMaskTex = this._visibleMaskTex ?? this._fallbackMask;
    if (maskTex !== this._lastMask || visibleMaskTex !== this._lastVisibleMask) {
      this._edgeBg = device.createBindGroup({
        layout: this._edgeBgl,
        entries: [
          { binding: 0, resource: getPostProcessTextureView(maskTex) },
          { binding: 1, resource: getPostProcessTextureView(visibleMaskTex) },
          { binding: 2, resource: this._sampler },
          { binding: 3, resource: { buffer: this._paramsBuf } },
        ],
      });
      this._lastMask = maskTex;
      this._lastVisibleMask = visibleMaskTex;
    }
    if (src !== this._lastSrc || !this._overlayBg) {
      this._overlayBg = device.createBindGroup({
        layout: this._overlayBgl,
        entries: [
          { binding: 0, resource: getPostProcessTextureView(src) },
          { binding: 1, resource: this._edgeView },
          { binding: 2, resource: this._glowView },
          { binding: 3, resource: this._sampler },
          { binding: 4, resource: { buffer: this._paramsBuf } },
          { binding: 5, resource: getPostProcessTextureView(maskTex) },
        ],
      });
      this._lastSrc = src;
    }
  }

  private _writeParams(device: GPUDevice): void {
    const writer = this._paramsWriter;
    const color = this._colorScratch;
    this.visibleEdgeColor.writeSRGB(color);
    for (let component = 0; component < 3; component++) writer.setF32('visibleEdgeColor', component, color[component]!);
    writer.setF32('visibleEdgeColor', 3, 1);
    this.hiddenEdgeColor.writeSRGB(color);
    for (let component = 0; component < 3; component++) writer.setF32('hiddenEdgeColor', component, color[component]!);
    writer.setF32('hiddenEdgeColor', 3, 1);
    writer.setF32('edgeStrength', 0, this.edgeStrength);
    writer.setF32('edgeThickness', 0, this.edgeThickness);
    writer.setF32('edgeGlow', 0, this.edgeGlow);
    writer.setF32('blendMode', 0, this.blendMode === 'replace' ? 1 : this.blendMode === 'multiply' ? 2 : 0);
    device.queue.writeBuffer(this._paramsBuf, 0, writer.buffer);

    const radius = Math.max(1, Math.min(12, this.edgeThickness * (1.5 + this.edgeGlow * 8)));
    const texelX = 1 / Math.max(1, this._width);
    const texelY = 1 / Math.max(1, this._height);
    this._writeBlurParams(device, this._blurHParamsBuf, 1, 0, texelX, texelY, radius);
    this._writeBlurParams(device, this._blurVParamsBuf, 0, 1, texelX, texelY, radius);
  }

  private _writeBlurParams(
    device: GPUDevice,
    buffer: GPUBuffer,
    directionX: number,
    directionY: number,
    texelX: number,
    texelY: number,
    radius: number,
  ): void {
    const writer = this._blurWriter;
    writer.setF32('direction', 0, directionX);
    writer.setF32('direction', 1, directionY);
    writer.setF32('texelSize', 0, texelX);
    writer.setF32('texelSize', 1, texelY);
    writer.setF32('radius', 0, radius);
    writer.setF32('padding0', 0, 0);
    writer.setF32('padding1', 0, 0);
    writer.setF32('padding2', 0, 0);
    device.queue.writeBuffer(buffer, 0, writer.buffer);
  }

  private _createFallbackTexture(device: GPUDevice): GPUTexture {
    const texture = device.createTexture({
      size: [1, 1],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    const pixel = new Uint8Array([0, 0, 0, 255]) as Uint8Array<ArrayBuffer>;
    device.queue.writeTexture({ texture }, pixel, { bytesPerRow: 4 }, [1, 1]);
    return texture;
  }
}
