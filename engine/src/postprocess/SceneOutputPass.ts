import { PostProcessPass, getPostProcessTextureView, type PostProcessSceneTextures } from './PostProcessPass';
import { getRenderViewPassOptions, type RenderViewSnapshot } from '../core/RenderView';
import type { PipelineWarmupPlan } from '../renderer/PipelineWarmup';
import { getBuiltinPostprocessShader } from './BuiltinPostprocessShader';
import { isLinearColorTarget } from './SceneColor';
import { getPostProcessRecording } from './PostProcessSubmission';
import { getInstrumentedGPUResourceTracker } from '../core/GPUResourceTracker';
import {SubmissionLifetime} from '../rtt/SubmissionLifetime';
import {getRegionSceneProjection} from '../core/RegionSceneProjection';
import {SceneOutputCrop} from './SceneOutputCrop';

interface OutputBinding {
  readonly uniform: GPUBuffer;
  readonly values: Float32Array;
  readonly lifetime: SubmissionLifetime;
  source: GPUTexture | null;
  group: GPUBindGroup | null;
  lastFrame: number;
}

/** Renderer-owned final stage. User effects always precede this display boundary. */
export class SceneOutputPass extends PostProcessPass {
  readonly label = 'Scene output';
  private _device: GPUDevice | null = null;
  private _sourceCrop:SceneOutputCrop|null=null;
  private _shader!: ReturnType<typeof getBuiltinPostprocessShader>;
  private readonly _pipelines = new Map<string, GPURenderPipeline>();
  private readonly _bindings = new Map<string, OutputBinding>();
  private _textures: PostProcessSceneTextures = {};
  private _view: RenderViewSnapshot | undefined;
  private _format: GPUTextureFormat = 'rgba8unorm';
  private _exposure = 1;
  private _toneMapping: 'none' | 'reinhard' = 'reinhard';
  private _displayInLinearTarget=false;
  private _frameIdentity: {frameId:number;viewKey:string} | undefined;

  /** Internal compositor identity; this pass does not consume camera matrices. */
  setFrameIdentity(frameId: number, viewKey: string): void {this._frameIdentity = {frameId,viewKey};}

  configure(format: GPUTextureFormat, exposure: number, toneMapping: 'none' | 'reinhard', view?: RenderViewSnapshot, displayInLinearTarget=false): void {
    if (!Number.isFinite(exposure) || exposure < 0) throw new RangeError('Scene output exposure must be finite and nonnegative.');
    if (toneMapping !== 'none' && toneMapping !== 'reinhard') throw new RangeError('Scene output toneMapping must be none or reinhard.');
    this._format = format; this._exposure = exposure; this._toneMapping = toneMapping; this._view = view;this._displayInLinearTarget=displayInLinearTarget;
  }

  prepare(device: GPUDevice): void {
    if (this._device === device) return;
    if (this._device) this.destroy();
    this._device = device;
    this._sourceCrop=new SceneOutputCrop(device);
    this._shader = getBuiltinPostprocessShader(device, 'output');
  }

  override contributePipelineWarmup(plan: PipelineWarmupPlan, device: GPUDevice): void {
    const format = this._format;
    for (const sampleCount of [1, 4]) for (const blend of [false, true]) {
      const key = `${format}:${blend}:${sampleCount}`;
      this.addPipelineWarmup(plan, key, 'Scene output', device, () => this._descriptor(format, blend, sampleCount),
        () => this._pipelines.has(key), pipeline => { this._pipelines.set(key, pipeline); });
    }
  }

  override setSceneTextures(textures: PostProcessSceneTextures): void { this._textures = textures; }

