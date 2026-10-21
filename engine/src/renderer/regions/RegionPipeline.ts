import type {IEngine} from '../../core/IEngine';
import {createDeferredRenderFrameContext, type RenderFrameContext,type RenderFrameContextOptions} from '../../core/RenderCommandContext';
import {RenderView,getRenderViewPassOptions, type RenderViewSnapshot} from '../../core/RenderView';
import {getRenderRegionCollection,getRenderRegionState,type RenderRegionState,type RegionUpdatePlan,type RegionContentSnapshot} from '../../core/RenderRegionState';
import type {RenderRegion} from '../../core/RenderRegion';
import type {World} from '../../ecs/World';
import {SceneOutputPass} from '../../postprocess/SceneOutputPass';
import {RegionColorTargets,type RegionColorTarget,type RegionColorTargetSpec} from './RegionColorTarget';
import {physicalRegionBounds,physicalRegionRaster} from './RegionBounds';
import {getRegionCacheBudget} from './RegionCacheBudget';
import {planRegionStorage,type RegionStoragePlan,type RegionStorageCandidate} from './RegionStoragePlanner';
import {RegionFrameTargets} from './RegionFrameTargets';
import {getRegionAttachmentAccounting} from './RegionAttachmentAccounting';
import type {RegionPipelineEntry,RegionPipelineStats,RegionExecution} from './RegionExecution';
import type {ScissorRect} from '../../core/ViewportRect';
import type {WorldFrameToken} from '../../frame/FrameData';
import {SubmissionLifetime} from '../../rtt/SubmissionLifetime';
import {setPostProcessSubmission} from '../../postprocess/PostProcessSubmission';
import {setRegionProjection} from '../../core/RegionRenderTarget';
import {srgbToLinear} from '../../color/Color';
import {isLinearColorTarget} from '../../postprocess/SceneColor';
import {beginRegionComposition,regionReplacesParent} from '../../core/RegionComposition';
import {RegionHistoryCopy} from './RegionHistoryCopy';

interface Group {state:RenderRegionState;handle:RenderRegion;entries:RegionPipelineEntry[];interleaved:boolean;rect:Readonly<ScissorRect>;raster:Readonly<ScissorRect>;target?:RegionColorTarget;history?:RegionColorTarget;resourceKey?:string;cropped?:RegionColorTarget;plan:RegionUpdatePlan|null;view:RenderViewSnapshot;replaceSource?:boolean;replaceCrop?:boolean;}
type Preflight = {prepareFrame?(world:World,time:number,delta:number,view:RenderViewSnapshot,region:RenderRegion):void;releaseFrame?():void};

/** Regional execution owns scheduling/targets/composition; the existing pipeline retains producer ownership and profiling. */
export class RegionPipeline implements RegionExecution {
  private device:GPUDevice;
  private targets:RegionColorTargets;
  private working:RegionFrameTargets;
  private readonly cropTokens=new WeakMap<RenderRegionState,object>();
  private readonly directKeys=new WeakMap<RenderRegionState,string>();
  private readonly producerKeys=new WeakMap<RenderRegionState,string>();
  private presentation=0;
  private compositionSamples:0|1|4=0;
  private copy = new SceneOutputPass();
  private history:RegionHistoryCopy;
  private copyLifetime:SubmissionLifetime;
  private readonly known = new Set<RenderRegionState>();
  private readonly preflights=new Set<Preflight>();
  private signature = '';
  private frame = 0;
  stats:RegionPipelineStats = Object.freeze({updates:0,producerRecords:0,compositeDraws:0,presentations:0,cropCopies:0,compositionSamples:0,retainedColorBytes:0,workingColorBytes:0,workingRetiringColorBytes:0,regionDepthBytes:0,totalRegionAttachmentBytes:0,cachedRegions:0,fallbacks:[]});
  constructor(private readonly engine:IEngine) {this.device=engine.device;this.targets=new RegionColorTargets(engine);this.working=new RegionFrameTargets(engine);this.history=new RegionHistoryCopy(this.device);const copy=this.copy;this.copyLifetime=new SubmissionLifetime(this.device,()=>copy.destroy());}

