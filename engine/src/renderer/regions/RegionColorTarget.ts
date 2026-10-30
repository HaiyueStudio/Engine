import type {IEngine} from '../../core/IEngine';
import type {RenderCommandContext} from '../../core/RenderCommandContext';
import type {RenderViewTarget, RenderViewTargetPassOptions} from '../../core/RenderView';
import {createGPUResourceOwner,estimateTextureBytes} from '../../core/GPUResourceTracker';
import {RttEngine} from '../../rtt/RttEngine';
import {SubmissionLifetime} from '../../rtt/SubmissionLifetime';
import {getRegionCacheBudget} from './RegionCacheBudget';
import {getRegionAttachmentAccounting,type RegionAttachmentLease} from './RegionAttachmentAccounting';
import {registerRegionRenderTarget} from '../../core/RegionRenderTarget';
import {enableRttSampleableMsaa} from '../../rtt/RttSampleableMsaa';

export interface RegionColorTargetSpec {
  readonly width: number; readonly height: number;
  readonly displayWidth: number; readonly displayHeight: number;
  readonly format: 'rgba8unorm' | 'rgba16float';
  readonly sampleCount: 1 | 4;
  readonly depthConvention: 'standard' | 'reverse';
  readonly sceneColor?: 'radiance' | 'display';
}
export type RegionColorTargetResult =
  | {readonly accepted: true; readonly target: RegionColorTarget;readonly resourceKey?:string;readonly history?:RegionColorTarget}
  | {readonly accepted: false; readonly reason: 'region-count' | 'color-bytes' | 'device-size'; readonly retainedBytes: number; readonly retainedRegions: number};

/** Region-sized retained attachments. Writer access and valid sampling have separate lifetimes. */
export class RegionColorTarget implements RenderViewTarget {
  readonly key: string;
  private readonly rtt: RttEngine;
  private readonly lifetime: SubmissionLifetime;
  private readonly written = new WeakSet<RenderCommandContext>();
  private readonly pending=new Set<RenderCommandContext>();
  private retired = false;
  private initialized = false;
  private generation = 0;
  readonly device: GPUDevice;
  readonly spec: Readonly<RegionColorTargetSpec>;
  readonly colorBytes: number;

