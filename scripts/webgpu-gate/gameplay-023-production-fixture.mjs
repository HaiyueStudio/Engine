import {createGameplayKit} from '/feature-consumer/browser/application.js';
import {MemorySaveBackend} from '@haiyue/engine/save';
import {Tilemap2DRenderSystem} from '@haiyue/extensions/tilemap';
import {getEngineDiagnosticsSnapshot} from '@haiyue/engine/diagnostics';

const output=document.getElementById('result'),progress=document.getElementById('progress');let app,record,profile,protocolId,scope=false,settle,abortError,done=false,previousMap=null,previousGui=0,actionCpuMs=0,lastAction=0,readyToFinalize=false,finalize;
const publish=()=>{output.textContent=JSON.stringify(record);output.dataset.status=record.status;done=true;};
const update=event=>{
 actionCpuMs=0;if(record.spec.gui!=='interactive'||record.firstRenderedAt===null||!app.level)return;
 const step=Math.floor((event.detail.time-record.firstRenderedAt)/1000);if(step<=lastAction)return;lastAction=step;
 const started=performance.now();app.badges[0].setValue(step);
 const page=[0,1,2,3,0][Math.floor(step/2)%5];app.actions.selectTab(page);if(page===1)app.list.scrollToKey(step%4<2?'item-500':'item-10');
 if(step%8===0)app.collapse.setExpandedKeys(step%16===0?['panel-0']:[]);
 actionCpuMs=performance.now()-started;record.actions.push({time:event.detail.time,step,page,collapse:app.collapse.getExpandedKeys(),listFirst:app.list.stats.first});
};
const frame=value=>{
 if(done||!app||record.status!=='running')return;
 try{
  const started=performance.now(),stats=app.stats(),level=app.level,map=level?.scene.world.getSystem(Tilemap2DRenderSystem)?.renderer?.stats??null;
  const counters=value.diagnostics.frame.counters,regions=app.engine.activeScene?._systems.renderPipeline.getDebugSnapshot().regions??null;
  const f={id:value.diagnostics.frame.frame,time:value.time,intervalMs:value.rawDelta,cpuMs:value.cpuFrameMs,guiCpuMs:value.guiCpuMs,cpuStages:value.diagnostics.frame.cpuMs,counters,gpu:value.diagnostics.frame.gpu??null,totalGpuBytes:value.diagnostics.gpuResources.totals.estimatedBytes,visible:document.visibilityState==='visible',focused:document.hasFocus(),tick:stats.tick,polls:stats.polls,characters:level?.characters.length??0,obstacles:level?[...level.scene.world.entities.values()].filter(e=>e.name.startsWith('Obstacle ')).length:0,assignedAssets:level?.loadedParts.length??0,worlds:stats.liveWorlds,listRows:app.list.stats.rowInstances,treeRows:app.tree.stats.rowInstances,audio:{state:stats.audio.state,voices:stats.audio.voices,nodes:stats.audio.audioNodes,stereoPan:app.mixer.getCapabilities().stereoPan,decodedBytes:stats.audio.buffers&&stats.audio.sampleRate?4*stats.audio.sampleRate:0},regions,map:map?{residentChunks:map.residentChunks,activeBytes:map.activeBytes,retiredBytes:map.retiredBytes,workingBytes:map.workingBytes,cpuVertexBytes:map.cpuVertexBytes,cpuMapBytes:map.cpuMapBytes,vertexUploadBytes:map.vertexUploadBytes-(previousMap?.vertexUploadBytes??0),vertexUploadCalls:map.vertexUploadCalls-(previousMap?.vertexUploadCalls??0)}:null,guiRecords:value.guiRecords-previousGui,actionCpuMs,samplerCpuMs:0};
  previousGui=value.guiRecords;if(map)previousMap=map;
  if(record.firstRenderedAt===null&&counters.draws>0){record.firstRenderedAt=value.time;record.captureStartedAt=value.time+profile.warmupMs;}
  (record.firstRenderedAt===null?record.startup:value.time<record.captureStartedAt?record.warmup:record.samples).push(f);
  progress.textContent='G11 '+JSON.stringify({...record.spec,elapsed:record.firstRenderedAt===null?0:Math.floor((value.time-record.firstRenderedAt)/1000),frames:record.samples.length});
  f.samplerCpuMs=performance.now()-started;
  if(record.firstRenderedAt!==null&&value.time-record.captureStartedAt>=(record.smoke?1000:profile.durationMs)){record.completedAt=value.time;app.engine.stop();settle();}
 }catch(error){abort(error);}
};
function abort(error){if(done||abortError)return;abortError=error instanceof Error?error:Error(String(error));app?.engine.stop();settle?.();}
async function start(spec,smoke=false,settings){
 if(record)throw Error('Only one fresh application capture per process.');
 ({profile,protocolId}=settings);
 record={schemaVersion:1,status:'running',protocolId,profile,spec,smoke,startup:[],warmup:[],samples:[],readiness:[],actions:[],errors:[],firstRenderedAt:null,captureStartedAt:null,completedAt:null,factoryStartedAt:performance.now(),factoryCompletedAt:null,navigation:performance.getEntriesByType('navigation')[0]?.toJSON()??null,samplerAddedSteadyQueueWaits:0};
 const complete=new Promise(resolve=>{settle=resolve;});
 try{
  app=await createGameplayKit(document.querySelector('canvas'),{samples:4,backend:new MemorySaveBackend(),assetUrl:new URL('/examples/gameplay-kit/level.json',location.href).href,timestampQuery:true,getGamepads:()=>[],onFrame:frame});
  record.factoryCompletedAt=performance.now();const info=app.engine.adapter.info;record.adapter={vendor:info.vendor,architecture:info.architecture,description:info.description,device:info.device,isFallbackAdapter:app.engine.adapter.isFallbackAdapter??info.isFallbackAdapter};
  record.renderSize={width:app.engine.width,height:app.engine.height,samples:app.engine.msaaSamples,dpr:devicePixelRatio};
  app.engine.device.pushErrorScope('validation');scope=true;app.engine.device.addEventListener('uncapturederror',event=>record.errors.push(event.error.message));app.engine.on('update',update);
  await app.actions.start();await app.actions.unlock();app.actions.setMutationPercent(spec.mutation);await complete;if(abortError)throw abortError;
  record.beforeDispose={stats:{worlds:app.stats().liveWorlds,rows:app.rows,audio:app.mixer.stats},gpu:getEngineDiagnosticsSnapshot(app.engine).gpuResources};
  const started=performance.now();await app.engine.device.queue.onSubmittedWorkDone();record.finalDrainMs=performance.now()-started;
  const error=await app.engine.device.popErrorScope();scope=false;if(error)record.errors.push(error.message);
  record.readiness=[...app.coldStart.completedFrames];record.applicationStartup=app.coldStart;record.resourceTimings=performance.getEntriesByType('resource').map(e=>({name:e.name,initiatorType:e.initiatorType,startTime:e.startTime,duration:e.duration,transferSize:e.transferSize,encodedBodySize:e.encodedBodySize,decodedBodySize:e.decodedBodySize}));
  record.status='captured';const finalizing=performance.now();readyToFinalize=true;await new Promise(resolve=>{finalize=resolve;});record.screenshotCleanupWaitMs=performance.now()-finalizing;
 }catch(error){record.status='failed';record.error=String(error.stack??error);}
 finally{
  if(app){app.engine.off('update',update);if(scope)try{const error=await app.engine.device.popErrorScope();if(error)record.errors.push(error.message);}catch(error){record.errors.push(String(error));}
   try{await app.dispose();const s=app.stats(),gpu=getEngineDiagnosticsSnapshot(app.engine).gpuResources.totals;record.cleanup={gpu,worlds:s.liveWorlds,levels:s.liveLevels,audioNodes:s.audio.audioNodes,voices:s.audio.voices,buffers:s.audio.buffers,rowsCreated:app.rows.created,rowsDisposed:app.rows.disposed,rowsBound:app.rows.bound,rowsUnbound:app.rows.unbound};}catch(error){record.status='failed';record.cleanupError=String(error.stack??error);}}
  record.measurement={cold:'Fresh process/profile; navigation start includes script download/parse and all factory/first GPU work. No OS/driver-cache purge.',steady:'Original Engine rAF and single original input sampler. No sampler-added steady queue fence or readback.',gpu:'Original asynchronous Engine snapshot when available; null is unmeasured. Independent same-candidate GPU matrix remains required.',queue:'Two original readiness completions and separately timed final drain; readiness observations are not relabelled as wait durations.',cpu:'Application runtime, GUI prepare/record, scheduled interaction and collection cost remain separate.',diagnosticCounters:'Existing private renderer/pipeline counters read for attribution; no additional public API.'};publish();
 }
}
window.__g11Production={ready:true,start,abort,finalize:()=>finalize?.(),delta:(cursor={})=>record?{startup:record.startup.slice(cursor.startup??0),warmup:record.warmup.slice(cursor.warmup??0),samples:record.samples.slice(cursor.samples??0),counts:{startup:record.startup.length,warmup:record.warmup.length,samples:record.samples.length}}:null,progress:()=>record?{status:record.status,spec:record.spec,frames:record.samples.length,warmup:record.warmup.length,elapsed:record.firstRenderedAt===null?0:performance.now()-record.firstRenderedAt}:null,get readyToFinalize(){return readyToFinalize;},get done(){return done;}};
