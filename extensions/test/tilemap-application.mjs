import{createTilemapExample}from'/feature-consumer/browser/application.js';
import{getEngineDiagnosticsSnapshot}from'@haiyue/engine/diagnostics';
import{drainTilemap,renderedFrames}from'./tilemap-browser-lifecycle.mjs';
const node=document.getElementById('result'),checks=[],cycles=[],errors=[];
const assert=(ok,label)=>{if(!ok)throw Error(label);checks.push(label);};
let app,device,scope=false;
try{
 app=await createTilemapExample(document.querySelector('canvas'),{samples:4});device=app.engine.device;
 const info=app.engine.adapter.info,adapter={vendor:info.vendor,description:info.description,isFallbackAdapter:info.isFallbackAdapter};
 const watch=d=>d.addEventListener('uncapturederror',e=>errors.push(e.error.message));watch(device);device.pushErrorScope('validation');scope=true;
 assert(adapter.isFallbackAdapter===false,'native hardware');await renderedFrames(app.engine,4);
 let renderer=app.system.renderer;const initial=renderer.stats;await renderedFrames(app.engine,6);
 assert(renderer.stats.vertexUploadCalls===initial.vertexUploadCalls,'actual static frames upload no extra vertices');
 const before=renderer.stats;app.map.setCell(10,10,app.map.getCell(10,10)===1?2:1);await renderedFrames(app.engine,2);
 assert(renderer.stats.chunkBuilds===before.chunkBuilds+1,'actual visible cell rebuilds one chunk');
 const offscreen=renderer.stats;app.map.setCell(511,511,2);await renderedFrames(app.engine,2);
 assert(renderer.stats.vertexUploadCalls===offscreen.vertexUploadCalls,'actual offscreen edit uploads nothing');
 for(let i=0;i<12;i++){
  app.pan();if(i%3===0)app.toggle();app.edit();await renderedFrames(app.engine,2);
  const s=renderer.stats;assert(s.residentChunks<=64,'pan '+i+' bounded resident chunks');cycles.push(s);
 }
 app.reset();app.map.resize(128,128);app.map.originX=-640;app.map.originY=-360;await renderedFrames(app.engine,3);
 assert(app.map.cells.length===16384&&renderer.stats.residentChunks<=64,'resize invalidates and reconstructs bounded geometry');
 app.entity.disabled=true;await renderedFrames(app.engine,2);await device.queue.onSubmittedWorkDone();
 assert(renderer.stats.residentChunks===0,'hidden entity releases resident windows');app.entity.disabled=false;await renderedFrames(app.engine,3);
 const firstScope=await device.popErrorScope();scope=false;if(firstScope)errors.push(firstScope.message);
 const oldRenderer=renderer,oldTexture=app.handle.value;device.destroy();await device.lost;await app.engine.waitForRecovery();device=app.engine.device;watch(device);device.pushErrorScope('validation');scope=true;
 await renderedFrames(app.engine,4);renderer=app.system.renderer;
 assert(renderer!==oldRenderer&&oldRenderer.stats.totalBytes===0,'device recovery releases old owner and reconstructs renderer');
 assert(app.handle.value!==oldTexture&&renderer.stats.residentChunks>0,'original AssetManager recreates borrowed atlas');
 app.engine.stop();app.scene.destroy();const retired=await drainTilemap(renderer,device);
 app.handle.value.createView();assert(true,'destroying Tilemap preserves caller-owned atlas');
 const validation=await device.popErrorScope();scope=false;if(validation)errors.push(validation.message);assert(errors.length===0,'no validation errors');
 await app.dispose();await device.lost;const finalGpu=getEngineDiagnosticsSnapshot(app.engine).gpuResources.totals;
 assert(finalGpu.resources===0&&finalGpu.estimatedBytes===0,'application destruction releases all tracked GPU resources');
 node.textContent=JSON.stringify({schemaVersion:1,status:'passed',adapter,checks,initial,cycles,retired,finalGpu,errors,coldStart:app.coldStart,qualification:false});node.dataset.status='passed';app=null;
}catch(error){node.textContent=JSON.stringify({schemaVersion:1,status:'failed',checks,cycles,errors,error:String(error.stack??error)});node.dataset.status='failed';}
finally{if(scope)try{await device.popErrorScope();}catch{}try{await app?.dispose();}catch{}}
