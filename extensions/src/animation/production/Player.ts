import {GuiRoot} from '@haiyue/engine/gui';
import {ProductionCompositionGuiBridge} from './CompositionGuiBridge.js';
import type {HyaPlayer,HyaPlayerOptions,HyaFrame,HyaFrameRequest,HyaDiagnostic} from '@haiyue/extensions/hya-player';
import type {HyaSemanticSnapshot} from '@haiyue/extensions/hya-data';
import type {HyaLayoutFrame} from '@haiyue/extensions/hya-layout';
import type {ProductionLayoutFrame} from '../layout/production/types.js';
import {layoutRectBounds} from '../layout/production/ProductionLayoutGeometry.js';
import {Component,ComponentLifecycleFlags,Entity,World} from '@haiyue/engine/ecs';
import {Camera2D,Transform2D} from '@haiyue/engine/components';
import {getSceneRenderPipeline} from '@haiyue/engine/experimental';
import {ProductionCompositionOwner,type ProductionCompositionDefinition,type ProductionCompositionFrame} from './CompositionOwner.js';
import {compileProductionSource,type ProductionSourcePorts} from './SourceComposition.js';
import {ProductionPlayerTransport} from './PlayerTransport.js';
import {ProductionFrameError,snapshotProductionFrameRequest,type PreparedProductionFrameStep} from './FrameTransaction.js';
import {ProductionCompositionDrawAdapter} from './CompositionDrawAdapter.js';
import {ProductionCoreCompositionVisual} from './CoreCompositionVisual.js';
import {ProductionCoreCompositionEvaluation} from './CoreCompositionEvaluation.js';
import {ProductionCoreStateVisualRuntime} from './ProductionCoreStateVisualRuntime.js';
import {ProductionCoreAssetOwner} from './ProductionCoreAssetOwner.js';
import {ProductionDrawOwner} from '../layout/production/ProductionDrawOwner.js';
import {ProductionTextureOwner} from '../layout/production/ProductionTextureOwner.js';
import {LayoutAssetOwner} from '../layout/parameterized/AssetOwner.js';
import {createProductionOutlineFontPort} from '../text/production/ProductionOutlineFontPort.js';
import {createLayoutResourceRoute,createCoreResourceRoute,resourceBytes} from './PlayerResources.js';
import type {ProductionCompositionSemanticsOwner} from './CompositionSemanticsOwner.js';
import {snapshotPlainTextData} from '../text/PlainTextData.js';
import type {HyaCompositionValue} from '@haiyue/animation-spec/hya-production';
import {safeExpressionDataResources,type AnimationText2DComponent} from '@haiyue/animation-spec';
import {ProductionCoreEvaluationAssets} from './CoreEvaluationAssets.js';
import type {RuntimeValue as StateValue,DeterministicInvocationPort} from '../../hya-state-machine/v2/runtime-types.js';
import type {RuntimeLayoutDocument} from '../layout/parameterized/runtime-types.js';