  apply(encoder: GPUCommandEncoder, src: GPUTexture, dst: GPUTextureView, device: GPUDevice): void {
    const frame = this._textures.frame ?? this._frameIdentity;
    if (!frame) throw new Error('Scene output requires a view frame.');
    const projection=getRegionSceneProjection(this._view);
    if(projection)src=this._sourceCrop!.copy(this,encoder,src,projection.crop,frame.frameId);
    for (const [key, binding] of this._bindings) {
      if (frame.frameId - binding.lastFrame <= 120 || key === frame.viewKey) continue;
      binding.lifetime.retire(); this._bindings.delete(key);
    }
    // Mode 3 uses the existing display transform without the final transfer;
    // the regional compositor performs that transfer once after GUI composition.
    const transfer = isLinearColorTarget(this._format) ? (this._displayInLinearTarget?3:0) : this._format.endsWith('-srgb') ? 2 : 1;
    const tone = this._toneMapping === 'reinhard' ? 1 : 0;
    let binding = this._bindings.get(frame.viewKey);
    const changed = !binding || binding.values[0] !== Math.fround(this._exposure) || binding.values[1] !== tone || binding.values[2] !== transfer;
    // A queue write precedes every as-yet-unsubmitted encoder. Preserve its
    // immutable parameters instead of overwriting it with a later view/frame.
    if(binding && changed && binding.lifetime.hasPendingRecordings){binding.lifetime.retire();binding=undefined;}
    if (!binding) {
      const uniform=device.createBuffer({label:`SceneOutput.${frame.viewKey}.params`,size:16,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
      const next:OutputBinding={uniform,values:new Float32Array([NaN,NaN,NaN,NaN]),source:null,group:null,lastFrame:frame.frameId,
        lifetime:new SubmissionLifetime(device,()=>destroyBinding(next,device))};
      binding=next;this._bindings.set(frame.viewKey,binding);
    }
    binding.lastFrame = frame.frameId;
    const recording=getPostProcessRecording(this);
    if(recording)binding.lifetime.retainSubmission(recording,recording.afterSubmit,recording.afterCancel);
    if (binding.values[0] !== Math.fround(this._exposure) || binding.values[1] !== tone || binding.values[2] !== transfer) {
      binding.values.set([this._exposure, tone, transfer, 0]);
      device.queue.writeBuffer(binding.uniform, 0, binding.values.buffer as ArrayBuffer);
    }
    if (binding.source !== src || !binding.group) {
      if (binding.group) getInstrumentedGPUResourceTracker(device)?.untrackObject(binding.group);
      binding.group = device.createBindGroup({ label: `SceneOutput.${frame.viewKey}`, layout: this._shader.bindGroupLayout,
        entries: [{ binding: 0, resource: getPostProcessTextureView(src) }, { binding: 1, resource: { buffer: binding.uniform } }] });
      binding.source = src;
    }
    const blend = this._view?.loadOp === 'load';
    const sampleCount = this._view?.sampleCount ?? 1;
    const key = `${this._format}:${blend}:${sampleCount}`;
    let pipeline = this._pipelines.get(key);
    if (!pipeline) { pipeline = device.createRenderPipeline(this._descriptor(this._format, blend, sampleCount)); this._pipelines.set(key, pipeline); }
    const viewport = this._view?.viewport;
    const scissor = this._view?.scissor;
    // Populate the destination's MSAA attachment as well as its resolve target so
    // later display/UI passes can load it without resolving stale samples over this view.
    const targetAttachment = this._view ? [...this._view.target.getRenderPassDescriptor(getRenderViewPassOptions(this._view)).colorAttachments][0] : null;
    const pass = encoder.beginRenderPass({ label: 'SceneOutput.renderPass', colorAttachments: [{
      view: sampleCount > 1 && targetAttachment ? targetAttachment.view : dst,
      ...(sampleCount > 1 ? { resolveTarget: dst } : {}),
      loadOp: blend || viewport || scissor ? 'load' : 'clear', clearValue: { r: 0, g: 0, b: 0, a: 0 }, storeOp: 'store' }] });
    // Establish output coverage explicitly on every view. Native four-view probes
    // can leave the clear untouched when relying on implicit full-target state.
    const target = this._view?.target;
    if (viewport) pass.setViewport(viewport.x, viewport.y, viewport.width, viewport.height, 0, 1);
    else if (target) pass.setViewport(0, 0, target.width, target.height, 0, 1);
    if (scissor) pass.setScissorRect(scissor.x, scissor.y, scissor.width, scissor.height);
    else if (target) pass.setScissorRect(0, 0, target.width, target.height);
    pass.setPipeline(pipeline); pass.setBindGroup(0, binding.group); pass.draw(3); pass.end();
  }

  override destroy(): void {
    this._sourceCrop?.destroy();this._sourceCrop=null;
    for(const binding of this._bindings.values())binding.lifetime.retire();
    this._bindings.clear(); this._pipelines.clear(); this._device = null; this._textures = {}; this._view = undefined; this._frameIdentity = undefined;
  }

  private _descriptor(format: GPUTextureFormat, blend: boolean, sampleCount: number): GPURenderPipelineDescriptor {
    return { label: 'SceneOutput.pipeline', layout: this._shader.pipelineLayout,
      vertex: { module: this._shader.module, entryPoint: 'vs_main' },
      fragment: { module: this._shader.module, entryPoint: 'fs_main', targets: [{ format,
        ...(blend ? { blend: { color: { srcFactor: 'one' as const, dstFactor: 'one-minus-src-alpha' as const },
          alpha: { srcFactor: 'one' as const, dstFactor: 'one-minus-src-alpha' as const } } } : {}) }] },
      primitive: { topology: 'triangle-list' }, multisample: { count: sampleCount } };
  }
}

function destroyBinding(binding: OutputBinding, device: GPUDevice | null): void {
  if (device && binding.group) getInstrumentedGPUResourceTracker(device)?.untrackObject(binding.group);
  binding.uniform.destroy();
}