  execute<T extends RegionPipelineEntry>(world:World,time:number,delta:number,options:RenderFrameContextOptions&{context?:RenderFrameContext;regionCache?:boolean;frameToken?:WorldFrameToken|undefined},entries:readonly T[],record:(entry:T,context:RenderFrameContext)=>void):RenderFrameContext {
    if(this.device!==this.engine.device){this.targets.dispose(true);this.working.dispose(true);this.copyLifetime.abandon();this.device=this.engine.device;this.targets=new RegionColorTargets(this.engine);this.working=new RegionFrameTargets(this.engine);this.copy=new SceneOutputPass();this.history=new RegionHistoryCopy(this.device);const copy=this.copy;this.copyLifetime=new SubmissionLifetime(this.device,()=>copy.destroy());this.signature='';this.known.clear()}
    const parent=options.view instanceof RenderView?options.view.snapshot():options.view??options.context?.view;
    if(!parent)throw Error('Regional rendering requires its owning RenderView.');
    if(entries.some(e=>!e.region))throw Error('A regional pipeline requires every producer to have an explicit region, including a global overlay region.');
    const registry=getRenderRegionCollection(parent);if(!registry)throw Error('RenderView has no owned region registry.');
    const context=options.context??createDeferredRenderFrameContext(this.engine,{...options,view:parent,frameData:options.frameData??world.frameData});
    if(context.frameData){if(options.frameToken!==undefined)context.frameData.useFrameToken(world,this.engine,options.frameToken);else context.frameData.begin(world,this.engine,time,delta)}
    if([parent.target.width,parent.target.height,parent.target.displayWidth,parent.target.displayHeight].some(n=>n===0)){
      const states=new Set(registry.states());
      for(const entry of entries){const state=getRenderRegionState(entry.region!);if(!state)throw Error('Unknown render region handle.');if(!state.isDisposed&&!states.has(state))throw Error('Render region belongs to a different view.');}
      this.signature='';this.compositionSamples=0;this.publish(0,0,0,0,[]);return context;
    }
    const currentStates=new Set(registry.states()),groups:Group[]=[],byState=new Map<RenderRegionState,Group>(),segments:{group:Group;entries:T[]}[]=[];
    const dx=parent.target.width/parent.target.displayWidth,dy=parent.target.height/parent.target.displayHeight;
    for(const entry of entries){
      const state=getRenderRegionState(entry.region!);if(!state)throw Error('Unknown render region handle.');if(state.isDisposed)continue;
      if(!currentStates.has(state))throw Error('Render region belongs to a different view.');
      let group=byState.get(state);
      if(!group){const snapshot=state.snapshot(),rect=physicalRegionBounds(snapshot.bounds,dx,parent.target.width,parent.target.height,dy);group={state,handle:entry.region!,entries:[],interleaved:false,rect,raster:physicalRegionRaster(snapshot.bounds,dx,dy),plan:null,view:parent};byState.set(state,group);groups.push(group)}
      if(segments.at(-1)?.group!==group){if(group.entries.length)group.interleaved=true;segments.push({group,entries:[]})}
      segments.at(-1)!.entries.push(entry);
      group.entries.push(entry);
    }
    // A whole-view ordered fallback also preserves producer recording order and
    // multisample transparent coverage, rather than pre-recording some segments.
    if(groups.some(g=>g.interleaved))for(const group of groups)group.interleaved=true;
    for(const group of groups){
      const key=group.entries.map(e=>e.id).join(','),previous=this.producerKeys.get(group.state);
      if(previous!==undefined&&previous!==key){this.targets.remove(group.state);const crop=this.cropTokens.get(group.state);if(crop)this.targets.remove(crop);this.directKeys.delete(group.state);group.handle.invalidate('Region producers changed');}
      this.producerKeys.set(group.state,key);
    }
    for(const state of this.known)if(!byState.has(state)){this.targets.remove(state);const crop=this.cropTokens.get(state);if(crop)this.targets.remove(crop);this.known.delete(state)}
    const systems=new Set(groups.flatMap(g=>g.entries.map(e=>e.system as Preflight)));
    for(const system of this.preflights)if(!systems.has(system)){system.releaseFrame?.();this.preflights.delete(system)}
    for(const system of systems)this.preflights.add(system);
    for(const group of groups){
      if(group.state.isDisposed)continue;
      this.known.add(group.state);const s=group.state.snapshot();
      const logicalWidth=s.bounds.width,logicalHeight=s.bounds.height;
      // Producer coordinates are local to the region. The compositor alone places it in the output.
      const logicalView=Object.freeze({...parent,displayWidth:logicalWidth,displayHeight:logicalHeight,width:group.rect.width,height:group.rect.height,viewport:null,scissor:null});
      for(const entry of group.entries)(entry.system as Preflight).prepareFrame?.(world,time,delta,logicalView,group.handle);
    }
    // Preflight may synchronously change bounds. Freeze geometry only after all producers finish preflight.
    for(const group of groups)if(!group.state.isDisposed){const b=group.state.snapshot().bounds;group.rect=physicalRegionBounds(b,dx,parent.target.width,parent.target.height,dy);group.raster=physicalRegionRaster(b,dx,dy)}
    const visible=groups.filter(g=>{if(g.state.isDisposed)return false;const s=g.state.snapshot();return s.visible&&g.rect.width>0&&g.rect.height>0});
    const fallbacks:string[]=[];let scratch:RegionColorTarget|undefined;
    // The complete-frame workspace is separate from retained pixel-cache admission (ADR 0133).
    const storage=this.storagePlan(parent,visible,dx,dy,options.regionCache!==false,context,!!options.context),sampleCount=storage.sampleCount;
    for(const group of visible)if(!storage.cached.has(group.state)){this.targets.remove(group.state);const crop=this.cropTokens.get(group.state);if(crop)this.targets.remove(crop);}
    scratch=this.working.acquire(this.compositionSpec(parent,sampleCount));
    this.compositionSamples=scratch.spec.sampleCount;
    for(const group of visible){
      const s=group.state.snapshot();
      const fits=[group.raster.width,group.raster.height].every(n=>Number.isSafeInteger(n)&&n>0&&n<=this.device.limits.maxTextureDimension2D);
      const allocated=!storage.cached.has(group.state)?{accepted:false as const,reason:storage.reasons.get(group.state)}:fits?this.targets.acquire(group.state,group.handle.id,this.sourceSpec(parent,group),true,group.replaceSource,context):{accepted:false as const,reason:'device-size'};
      if(allocated?.accepted){group.target=allocated.target;if(allocated.resourceKey)group.resourceKey=allocated.resourceKey;if(allocated.history)group.history=allocated.history;}
      else {this.targets.remove(group.state);fallbacks.push(`${group.handle.id}:${allocated?.reason??'direct-reference'}`)}
      const clipped=group.rect.width!==group.raster.width||group.rect.height!==group.raster.height;
      let cropToken=this.cropTokens.get(group.state);
      if(group.target&&clipped){
        if(!cropToken){cropToken={};this.cropTokens.set(group.state,cropToken)}
        const crop=this.targets.acquire(cropToken,`${group.handle.id}:visible-color`,{width:group.rect.width,height:group.rect.height,displayWidth:group.rect.width/dx,displayHeight:group.rect.height/dy,format:'rgba16float',sampleCount:1,depthConvention:parent.depthConvention,sceneColor:isLinearColorTarget(parent.target.format)?'radiance':'display'},false,group.replaceCrop);
        if(crop.accepted)group.cropped=crop.target;
        else{this.targets.remove(group.state);this.targets.remove(cropToken);delete group.target;fallbacks.push(`${group.handle.id}:crop-${crop.reason}`)}
      }else if(cropToken)this.targets.remove(cropToken);
      const previousDirect=this.directKeys.get(group.state),directPrefix=`direct:${scratch.key}:`;
      group.plan=group.state.prepare(group.resourceKey??group.target?.key??(previousDirect?.startsWith(directPrefix)?previousDirect:directPrefix+'initial'));
      group.view=regionView(parent,group.target??scratch,group.rect,s.bounds.width,s.bounds.height,!!group.target);
      if(group.target)group.view=Object.freeze({...group.view,loadOp:group.plan?.clear?'clear':'load',viewport:Object.freeze({x:s.bounds.x*dx-group.raster.x,y:s.bounds.y*dy-group.raster.y,width:s.bounds.width*dx,height:s.bounds.height*dy}),scissor:Object.freeze({x:0,y:0,width:group.target.width,height:group.target.height})});
    }
    if(scratch.spec.sampleCount!==parent.sampleCount&&visible.some(g=>!g.target))throw Error('Regional storage changed after the resolved composition plan; refusing an incompatible direct MSAA pass.');
    const outputInputs=[parent.target.key,parent.target.format,parent.target.width,parent.target.height,parent.sampleCount,parent.clearColor];
    const targetVersion=()=>parent.target.getRenderPassDescriptorVersion?.(getRenderViewPassOptions(parent))??null;
    const signature=JSON.stringify([...outputInputs,targetVersion(),entries.map(e=>e.id),visible.map(g=>[g.handle.id,g.rect,g.target?.key??'direct',g.state.snapshot().contentGeneration])]);
    const work=visible.some(g=>g.plan!==null)||signature!==this.signature;
    if(!work){this.publish(0,0,0,0,fallbacks);return context}
    // Direct storage is cleared for each actual presentation. Reconstruct it as a
    // fresh resource generation, while an idle frame keeps its already displayed image.
    const presentation=++this.presentation;
    for(const group of visible)if(!group.target){group.plan=group.state.prepare(`direct:${scratch.key}:${presentation}`);group.view=Object.freeze({...group.view,loadOp:group.plan?.clear?'clear':'load'});const b=group.state.snapshot().bounds;setRegionProjection(group.view,{x:b.x*dx,y:b.y*dy,width:b.width*dx,height:b.height*dy});}
    const updates=visible.filter(g=>g.plan!==null);
    this.copyLifetime.retain(context);this.copy.prepare(context.device);let records=0,draws=0,cropCopies=0;
    setPostProcessSubmission(this.copy,callback=>context.afterSubmit(callback),callback=>context.afterCancel(()=>{void context.device.queue.onSubmittedWorkDone().then(callback,callback)}));
    try{
      context.endPass();context.view=regionView(parent,scratch,{x:0,y:0,width:scratch.width,height:scratch.height},parent.displayWidth,parent.displayHeight,true);
      const clear=scratch.updateDescriptor(true);for(const color of clear.colorAttachments)if(color)color.clearValue=compositionClear(parent);
      context.beginPass(clear);context.endPass();scratch.encoded(context);
      const visibleSet=new Set(visible);
      for(const segment of segments){const {group}=segment;if(!visibleSet.has(group))continue;
        if(group.target){
          if(group.plan){
            if(group.history&&!group.plan.clear)this.history.copy(group.history,group.target,context);
            beginRegionComposition(group.target,context,group.plan.clear,group.history);
            const descriptor=group.target.updateDescriptor(group.plan.clear,context);context.view=group.view;context.descriptor=descriptor;context.loadOp=group.plan.clear?'clear':'load';
            context.beginPass(descriptor);context.endPass();
            if(group.plan.update)for(const entry of group.entries){this.recordProducer(entry,context,record as (e:RegionPipelineEntry,c:RenderFrameContext)=>void);records++}
            context.endPass();group.target.encoded(context);this.targets.written(group.state,context);const plan=group.plan;context.afterSubmit(()=>group.state.submitted(plan));
          }
          context.endPass();
          let source=group.target.sample(context);
          if(group.cropped){
            if(group.plan||!group.cropped.valid){context.encoder.copyTextureToTexture({texture:source,origin:[group.rect.x-group.raster.x,group.rect.y-group.raster.y,0]},{texture:group.cropped.copyDestination(context)},[group.rect.width,group.rect.height,1]);group.cropped.encoded(context);cropCopies++}
            source=group.cropped.sample(context);
          }
          this.copy.setFrameIdentity(++this.frame,`${parent.key}:region:${group.handle.id}`);
          const destination=Object.freeze({...parent,target:scratch,viewport:{...group.rect},scissor:{...group.rect},sampleCount:scratch.spec.sampleCount,format:'rgba16float',loadOp:regionReplacesParent(group.target,context)?'clear' as const:'load' as const});
          this.copy.configure('rgba16float',1,'none',destination);this.copy.apply(context.encoder,source,scratch.getOutputView(),context.device);draws++;
        }else{
          context.view=group.view;context.descriptor=scratch.updateDescriptor(false,context);context.loadOp='load';
          if(group.plan?.update)for(const entry of segment.entries){this.recordProducer(entry,context,record as (e:RegionPipelineEntry,c:RenderFrameContext)=>void);records++}
          context.endPass();
        }
      }
      for(const group of visible)if(!group.target&&group.plan){const plan=group.plan;context.afterSubmit(()=>{if(group.state.submitted(plan))this.directKeys.set(group.state,plan.resourceKey)});}
      context.endPass();context.view=parent;
      this.copy.setFrameIdentity(++this.frame,`${parent.key}:present`);this.copy.configure(parent.target.format,1,'none',Object.freeze({...parent,viewport:null,scissor:null,loadOp:'clear' as const}));
      this.copy.apply(context.encoder,scratch.sample(context),parent.target.getOutputView(),context.device);draws++;
      // Descriptor versions may advance when this presentation acquires its swapchain view.
      // Capture after encoding, before callers can replace an unsubmitted destination.
      const recordedTargetVersion=targetVersion();
      context.afterSubmit(()=>{this.signature=visible.some(g=>g.state.isDisposed)?'':JSON.stringify([...outputInputs,recordedTargetVersion,entries.map(e=>e.id),visible.map(g=>[g.handle.id,g.rect,g.target?.key??'direct',g.state.snapshot().contentGeneration])])});
      if(!options.context)context.submit();this.publish(updates.length,records,draws,1,fallbacks,cropCopies);return context;
    }catch(error){context.cancel();throw error}
    finally{setPostProcessSubmission(this.copy);context.endPass();context.view=parent}
  }
  private compositionSpec(parent:RenderViewSnapshot,sampleCount:1|4):RegionColorTargetSpec {return{width:parent.target.width,height:parent.target.height,displayWidth:parent.target.displayWidth,displayHeight:parent.target.displayHeight,format:'rgba16float',sampleCount,depthConvention:parent.depthConvention,sceneColor:isLinearColorTarget(parent.target.format)?'radiance':'display'};}
  private sourceSpec(parent:RenderViewSnapshot,group:Group):RegionColorTargetSpec {const b=group.state.snapshot().bounds;return{width:group.raster.width,height:group.raster.height,displayWidth:b.width,displayHeight:b.height,format:'rgba16float',sampleCount:parent.sampleCount,depthConvention:parent.depthConvention,sceneColor:isLinearColorTarget(parent.target.format)?'radiance':'display'};}
  private storagePlan(parent:RenderViewSnapshot,groups:readonly Group[],dx:number,dy:number,cache:boolean,context:RenderFrameContext,deferred:boolean):RegionStoragePlan {
    const candidates:RegionStorageCandidate[]=groups.map(group=>{
      const state=group.state.snapshot(),update=regionWillUpdate(state),clear=!state.initialized||(update&&state.clearMode==='on-update');
      // An externally held history writer must not mutate the only committed
      // seed: a later encoder may still freeze that same seed before submission.
      group.replaceSource=(update||clear)&&(!!this.targets.peek(group.state)?.hasPendingOther(context)||deferred&&state.initialized&&!clear);
      const source=this.sourceSpec(parent,group),base={replace:group.replaceSource,token:group.state,rect:group.rect,source,interleaved:group.interleaved,continuous:group.state.snapshot().updateMode==='continuous'};
      if(group.rect.width===group.raster.width&&group.rect.height===group.raster.height)return base;
      let token=this.cropTokens.get(group.state);if(!token){token={};this.cropTokens.set(group.state,token)}
      group.replaceCrop=(update||clear||!this.targets.peek(token)?.valid)&&!!this.targets.peek(token)?.hasPendingOther(context);
      return{...base,crop:{token,replace:group.replaceCrop,spec:{width:group.rect.width,height:group.rect.height,displayWidth:group.rect.width/dx,displayHeight:group.rect.height/dy,format:'rgba16float',sampleCount:1,depthConvention:parent.depthConvention,sceneColor:isLinearColorTarget(parent.target.format)?'radiance':'display'}}};
    });
    return planRegionStorage(this.device,this.targets,candidates,parent.sampleCount,cache);
  }
  private recordProducer(entry:RegionPipelineEntry,context:RenderFrameContext,record:(entry:RegionPipelineEntry,context:RenderFrameContext)=>void):void {
    context.endPass();if(entry.type==='render'){
      // A prior producer may have omitted depth or replaced its descriptor.
      // Reconstruct this producer's attachments from the regional owner.
      const view=context.view!;
      const descriptor=view.target.getRenderPassDescriptor(getRenderViewPassOptions(view));
      const next={...descriptor,colorAttachments:Array.from(descriptor.colorAttachments,c=>c?{...c,loadOp:'load' as const}:null)};
      if(next.depthStencilAttachment)next.depthStencilAttachment={...next.depthStencilAttachment,depthLoadOp:entry.depthLoadOp??'load',depthStoreOp:entry.depthStoreOp??'store'};
      if(!entry.depth)delete next.depthStencilAttachment;
      context.descriptor=next;context.loadOp='load';
      if(entry.pass==='shared')context.beginPass(context.descriptor,'load');const viewport=context.view?.viewport;
      if(viewport&&context.passEncoder)context.passEncoder.setViewport(viewport.x,viewport.y,viewport.width,viewport.height,0,1);
      const scissor=context.view?.scissor;if(scissor&&context.passEncoder)context.passEncoder.setScissorRect(scissor.x,scissor.y,scissor.width,scissor.height);
    }
    record(entry,context);
  }
  private publish(updates:number,producerRecords:number,compositeDraws:number,presentations:number,fallbacks:string[],cropCopies=0):void {
    const budget=getRegionCacheBudget(this.device).snapshot();this.stats=Object.freeze({updates,producerRecords,compositeDraws,presentations,cropCopies,compositionSamples:this.compositionSamples,...getRegionAttachmentAccounting(this.device).snapshot(),retainedColorBytes:budget.retainedBytes,cachedRegions:budget.retainedRegions,fallbacks:Object.freeze(fallbacks)});
  }
  destroy(abandon=false):void {for(const system of this.preflights)system.releaseFrame?.();this.preflights.clear();this.targets.dispose(abandon);this.working.dispose(abandon);if(abandon)this.copyLifetime.abandon();else this.copyLifetime.retire();this.known.clear();this.signature='';}
}