type Part=ProductionCompositionDefinition['parts'][number];
const conditionAdapters=new WeakMap<object,DeterministicInvocationPort & {protocols:ReadonlySet<string>}>();
const actionAdapters=new WeakMap<object,NonNullable<Extract<Part,{kind:'interaction'}>['actions']>>();
let nextPlayer=0;
class PlayerAnchor extends Component {
 static override Lifecycle=ComponentLifecycleFlags.EntityRemoveComponent|ComponentLifecycleFlags.EntityRemoveFromWorld;
 constructor(private readonly release:()=>void){super('HYA player lifecycle');}
 override destroy():void{if(this.destroyed)return;try{this.release();}finally{super.destroy();}}
 onEntityRemoveComponent(_entity:Entity,component:Component):void{if(component===this)this.release();}
 onEntityRemoveFromWorld():void{this.release();}
}
const defaults=Object.freeze({maxTextureBytes:1024*1024*1024,maxBitmapBytes:1024*1024*1024,maxEntries:250_000,maxConcurrent:1});
/** Planned facade, exercised as an actual private package until G13 admits its public exports/declarations. */
export async function createHyaPlayer(source:unknown,options:HyaPlayerOptions):Promise<HyaPlayer>{
 if(options?.signal?.aborted)fail('E_HYA_RUNTIME_ABORTED','$options.signal','player creation was cancelled');
 const initial=snapshotProductionFrameRequest({sequence:0,deltaSeconds:0,viewport:options?.viewport,dpr:options?.dpr??1});
 const host=options?.host;if(!host||typeof host.invalidate!=='function')fail('E_HYA_RUNTIME_HOST_PORT','$options.host','player invalidation host is required');
 if(!['render','evaluate'].includes(options.mode))fail('E_HYA_RUNTIME_HOST_PORT','$options.mode','select an explicit player mode');
 const scene=options.scene;
 if(options.mode==='render'&&(!scene||scene.world.destroyed||['destroying','destroyed'].includes(scene.state)))fail('E_HYA_RUNTIME_HOST_PORT','$options.scene','render mode requires a live public Scene');
 if(options.region&&options.mode!=='render')fail('E_HYA_RUNTIME_HOST_PORT','$options.region','regional drawing requires render mode');
 if((options.gui||options.root)&&options.mode!=='render')fail('E_HYA_RUNTIME_HOST_PORT','$options.gui','GUI integration requires render mode');
 if(options.gui&&scene?.guiSystem!==options.gui)fail('E_HYA_RUNTIME_HOST_PORT','$options.gui','GUI must be the existing Scene GUI owner');
 if(options.root&&!scene?.guiSystem)fail('E_HYA_RUNTIME_HOST_PORT','$options.root','a borrowed root requires the existing Scene GUI owner');
 const imagePort=host.images;
 if(imagePort!==undefined&&(!imagePort||typeof imagePort.decode!=='function'||typeof imagePort.snapshot!=='function'))fail('E_HYA_RUNTIME_HOST_PORT','$options.host.images','image host requires decode and snapshot');
 const imageHost=imagePort?Object.freeze({decode:imagePort.decode.bind(imagePort),snapshot:imagePort.snapshot.bind(imagePort)}):undefined;
 if(!Number.isSafeInteger(nextPlayer+1))fail('E_HYA_RUNTIME_LIMIT','$.generation','player identity exhausted');
 const identity=++nextPlayer,controller=new AbortController(),signal=controller.signal,cleanups:(()=>void)[]=[],assets=new Map<string,LayoutAssetOwner>(),semanticActions=new Map<string,(node:string,action:string)=>void>();
 let guiBridge:ProductionCompositionGuiBridge|undefined;
 let drawGeneration=0;
 let owner:ProductionCompositionOwner|undefined,transport:ProductionPlayerTransport|undefined,draw:ProductionDrawOwner|undefined,textures:ProductionTextureOwner|undefined,adapter:ProductionCompositionDrawAdapter|undefined,anchor:Entity|undefined,disposed=false,last:HyaFrame|null=null,layoutKey='',layoutRevision=0,semanticKey='',semanticRevision=0;
 let committedLayouts:readonly ProductionCompositionFrame['layouts'][string][]=[],committedSemantics:ProductionCompositionFrame['semantics']={};
 let parts:readonly Part[]=[],plan:ReturnType<typeof compileProductionSource>['plan'],frameViewport=initial.viewport,frameDpr=initial.dpr;
 let stagedViewport:Readonly<{viewport:readonly[number,number];dpr:number}>|undefined;
 const observedReady=new WeakSet<Promise<unknown>>();
 const diagnostics:HyaDiagnostic[]=[];
 const report=(error:unknown)=>{const e=error as {code?:string;path?:string;capability?:string;message?:string};const diagnostic=Object.freeze({code:e?.code??'E_HYA_RUNTIME_HOST_PORT',path:e?.path??'$.player',capability:e?.capability??'org.haiyue.composition@1',message:e?.message??String(error)});diagnostics.push(diagnostic);if(diagnostics.length>16)diagnostics.shift();try{host.diagnostic?.(diagnostic);}catch{}};
 const invalidate=(reason:string)=>{if(!disposed){try{host.invalidate(reason);}catch(error){report(error);}}};
 const live=()=>{if(disposed||signal.aborted||scene?.world.destroyed)fail(signal.aborted?'E_HYA_RUNTIME_ABORTED':'E_HYA_RUNTIME_DISPOSED','$.player','player is not active');};
 const release=(cleanup:()=>void)=>{try{cleanup();}catch(error){report(error);}};
 const own=(cleanup:()=>void)=>{if(disposed)release(cleanup);else cleanups.push(cleanup);};
 const dispose=()=>{if(disposed)return;disposed=true;controller.abort();for(const cleanup of cleanups.splice(0).reverse())release(cleanup);last=null;};
 const abort=()=>dispose();options.signal?.addEventListener('abort',abort,{once:true});own(()=>options.signal?.removeEventListener('abort',abort));
 const defaultMap=<K extends keyof ProductionSourcePorts>(value:NonNullable<ProductionSourcePorts[K]> extends {get(id:string):infer V}?Exclude<V,undefined>:never)=>({get:()=>value} as unknown as NonNullable<ProductionSourcePorts[K]>);
 const semanticBridge=(part:string)=>({update(){},subscribeActions(callback:(node:string,action:string)=>void){semanticActions.set(part,callback);return{unsubscribe(){semanticActions.delete(part);}};}});
 const materialize:NonNullable<Extract<Part,{kind:'core'}>['materialize']>=(animation,channels,id)=>{
  live();if(options.mode==='evaluate'){
   const ids=new Set(animation.nodes.flatMap(n=>(n.components??[]).flatMap(c=>{if(c.type!=='text2d')return[];const text=c as AnimationText2DComponent;return[...(text.expression?[...safeExpressionDataResources(text.expression)]:[]),...(text.fontResource?[text.fontResource]:[]),...(text.documents??[]).flatMap(d=>d.fontResource?[d.fontResource]:[]),...(text.styleRuns??[]).flatMap(run=>run.fontResource?[run.fontResource]:[])];}))),needed=animation.resources.filter(r=>ids.has(r.id));
   if(needed.length&&typeof host.resources?.acquire!=='function')fail('E_HYA_RUNTIME_HOST_PORT','$.parts.'+id+'.resources','CPU font/expression bytes require the host resource port');
   const route=createCoreResourceRoute(id,needed,host.resources),resources=new ProductionCoreEvaluationAssets(needed,route);
   return new ProductionCoreCompositionEvaluation(animation,channels,resources,()=>resources.dispose(),()=>invalidate('core-resource'));
  }
  if(!scene)fail('E_HYA_RUNTIME_HOST_PORT','$.parts.'+id,'render core requires the live Scene');
  const route=createCoreResourceRoute(id,animation.resources,host.resources),resources=new ProductionCoreAssetOwner(animation.resources,scene.engine,{...route,textures:{...defaults,...(imageHost?{host:imageHost}:{}),invalidate,diagnostic:report}});
  const world=new World('HYA source '+identity+':'+id),root=new Entity('HYA source root').addComponent(new Transform2D()),camera=new Entity('HYA source camera').addComponent(new Camera2D({width:animation.canvas.width,height:animation.canvas.height,designWidth:animation.canvas.width,designHeight:animation.canvas.height,viewportMode:'fixed'}));
  world.addEntity(camera);world.addEntity(root);
  let runtime:ProductionCoreStateVisualRuntime;
  try{runtime=new ProductionCoreStateVisualRuntime(root,animation,channels,undefined,scene.engine.assetManager,resources);}catch(error){resources.dispose();world.destroy();throw error;}
  runtime.setCoreResourceInvalidation(()=>invalidate('core-resource'));
  const engine=new Proxy(scene.engine,{get(target,key){if(key==='displayWidth'||key==='width')return frameViewport[0]*frameDpr;if(key==='displayHeight'||key==='height')return frameViewport[1]*frameDpr;return Reflect.get(target,key,target);}});
  return new ProductionCoreCompositionVisual(runtime,world,camera,engine,{maxGeometryBytes:512*1024*1024,textures:textures!,image:visual=>resources.acquireImage(visual)},()=>{runtime.destroy();resources.dispose();world.destroy();});
 };
 try{
  const audio=host.audio;
  const condition=host.conditions;let conditions=condition&&conditionAdapters.get(condition);
  if(condition&&!conditions){conditions={protocols:condition.protocols,begin:id=>condition.begin(id),commit:id=>condition.commit(id),rollback:id=>condition.rollback(id),invoke:r=>stateValue(condition.invoke({...r,arguments:plain(r.arguments) as Readonly<Record<string,HyaCompositionValue>>}))};conditionAdapters.set(condition,conditions);}

  const ports:ProductionSourcePorts={capabilities:host.capabilities,core:defaultMap<'core'>({materialize}),data:defaultMap<'data'>({options:host.converter?{converter:host.converter}:{} }),state:defaultMap<'state'>({...conditions?{conditions}:{}}),interaction:defaultMap<'interaction'>({...host.geometry?{geometry:host.geometry}:{}}),semantics:{get:id=>({bridge:semanticBridge(id),bounds:(target,layouts)=>bounds(target,layouts,parts,plan.targets)})},audio:{get:id=>audio?{host:{get profile(){return audio!.profile;},get sampleRate(){return audio!.sampleRate;},get state(){return audio!.state;},nowFrame:()=>audio!.nowFrame(),unlock:()=>audio!.unlock(),decode:(r,s,b)=>audio!.decode(r,s,b),schedule:r=>audio!.schedule(r),resolve:(r,s)=>host.resources?resourceBytes(host.resources,{kind:'audio',part:id,asset:r.id,integrity:'sha256-'+hexBase64(r.integrity.digest),signal:s}):audio!.resolve?audio!.resolve(r,s):Promise.reject(new ProductionFrameError('E_HYA_RUNTIME_HOST_PORT','$.audio.resources','audio external resources require a resolver'))}}:undefined}};
  const compiled=compileProductionSource(source,ports,options.parse);plan=compiled.plan;
  if(options.mode==='evaluate')for(const part of compiled.definition.parts)if(part.kind==='core'){
   const partIndex=compiled.plan.document.parts.findIndex(source=>source.id===part.id);
   for(const [nodeIndex,node]of part.document.nodes.entries())for(const [componentIndex,component]of (node.components??[]).entries())if(component.type==='text2d')preflightCoreCpuFont(component as AnimationText2DComponent,'$.parts['+partIndex+'].document.nodes['+nodeIndex+'].components['+componentIndex+']');
  }
  // Keep the outline-only/evaluation path free of native font services. Full
  // admitted gradient paints use the original native font port when rendering.
  const nativeFonts=!host.fonts&&options.mode==='render'&&typeof globalThis.FontFace==='function'&&!!globalThis.document?.fonts&&typeof globalThis.document?.createElement==='function'&&compiled.definition.parts.some(part=>part.kind==='layout'&&part.document.textBlocks.length>0&&part.document.textStyles.some(style=>[...style.fills,...(style.strokes??[])].some(paint=>paint.source.kind!=='solid')))
   ?await import('../text/production/ProductionBrowserFontPort.js'):undefined;
  live();
  for(const part of compiled.definition.parts)if(part.kind==='layout'){
   const route=createLayoutResourceRoute(part.id,part.document,host.resources),asset=new LayoutAssetOwner(route.document,route.options);assets.set(part.id,asset);own(()=>asset.dispose());
  }
  parts=Object.freeze(compiled.definition.parts.map(part=>{
   if(part.kind==='layout'){const asset=assets.get(part.id)!;return Object.freeze({...part,document:asset.document,assetOptions:createLayoutResourceRoute(part.id,part.document,host.resources).options,assetOwner:asset,fonts:host.fonts??(nativeFonts?nativeFonts.createProductionBrowserFontPort(asset,{maxBitmapBytes:defaults.maxBitmapBytes}):createProductionOutlineFontPort(asset))});}
   if(part.kind==='interaction'&&host.actions){const hostActions=host.actions;let actions=actionAdapters.get(hostActions);if(!actions){actions={begin:id=>hostActions.begin(id),invoke:(action,event)=>hostActions.invoke(action,event),commit:id=>hostActions.commit(id),rollback:id=>hostActions.rollback(id),kinds:new Set(),protocols:new Set()};actionAdapters.set(hostActions,actions);}for(const action of part.document.listeners.flatMap(l=>l.actions)){(actions.kinds as Set<string>).add(action.kind);if(typeof action.protocol==='string')(actions.protocols as Set<string>).add(action.protocol);}return Object.freeze({...part,actions});}
   return part;
  }));
  if(scene){anchor=new Entity('HYA player '+identity).addComponent(new PlayerAnchor(dispose));own(()=>anchor!.destroy());scene.add(anchor);}
  live();
  const visualParts=parts.filter((part):part is Extract<Part,{kind:'core'|'layout'}>=>part.kind==='core'||part.kind==='layout');
  if(options.mode==='render'&&scene&&visualParts.length){
   textures=new ProductionTextureOwner(scene.engine,assets,{...defaults,...(imageHost?{host:imageHost}:{}),invalidate,diagnostic:report});own(()=>textures!.dispose());draw=new ProductionDrawOwner(scene.engine,textures,{diagnostic:report});own(()=>draw!.dispose());adapter=new ProductionCompositionDrawAdapter(draw,visualParts.map(({id,kind})=>({id,kind})),textures);
  }
  const merge=(frame:ProductionCompositionFrame):Readonly<{value:HyaFrame;nextLayoutKey:string;nextSemanticKey:string;viewport:readonly[number,number];dpr:number}>=>{
   const {viewport,dpr}=stagedViewport??{viewport:frameViewport,dpr:frameDpr};
   const layouts=Object.values(frame.layouts),nodes=layouts.flatMap(f=>f.nodes),instances=layouts.flatMap(f=>f.instances),nextLayoutKey=layouts.length===committedLayouts.length&&layouts.every((f,i)=>f.nodes===committedLayouts[i]!.nodes)&&last?.layout?.dpr===dpr&&last?.layout?.viewport.every((n,i)=>n===viewport[i])?layoutKey:JSON.stringify([viewport,dpr,nodes]),nextSemanticKey=Object.keys(frame.semantics).length===Object.keys(committedSemantics).length&&Object.entries(frame.semantics).every(([id,s])=>committedSemantics[id]===s)?semanticKey:JSON.stringify(Object.entries(frame.semantics).map(([part,s])=>[part,s.nodes,s.readingOrder,s.navigationOrder]));
   const layoutChanged=nextLayoutKey!==layoutKey,semChanged=nextSemanticKey!==semanticKey;
   const layout:HyaLayoutFrame|null=layouts.length?Object.freeze({revision:layoutRevision+Number(layoutChanged),viewport:viewport,dpr:dpr,nodes:!layoutChanged&&last?.layout?last.layout.nodes:Object.freeze(nodes),instances:Object.freeze(instances)}):null;
   const snapshots=Object.entries(frame.semantics),semanticId=(part:string,id:string)=>JSON.stringify([part,id]);
   const semantics:HyaSemanticSnapshot|null=snapshots.length?Object.freeze({revision:semanticRevision+Number(semChanged),nodes:Object.freeze(snapshots.flatMap(([part,s])=>s.nodes.map(node=>Object.freeze({...node,id:semanticId(part,node.id),...(node.parent?{parent:semanticId(part,node.parent)}:{})})))),readingOrder:Object.freeze(snapshots.flatMap(([part,s])=>s.readingOrder.map(id=>semanticId(part,id)))),navigationOrder:Object.freeze(snapshots.flatMap(([part,s])=>s.navigationOrder.map(id=>semanticId(part,id)))),announcements:Object.freeze(snapshots.flatMap(([part,s])=>s.announcements.map(a=>Object.freeze({...a,node:semanticId(part,a.node)}))))}) as HyaSemanticSnapshot:null;
   const events:HyaFrame['events']=Object.freeze([...frame.effects.map(({part,machine,effect})=>Object.freeze({id:JSON.stringify([identity,effect.id]),part,instance:machine,time:effect.occurrenceTime,sequence:frame.sequence,kind:effect.channel.effectKind??'event',target:effect.channel.target,payload:plain(effect.payload)})),...frame.input.events.map(e=>Object.freeze({id:JSON.stringify([identity,e.id]),part:e.part,instance:e.target,time:frame.time,sequence:frame.sequence,kind:e.name,target:e.target,payload:e.payload}))]);
   const geometry=layoutChanged||!last||JSON.stringify(frame.cores)!==JSON.stringify(owner?.lastFrame?.cores??{});
   return Object.freeze({value:Object.freeze({sequence:frame.sequence,generation:identity,time:frame.time,ready:true,diagnostics:Object.freeze([...diagnostics,...plan.diagnostics.map(d=>Object.freeze({...d,message:'optional source capability was skipped'}))]),changed:Object.freeze({layout:layoutChanged,geometry,presentation:geometry}),layout,semantics,events}),nextLayoutKey,nextSemanticKey,viewport,dpr});
  };
  owner=await ProductionCompositionOwner.create({parts,targets:compiled.definition.targets},{guiText:options.mode==='render'&&!!scene?.guiSystem,invalidate,diagnostic:report,presentation:(frame,texts)=>guiBridge?.present(frame,texts,stagedViewport?.viewport??frameViewport)??frame,draw:(frame,cores)=>{
   live();const step=adapter?.prepare(frame,cores),pending=merge(frame);return{commit(){step?.commit();},rollback(){step?.rollback();},finalize(){step?.finalize?.();layoutRevision=pending.value.layout?.revision??layoutRevision;semanticRevision=pending.value.semantics?.revision??semanticRevision;layoutKey=pending.nextLayoutKey;semanticKey=pending.nextSemanticKey;frameViewport=pending.viewport;frameDpr=pending.dpr;last=pending.value;committedLayouts=Object.values(frame.layouts);committedSemantics=frame.semantics;},publish(){step?.publish?.();try{guiBridge?.sync(frame.input.focused);}catch(error){report(error);}if(pending.value.semantics&&pending.nextSemanticKey!==previousSemanticKey){previousSemanticKey=pending.nextSemanticKey;try{host.semantics?.update(pending.value.semantics);}catch(error){report(error);}}if(!disposed&&pending.value.events.length){try{host.events?.(pending.value.events);}catch(error){report(error);}}}};
  }},signal);own(()=>owner!.dispose());live();
  if(options.mode==='render'&&scene?.guiSystem&&(owner.guiTargets.length||owner.hasGuiText)){
   const gui=options.gui??scene.guiSystem;for(const part of parts)if(part.kind==='interaction')for(const listener of part.document.listeners)if(listener.event==='gamepad'&&!gui.hasGamepadInput)fail('E_HYA_RUNTIME_HOST_PORT','$.parts.'+part.id+'.listeners.'+listener.id,'physical gamepad listeners require an attached existing GUI sampler');
   const root=options.root??new GuiRoot({id:'hya-player-root-'+identity});
   if(!options.root){const entity=new Entity('HYA GUI root '+identity).addComponent(root);own(()=>entity.destroy());scene.add(entity);live();}
   guiBridge=new ProductionCompositionGuiBridge(owner,gui,root,()=>frameViewport);own(()=>guiBridge!.dispose());
  }
  let previousSemanticKey='';
  transport=new ProductionPlayerTransport(owner,frameViewport,frameDpr);
  if(host.semantics){const subscription=host.semantics.subscribeActions((node,action)=>{if(disposed)return;try{const address:unknown=JSON.parse(node);if(!Array.isArray(address)||address.length!==2||address.some(v=>typeof v!=='string')||!last?.semantics?.nodes.some(n=>n.id===node))fail('E_HYA_RUNTIME_SEMANTICS','$.semantics.action','host action does not address a committed Player node');const [part,id]=address as [string,string],callback=semanticActions.get(part);if(!callback)fail('E_HYA_RUNTIME_SEMANTICS','$.semantics.action','semantic owner is absent');callback(id,action);}catch(error){report(error);}});own(()=>subscription.unsubscribe());live();}
  if(draw&&scene){const pipeline=getSceneRenderPipeline(scene);own(()=>{pipeline.remove(draw!);options.region?.invalidate('HYA producer disposed');});pipeline.add(draw,{...draw.renderPipelineOptions,...(options.region?{region:options.region,depth:false}:{})});live();}
  const runFrame=(action:()=>unknown,allowPending=false,request?:Readonly<{viewport:readonly[number,number];dpr:number}>):HyaFrame=>{live();const previous=stagedViewport;stagedViewport=request;try{action();live();if(!last)fail('E_HYA_RUNTIME_FRAME','$.player.frame','the original owner did not commit a public frame');if(options.region&&draw&&drawGeneration!==draw.stats.generation){options.region.invalidate('HYA committed paint changed');drawGeneration=draw.stats.generation;}return last;}catch(error){const ready=(error as {ready?:unknown})?.ready;if(allowPending&&ready instanceof Promise){if(!observedReady.has(ready)){observedReady.add(ready);void ready.then(()=>invalidate('resource-ready'),error=>{if(!disposed)report(error);});}const fallback=last;return Object.freeze({sequence:fallback?.sequence??0,generation:identity,time:fallback?.time??0,ready:false,diagnostics:Object.freeze([...diagnostics]),changed:Object.freeze({layout:false,geometry:false,presentation:false}),layout:fallback?.layout??null,semantics:fallback?.semantics??null,events:Object.freeze([])});}report(error);throw error;}finally{stagedViewport=previous;}};
  const data=parts.some(p=>p.kind==='data')?Object.freeze({read:owner.read.bind(owner),readBinding:owner.readBinding.bind(owner),run:owner.run.bind(owner),subscribe:owner.subscribe.bind(owner) as NonNullable<HyaPlayer['data']>['subscribe'],rebind:owner.rebind.bind(owner),replaceResource:owner.replaceResource.bind(owner)}):null;
  const player:HyaPlayer=Object.freeze({get status(){return disposed?'disposed':transport!.status;},document:plan.document,data,get lastFrame(){return last;},advance(request:HyaFrameRequest){const r=snapshotProductionFrameRequest(request);return runFrame(()=>transport!.advance(r),true,r);},seek(time:number){return runFrame(()=>transport!.seek(time));},setRate(rate:number){runFrame(()=>transport!.setRate(rate));},play(){runFrame(()=>transport!.play());},pause(){runFrame(()=>transport!.pause());},resume(){runFrame(()=>transport!.resume());},stop(){runFrame(()=>transport!.stop());},unlockAudio(){live();return transport!.unlockAudio();},dispose});
  live();return player;
 }catch(error){dispose();throw error;}
}
function fail(code:string,path:string,message:string):never{throw new ProductionFrameError(code,path,message);}
function hexBase64(hex:string):string{const bytes=new Uint8Array(hex.match(/../gu)!.map(s=>parseInt(s,16)));let text='';for(const byte of bytes)text+=String.fromCharCode(byte);return btoa(text);}
function stateValue(value:unknown):StateValue{const result=plain(value);if(Array.isArray(result)&&result.some(v=>typeof v!=='number'))fail('E_HYA_RUNTIME_HOST_PORT','$options.host.conditions','the original state profile accepts only numeric vector arrays');return result as StateValue;}
function plain(value:unknown):HyaCompositionValue{return snapshotPlainTextData(value,'$.player.value',(path,message)=>fail('E_HYA_RUNTIME_FRAME',path,message),{strict:true,maxBytes:64*1024*1024}) as HyaCompositionValue;}
function bounds(target:string,layouts:Readonly<Record<string,ProductionLayoutFrame>>,parts:readonly Part[],targets:ProductionCompositionDefinition['targets']):readonly[number,number,number,number]|undefined{
 const alias=targets.find(t=>t.id===target);if(!alias)return undefined;
 if(alias.kind==='layout-node'){const matches=layouts[alias.part]?.nodes.filter(n=>n.artboard===alias.address[0]&&n.node===alias.address[1])??[];if(matches.length!==1)return undefined;const node=matches[0]!;return layoutRectBounds(node.rect,node.transform);}
 for(const p of parts)if(p.id===alias.part&&p.kind==='interaction'){const node=p.document.targets.find(n=>n.id===alias.address[0]);if(node?.hitArea.kind==='rect'&&!node.transform&&!node.parent&&!p.geometry?.matrix)return node.hitArea.rect as readonly[number,number,number,number];}
 return undefined;
}