  private constructor(engine: IEngine, identity: string, spec: RegionColorTargetSpec, private readonly reservation: RegionAttachmentLease, private readonly working=false) {
    this.key = `region-color:${++nextTarget}`; this.spec = Object.freeze({...spec}); this.device = engine.device; this.colorBytes = reservation.bytes;
    const label = `${this.key}:${identity}`;
    const rtt = new RttEngine(engine, spec.width, spec.height, {r:0,g:0,b:0,a:0}, label, createGPUResourceOwner('system', label), spec.format);
    try {
      // Reserve and allocate the resolve, MSAA color and depth as one transaction.
      if(!working)enableRttSampleableMsaa(rtt);
      rtt.msaaSamples = spec.sampleCount; rtt.reverseZ = spec.depthConvention === 'reverse';
      rtt.getRenderPassDescriptor(this.passOptions());
    } catch (error) {rtt.destroy(); throw error;}
    this.rtt = rtt;
    registerRegionRenderTarget(this,spec.sceneColor!=='radiance');
    this.lifetime = new SubmissionLifetime(engine.device, () => {try {rtt.destroy();} finally {reservation.release();}});
  }
  static create(engine: IEngine, identity: string, spec: RegionColorTargetSpec, countRegion = true): RegionColorTargetResult {
    validateSpec(spec);
    const budget = getRegionCacheBudget(engine.device), maximum = engine.device.limits.maxTextureDimension2D;
    if (spec.width > maximum || spec.height > maximum) return Object.freeze({accepted:false, reason:'device-size', ...budget.snapshot()});
    const bytes = spec.width * spec.height * (spec.format === 'rgba16float' ? 8 : 4) * (spec.sampleCount === 4 ? 5 : 1);
    if (!Number.isSafeInteger(bytes)) throw new Error('Region color allocation exceeds safe byte arithmetic.');
    const attempt = budget.reserve(identity, bytes, countRegion);
    if (!attempt.accepted) return attempt;
    const accounting=reserveAttachments(engine,spec,'cache');
    const reservation:RegionAttachmentLease={bytes,retire:()=>accounting.retire(),release:()=>{accounting.release();attempt.reservation.release();}};
    try {return Object.freeze({accepted:true, target:new RegionColorTarget(engine, identity, spec, reservation)});}
    catch (error) {reservation.release(); throw error;}
  }
  /** Per-presentation workspace, never a retained source of previous-frame pixels (ADR 0133). */
  static createWorking(engine:IEngine,spec:RegionColorTargetSpec):RegionColorTarget {
    validateSpec(spec);
    if(spec.width>engine.device.limits.maxTextureDimension2D||spec.height>engine.device.limits.maxTextureDimension2D)throw Error('Region working target exceeds device-size.');
    const reservation=reserveAttachments(engine,spec,'working');
    try{return new RegionColorTarget(engine,'frame-working-set',spec,reservation,true);}
    catch(error){reservation.release();throw error;}
  }
  get width(): number {return this.spec.width;}
  get height(): number {return this.spec.height;}
  get displayWidth(): number {return this.spec.displayWidth;}
  get displayHeight(): number {return this.spec.displayHeight;}
  get format(): GPUTextureFormat {return this.spec.format;}
  get contentGeneration(): number {return this.generation;}
  get valid(): boolean {return !this.working && this.initialized && !this.retired;}
  private passOptions(): RenderViewTargetPassOptions {return {sampleCount:this.spec.sampleCount, depthConvention:this.spec.depthConvention, clearColor:{r:0,g:0,b:0,a:0}};}
  getOutputView(): GPUTextureView {this.live(); return this.rtt.getOutputView();}
  /** Writer-only access. The caller must overwrite the whole texture and call encoded() before sampling. */
  copyDestination(context:RenderCommandContext):GPUTexture {this.live();this.retain(context);return this.rtt.colorTexture;}
  getRenderPassDescriptor(options: RenderViewTargetPassOptions): GPURenderPassDescriptor {
    this.live();
    if (options.sampleCount !== this.spec.sampleCount || options.depthConvention !== this.spec.depthConvention) throw new Error('Region attachment configuration is immutable.');
    const descriptor = this.rtt.getRenderPassDescriptor(options);
    // Retain the actual multisample color as well as its resolve. Scissor does not define a partial resolve.
    return {...descriptor, colorAttachments:Array.from(descriptor.colorAttachments, color => color ? {...color, loadOp:'clear', storeOp:'store'} : null)};
  }
  updateDescriptor(clear: boolean, context?: RenderCommandContext): GPURenderPassDescriptor {
    if (!clear && !(this.initialized&&!this.working) && !(context && this.written.has(context))) throw new Error('A new region target must be fully initialized before load.');
    const descriptor = this.getRenderPassDescriptor(this.passOptions());
    return {...descriptor, colorAttachments:Array.from(descriptor.colorAttachments, color => color ? {...color, loadOp:clear?'clear':'load'} : null)};
  }
  /** Mark only after a full initialization/update pass has been encoded. */
  encoded(context: RenderCommandContext): void {
    this.live(); this.retain(context);
    if (this.written.has(context)) return;
    this.written.add(context);
    context.afterSubmit!(() => {if (!this.retired) {this.initialized = true; this.generation++;}});
  }
  sample(context: RenderCommandContext): GPUTexture {
    this.live();
    if (!(this.initialized&&!this.working) && !this.written.has(context)) throw new Error('Cannot sample uninitialized region contents.');
    this.retain(context); return this.rtt.colorTexture;
  }
  historySamples(context:RenderCommandContext):GPUTextureView {
    this.sample(context);
    const view=this.rtt.msaaTextureView;
    if(!view)throw Error('Per-sample region history requires an MSAA attachment.');
    return view;
  }
  /** Different encoders have no queue order until their hosts submit them. */
  hasPendingOther(context:RenderCommandContext):boolean {return this.pending.size>Number(this.pending.has(context));}
  private retain(context:RenderCommandContext):void {
    this.lifetime.retain(context);if(this.pending.has(context))return;this.pending.add(context);
    const release=()=>{this.pending.delete(context);};
    try{context.afterSubmit!(release);context.afterCancel!(release);}catch(error){release();throw error;}
  }
  retire(): void {if (this.retired) return; this.retired = true; this.reservation.retire(); this.lifetime.retire();}
  abandon(): void {this.retired = true; this.reservation.retire(); this.lifetime.abandon();}
  private live(): void {if (this.retired) throw new Error('Region target is retired.');}
}
let nextTarget = 0;

function validateSpec(spec:RegionColorTargetSpec):void {
  if(spec.sceneColor!==undefined&&spec.sceneColor!=='radiance'&&spec.sceneColor!=='display')throw Error('Invalid region scene color meaning.');
  if (![spec.width,spec.height].every(n => Number.isSafeInteger(n) && n > 0) || ![spec.displayWidth,spec.displayHeight].every(n => Number.isFinite(n) && n > 0) || !['rgba8unorm','rgba16float'].includes(spec.format) || ![1,4].includes(spec.sampleCount) || !['standard','reverse'].includes(spec.depthConvention)) throw new Error('Invalid region target specification.');
}
function reserveAttachments(engine:IEngine,spec:RegionColorTargetSpec,kind:'cache'|'working'):RegionAttachmentLease {
  const color=estimateTextureBytes([spec.width,spec.height],spec.format)*(spec.sampleCount===4?5:1);
  const depth=estimateTextureBytes([spec.width,spec.height],engine.getDepthFormat(spec.depthConvention==='reverse'),spec.sampleCount);
  return getRegionAttachmentAccounting(engine.device).reserve(kind,color,depth);
}