function regionView(parent:RenderViewSnapshot,target:RegionColorTarget,rect:Readonly<ScissorRect>,logicalWidth:number,logicalHeight:number,local:boolean):RenderViewSnapshot {
  return Object.freeze({...parent,target,key:`${parent.key}:${target.key}:${local?'local':rect.x+','+rect.y}`,width:local?target.width:rect.width,height:local?target.height:rect.height,displayWidth:logicalWidth,displayHeight:logicalHeight,sampleCount:target.spec.sampleCount,viewport:local?null:{...rect},scissor:local?null:{...rect},loadOp:'load' as const});
}
function compositionClear(parent:RenderViewSnapshot):GPUColorDict {
  const color=parent.clearColor,format=parent.target.format;
  if(isLinearColorTarget(format)||format.endsWith('-srgb'))return {...color};
  // Invert the final premultiplied display transfer, preserving normal UNORM
  // attachment clear values, including additive (zero-alpha) clear colors.
  const alpha=Math.max(0,Math.min(1,color.a)),coverage=alpha===0?1:alpha;
  return {r:srgbToLinear(color.r/coverage)*coverage,g:srgbToLinear(color.g/coverage)*coverage,b:srgbToLinear(color.b/coverage)*coverage,a:alpha};
}

function regionWillUpdate(state:RegionContentSnapshot):boolean {return state.updateMode!=='disabled'&&(!state.initialized||state.pendingOnce||state.updateMode==='continuous'||state.updateMode==='demand'&&state.dirty);}