type CoreFontTuple=readonly[string,string,string];
type CoreFontFields=Readonly<{fontFamily?:string;fontStyle?:'normal'|'italic';fontWeight?:string|number;fontResource?:string}>;
/** Font declaration preflight only; bytes and OpenType execution stay with the original owners. */
function preflightCoreCpuFont(text:AnimationText2DComponent,path:string):void {
 const base:CoreFontTuple=[text.fontFamily??'sans-serif',text.fontStyle??'normal',String(text.fontWeight??400)];
 const tuple=(fields:CoreFontFields):CoreFontTuple=>[fields.fontFamily??base[0],fields.fontStyle??base[1],String(fields.fontWeight??base[2])];
 const key=(value:readonly string[])=>JSON.stringify(value);
 const error=(at:string):never=>{throw Object.assign(new ProductionFrameError('E_HYA_RUNTIME_HOST_PORT',at,'CPU core glyph evaluation requires a declared outline-font resource for this family, style and weight; a system family or layout font port cannot invent core metrics'),{capability:'core-text'});};
 const declared=new Map<string,CoreFontTuple>();
 for(const fields of [text,...(text.documents??[]),...(text.styleRuns??[])])if(fields.fontResource){const value=tuple(fields);declared.set(key(value),value);}
 const documents=text.documents??[],bases=new Map<string,CoreFontTuple>();
 if(!documents.length||documents[0]!.time>0){if(!declared.has(key(base)))error(path+'.fontResource');bases.set(key(base),base);}
 for(const [index,document]of documents.entries()){
  // Same-time documents, when accepted by the original parser, are stepped to the last one.
  if(documents[index+1]?.time===document.time)continue;
  const value=tuple(document);if(!declared.has(key(value)))error(path+'.documents['+index+'].fontResource');bases.set(key(value),value);
 }
 // Project the three font fields by override mask. Groups are disjoint for each mask;
 // successful coverage scans are bounded by the declared fonts, rather than docs × runs.
 const inherited=new Map<number,Set<string>>(),available=new Map<number,Map<string,Set<string>>>(),checked=new Set<string>();
 const projection=(value:CoreFontTuple,mask:number,fixed:boolean)=>key(value.filter((_,index)=>!!(mask&(1<<index))===fixed));
 for(const [index,run]of (text.styleRuns??[]).entries()){
  const fields=[run.fontFamily,run.fontStyle,run.fontWeight] as const;
  const mask=fields.reduce<number>((value,field,i)=>value|(field===undefined?0:1<<i),0),fixed=key(fields.flatMap(field=>field===undefined?[]:[String(field)])),id=mask+':'+fixed;
  if(checked.has(id))continue;
  let wanted=inherited.get(mask);if(!wanted){wanted=new Set([...bases.values()].map(value=>projection(value,mask,false)));inherited.set(mask,wanted);}
  let groups=available.get(mask);if(!groups){groups=new Map();for(const value of declared.values()){const fixedKey=projection(value,mask,true),free=groups.get(fixedKey)??new Set<string>();free.add(projection(value,mask,false));groups.set(fixedKey,free);}available.set(mask,groups);}
  const choices=groups.get(fixed),at=path+'.styleRuns['+index+']';
  if(!choices)return error(at);
  if(choices.size<wanted.size)error(at);
  for(const value of wanted)if(!choices.has(value))error(at);
  checked.add(id);
 }
}