/** Owns replacement transactions; refusal preserves the previous target until the caller chooses direct redraw. */
export class RegionColorTargets {
  private readonly targets = new Map<object, RegionColorTarget>();
  private readonly frames = new Map<object,RegionTargetFrames>();
  private readonly identities = new WeakMap<object, string>();
  private readonly ownerId = ++nextOwner;
  private nextIdentity = 0;
  private disposed = false;
  constructor(private readonly engine: IEngine) {}
  peek(token:object):RegionColorTarget|undefined {return this.targets.get(token);}
  additionalColorBytes(token:object,spec:RegionColorTargetSpec,replace=false):number {
    const current=this.targets.get(token);
    if(!replace&&current&&Object.keys(spec).every(k=>spec[k as keyof RegionColorTargetSpec]===current.spec[k as keyof RegionColorTargetSpec]))return 0;
    return spec.width*spec.height*(spec.format==='rgba16float'?8:4)*(spec.sampleCount===4?5:1);
  }
  acquire(token: object, label: string, spec: RegionColorTargetSpec, countRegion = true, replace = false,context?:RenderCommandContext): RegionColorTargetResult {
    if (this.disposed) throw new Error('Region target owner is disposed.');
    const current = this.targets.get(token);
    const compatible=!!current&&current.device===this.engine.device&&Object.keys(spec).every(k=>spec[k as keyof RegionColorTargetSpec]===current.spec[k as keyof RegionColorTargetSpec]);
    if (!replace && compatible) {
      if(context)return {accepted:true,target:current,resourceKey:this.frames.get(token)?.key??current.key};
      return {accepted:true,target:current};
    }
    let identity = this.identities.get(token);
    if (!identity) {identity = `${this.ownerId}:${++this.nextIdentity}:${label}`; this.identities.set(token,identity);}
    const attempt = RegionColorTarget.create(this.engine, identity, spec, countRegion);
    if (!attempt.accepted) return attempt;
    if(context){
      let frames=this.frames.get(token);
      if(!compatible){this.remove(token);frames=undefined;}
      if(!frames){frames={key:attempt.target.key,versions:new Set(current&&compatible?[current]:[]),pending:new Map(),committed:compatible&&current.valid?current:undefined};this.frames.set(token,frames);}
      frames.versions.add(attempt.target);this.targets.set(token,frames.committed??attempt.target);
      return this.frame(token,attempt.target,frames,context,compatible&&current.valid?current:undefined);
    }
    this.remove(token);this.targets.set(token, attempt.target);return attempt;
  }
  /** Publication follows the actual queue order, never the order of encoding. */
  written(token:object,context:RenderCommandContext):void {
    if(!this.frames.get(token)?.pending.has(context)){
      const target=this.targets.get(token);if(!target)throw Error('Region write has no acquired target.');
      this.frame(token,target,this.frames.get(token),context);
    }
    const record=this.frames.get(token)?.pending.get(context);
    if(!record)throw Error('Region write has no acquired frame generation.');
    record.write=true;
  }
  private frame(token:object,target:RegionColorTarget,frames:RegionTargetFrames|undefined,context:RenderCommandContext,history?:RegionColorTarget):RegionColorTargetResult {
    if(!frames){frames={key:target.key,versions:new Set([target]),pending:new Map(),committed:target.valid?target:undefined};this.frames.set(token,frames);}
    const selected=frames,previous=frames.pending.get(context);
    if(previous&&previous.target!==target)throw Error('One frame cannot acquire two versions of the same region.');
    if(!previous){
      const record={target,write:false};selected.pending.set(context,record);
      const release=(submitted:boolean)=>{
        if(!selected.pending.delete(context)||this.frames.get(token)!==selected)return;
        if(submitted&&record.write)selected.committed=target;
        const pendingTargets=new Set([...selected.pending.values()].map(r=>r.target));
        const current=selected.committed??selected.pending.values().next().value?.target;
        if(current)this.targets.set(token,current);else this.targets.delete(token);
        for(const version of selected.versions)if(version!==current&&!pendingTargets.has(version)){selected.versions.delete(version);version.retire();}
        if(!selected.versions.size)this.frames.delete(token);
      };
      context.afterSubmit!(()=>release(true));context.afterCancel!(()=>release(false));
    }
    return {accepted:true,target,resourceKey:selected.key,...history?{history}:{}};
  }
  remove(token: object): void {
    const target=this.targets.get(token),frames=this.frames.get(token);this.targets.delete(token);this.frames.delete(token);
    if(frames)for(const version of frames.versions)version.retire();else target?.retire();
  }
  dispose(abandon = false): void {
    if (this.disposed) return; this.disposed = true;
    const all=new Set([...this.targets.values(),...[...this.frames.values()].flatMap(frame=>[...frame.versions])]);
    for (const target of all) {if (abandon) target.abandon(); else target.retire();}
    this.targets.clear();this.frames.clear();
  }
}
interface RegionTargetFrames {
  readonly key:string;
  readonly versions:Set<RegionColorTarget>;
  readonly pending:Map<RenderCommandContext,{target:RegionColorTarget;write:boolean}>;
  committed:RegionColorTarget|undefined;
}
let nextOwner = 0;
