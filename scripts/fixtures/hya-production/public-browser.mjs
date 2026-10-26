import {HaiyueEngine} from '@haiyue/engine';
import {RttEngine} from '@haiyue/engine/rtt';
import {getSceneRenderPipeline,createRenderFrameContext,getEngineGPUResourceTracker} from '@haiyue/engine/experimental';
import {beginRenderCommandPass} from '@haiyue/engine/extension-authoring';
import {getEngineDiagnosticsSnapshot} from '@haiyue/engine/diagnostics';
import {createHyaPlayer} from '@haiyue/extensions/hya-player';
const output=document.querySelector('#result'),progress=document.querySelector('#progress'),canvas=document.querySelector('#canvas');
const check=(value,message)=>{if(!value)throw Error(message);},cases=[],captures=[],errors=[];
let engine,target,player,scene,environment,scope=false,leases=0,sequence=0,dynamicRecords=0;const width=480,height=360;
const digest=async bytes=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(x=>x.toString(16).padStart(2,'0')).join('');
async function pixels(){const row=Math.ceil(width*4/256)*256,buffer=engine.device.createBuffer({size:row*height,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});try{const encoder=engine.device.createCommandEncoder();encoder.copyTextureToBuffer({texture:target.colorTexture},{buffer,bytesPerRow:row},[width,height]);engine.device.queue.submit([encoder.finish()]);await buffer.mapAsync(GPUMapMode.READ);const bytes=new Uint8Array(buffer.getMappedRange()),tight=new Uint8Array(width*height*4);for(let y=0;y<height;y++)tight.set(bytes.subarray(y*row,y*row+width*4),y*width*4);buffer.unmap();return tight;}finally{buffer.destroy();}}
function capture(id,bytes){const image=document.createElement('canvas');image.width=width;image.height=height;image.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(bytes),width,height),0,0);captures.push({id,png:image.toDataURL()});}
async function ready(request){const start=performance.now();let attempts=0;while(true){const frame=player.advance(request);attempts++;if(frame.ready)return {frame,attempts,ms:performance.now()-start};if(performance.now()-start>30000)throw Error('Required real resources never became ready');await new Promise(resolve=>setTimeout(resolve,0));}}
async function drainRetirement(){for(let boundary=0;boundary<4;boundary++){await engine.device.queue.onSubmittedWorkDone();await new Promise(resolve=>setTimeout(resolve,0));}}
function render(cache=true){scene.world.frameData.begin(scene.world,engine,++sequence,0);return getSceneRenderPipeline(scene).execute(scene.world,sequence,0,{view:scene.renderView.snapshot(),regionCache:cache});}
try{
 engine=new HaiyueEngine({canvas,msaaSamples:1,devicePixelRatio:1,timestampQuery:false,renderProfile:'simple',clearColor:{r:240/255,g:240/255,b:240/255,a:1},diagnostics:{enabled:true}});await engine.init();engine.device.addEventListener('uncapturederror',event=>errors.push(event.error.message));engine.device.pushErrorScope('validation');scope=true;
 environment={userAgent:navigator.userAgent,adapter:{vendor:engine.adapter.info.vendor,architecture:engine.adapter.info.architecture,description:engine.adapter.info.description}};
 target=new RttEngine(engine,width,height,{r:240/255,g:240/255,b:240/255,a:1});
 scene=engine.createScene({name:'G12 packed composition',render3D:false,render2D:false,gui:false});scene.renderView.target=target.renderTarget;scene.renderView.sampleCount=1;scene.renderView.clearColor={r:240/255,g:240/255,b:240/255,a:1};
 const pipeline=getSceneRenderPipeline(scene),dynamic={record(_world,context){dynamicRecords++;const {passEncoder,ownsPass}=beginRenderCommandPass(context);if(ownsPass)passEncoder.end();}};
 pipeline.add(dynamic,{order:-10,pass:'isolated',loadOp:'clear',depth:false});
 const manifest=await(await fetch('/g12-assets/assets.json')).json(),verified=new Map();
 for(const [id,descriptor]of Object.entries(manifest.assets)){const bytes=await(await fetch('/g12-assets/'+descriptor.file,{cache:'no-store'})).arrayBuffer();check(bytes.byteLength===descriptor.bytes&&await digest(bytes)===descriptor.sha256,'Original licensed resource hash mismatch: '+id);verified.set(id,new Uint8Array(bytes));}
 const sourceBytes=await(await fetch('/g12-assets/scene.json',{cache:'no-store'})).arrayBuffer();check(await digest(sourceBytes)===manifest.scene.sha256,'Composition SHA mismatch');const source=JSON.parse(new TextDecoder().decode(sourceBytes));
 const resources={async acquire(request){const id=request.asset==='core-image'?'alternate':request.asset,descriptor=manifest.assets[id],bytes=verified.get(id);check(bytes&&request.integrity===descriptor.integrity&&!request.signal.aborted,'Undeclared resource');let released=false;leases++;return {value:bytes.slice(),generation:1,bytes:bytes.byteLength,release(){if(!released){released=true;leases--;}}};}};
 const options={mode:'render',scene,viewport:[width,height],dpr:1,host:{resources,capabilities:new Set(source.parts.map(part=>part.extension)),invalidate(){},diagnostic:diagnostic=>errors.push(diagnostic.message)}};
 player=await createHyaPlayer(source,options);await ready({sequence:1,deltaSeconds:0,viewport:[width,height],dpr:1});render();await engine.device.queue.onSubmittedWorkDone();player.dispose();player=null;check(leases===0,'Default player did not release borrowed resources');cases.push({id:'default-direct-player-with-unregional-scene-compatible'});pipeline.remove(dynamic);
 const regionOptions={bounds:{x:0,y:0,width,height},clearMode:'on-update',visible:true};
 const continuous=scene.renderView.createRegion({...regionOptions,id:'continuous-scene',updateMode:'continuous'}),region=scene.renderView.createRegion({...regionOptions,id:'static-hya',updateMode:'demand'});
 pipeline.add(dynamic,{order:-10,pass:'isolated',loadOp:'clear',depth:false,region:continuous});
 const createStart=performance.now();player=await createHyaPlayer(source,{...options,region});const prepareMs=performance.now()-createStart;
 const first=await ready({sequence:1,deltaSeconds:0,viewport:[width,height],dpr:1});render();await engine.device.queue.onSubmittedWorkDone();const cached=await pixels();render(false);await engine.device.queue.onSubmittedWorkDone();const direct=await pixels();let maximum=0;for(let i=0;i<cached.length;i++)maximum=Math.max(maximum,Math.abs(cached[i]-direct[i]));capture('initial-cached',cached);capture('initial-direct',direct);check(maximum<=2,'Retained pixels differ from full raster: '+maximum);check(cached.some((x,i)=>i%4!==3&&Math.abs(x-240)>15),'Real text/image composition is empty');cases.push({id:'public-tarball-cached-full-raster-pixels',maximum,prepareMs,firstReadyMs:first.ms,readinessAttempts:first.attempts});
 render();await engine.device.queue.onSubmittedWorkDone();const beforeUploads=getEngineDiagnosticsSnapshot(engine).frame.counters.bufferUploads;
 for(let frame=0;frame<30;frame++){await ready({sequence:2+frame,deltaSeconds:1/60,viewport:[width,height],dpr:1});const before=dynamicRecords;render();const stats=getSceneRenderPipeline(scene).getDebugSnapshot().regions;check(dynamicRecords===before+1,'Continuous scene did not advance');check(stats&&stats.producerRecords===1,'Static HYA redrew instead of reusing G04 pixels: '+JSON.stringify(stats));check(stats.retainedColorBytes<=64*1024*1024&&stats.cachedRegions<=8,'Original cache ceiling exceeded');}
 const writes=getEngineDiagnosticsSnapshot(engine).frame.counters.bufferUploads-beforeUploads;check(writes===0,'Static HYA/compositor uploaded additional buffer data: '+writes);
 cases.push({id:'continuous-scene-static-hya-zero-producer-upload',frames:30,writes});
 player.data.run(write=>{write.set({part:'data',id:'root'},['label'],'你好 B');write.set({part:'data',id:'root'},['go'],true);});const changed=await ready({sequence:32,deltaSeconds:1,viewport:[width,height],dpr:1});render();await engine.device.queue.onSubmittedWorkDone();const updated=await pixels();capture('updated',updated);check(updated.some((x,i)=>x!==cached[i]),'Committed data/state failed to change actual pixels');check(player.data.read({part:'data',id:'root'},['label'])==='你好 B','Public data transaction was not committed');cases.push({id:'public-data-state-text-first-visible-frame',ready:changed.frame.ready});
 player.pause();await ready({sequence:33,deltaSeconds:10,viewport:[width,height],dpr:1});const paused=player.lastFrame.time;player.resume();await ready({sequence:34,deltaSeconds:.1,viewport:[width,height],dpr:1});check(player.lastFrame.time>paused,'Resume did not advance original transport');cases.push({id:'public-pause-resume'});
 player.dispose();player=null;render();await drainRetirement();check(leases===0,'Borrowed resource leases remain: '+leases);
 const lifecycle=[],baselineResources=getEngineDiagnosticsSnapshot(engine).gpuResources;
 const lifecycleCase={id:'public-repeated-load-update-destroy-bounded',cycles:lifecycle,baselineResources,baselineOwned:getEngineGPUResourceTracker(engine).getResources()};cases.push(lifecycleCase);
 for(let cycle=0;cycle<30;cycle++){
  player=await createHyaPlayer(source,{...options,region});await ready({sequence:1,deltaSeconds:0,viewport:[width,height],dpr:1});render();
  const live=getEngineDiagnosticsSnapshot(engine).gpuResources;
  player.data.run(write=>write.set({part:'data',id:'root'},['label'],cycle%2?'你好 A':'你好 B'));await ready({sequence:2,deltaSeconds:0,viewport:[width,height],dpr:1});render();
  player.dispose();player=null;render();await drainRetirement();
  const disposed=getEngineDiagnosticsSnapshot(engine).gpuResources;lifecycle.push({cycle,live,disposed,leases,owned:getEngineGPUResourceTracker(engine).getResources()});check(leases===0,'Repeated load/destroy retained resource leases');
  for(const type of ['buffer','texture'])check((disposed.byType[type]?.current??0)<=(baselineResources.byType[type]?.current??0),'Repeated load/destroy grew live '+type+' resources');
 }
 scene.destroy();target.destroy();const validation=await engine.device.popErrorScope();scope=false;if(validation)errors.push(validation.message);check(!errors.length,errors.join(';'));engine.destroy();const afterDestroy=getEngineDiagnosticsSnapshot(engine).gpuResources;check(afterDestroy.totals.resources===0,'Owned GPU resources remain');cases.push({id:'public-owner-disposal',leases,afterDestroy});
 output.textContent=JSON.stringify({status:'passed',caseCount:cases.length,cases,captures,errors,environment,scope:'Packed public production composition and retained-pixel correctness; no physical input or production pacing acceptance'});output.dataset.status='passed';
}catch(error){output.textContent=JSON.stringify({status:'failed',caseCount:cases.length,cases,captures,errors,error:String(error.stack??error)});output.dataset.status='failed';}
finally{try{player?.dispose();scene?.destroy();target?.destroy();if(scope)await engine.device.popErrorScope();engine?.destroy();}catch(error){progress.textContent=String(error);}}
