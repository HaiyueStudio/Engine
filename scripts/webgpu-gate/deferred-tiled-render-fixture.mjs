import {createRealRendererBenchmarkScenario,runRealRendererBenchmarkFrame,destroyRealRendererBenchmarkScenario,createAuditTarget,resetRealRendererBenchmarkMetrics,
 Entity,PointLight,Transform3D,Mesh3D,Geometry3D,PbrMaterial,createDeferredReferenceProfile,mat4} from '../../artifacts/engine-0.2.1/g03/fixture.js';
import {readFloatTexture} from './float-texture-readback.mjs';
import {verifyTiledViews} from './deferred-tiled-views.mjs';
import {verifyTiledBoundaries} from './deferred-tiled-boundaries.mjs';
import {validateTileMembership} from './deferred-tile-oracle.mjs';
const node=document.querySelector('#result'),progress=document.querySelector('#progress');
try{node.textContent=JSON.stringify(await run());node.dataset.status='passed';}
catch(error){node.textContent=JSON.stringify({status:'failed',error:error.stack??String(error)});node.dataset.status='failed';}
async function readTiles(device,binding){
  const readback=device.createBuffer({size:binding.size,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
  try{const encoder=device.createCommandEncoder();encoder.copyBufferToBuffer(binding.buffer,binding.offset??0,readback,0,binding.size);device.queue.submit([encoder.finish()]);await readback.mapAsync(GPUMapMode.READ);const words=new Uint32Array(readback.getMappedRange().slice(0));readback.unmap();return words;}finally{readback.destroy();}
}
async function run(){
  const preference=new URLSearchParams(location.search).get('powerPreference')??'high-performance';
  const adapter=await navigator.gpu.requestAdapter({powerPreference:preference});if(!adapter||adapter.info.isFallbackAdapter)throw Error('Native adapter required');
  const device=await adapter.requestDevice(),errors=[];device.addEventListener('uncapturederror',event=>errors.push(event.error.message));device.pushErrorScope('validation');
  const target=createAuditTarget(device,64,64,true);let state,result,failure;
  try{
    state=await createRealRendererBenchmarkScenario({device,target,entityCount:0,viewCount:1,renderProfile:'batched'});
    for(const entity of [...state.world.entities.values()])if(!entity.name.startsWith('real-camera:'))state.world.removeEntity(entity);
    state.render3d.passes.length=0;
    const geometry=new Geometry3D({positions:new Float32Array([-8,-8,0,8,-8,0,8,8,0,-8,-8,0,8,8,0,-8,8,0]),normals:new Float32Array(Array.from({length:6},()=>[0,0,1]).flat())});
    const receiver=new Entity('receiver').addComponent(new Transform3D()).addComponent(new Mesh3D(geometry,new PbrMaterial({baseColor:[.5,.3,.2,1],metallic:0,roughness:.6})));state.world.add(receiver);
    const lights=Array.from({length:256},(_,i)=>{
      const entity=new Entity(`tile-light:${i}`).addComponent(new Transform3D().setTranslation((i%16)-7.5,Math.floor(i/16)-7.5,2)).addComponent(new PointLight({intensity:.05,range:3}));state.world.add(entity);return entity;
    });
    const cases=[];
    for(const count of [0,1,128,256])for(const overlap of [false,true]){
      lights.forEach((entity,i)=>{entity.disabled=i>=count;entity.getComponent(PointLight).range=overlap?40:3;});
      progress.textContent=`Reference ${count} overlap=${overlap}`;
      const referenceProfile=await createDeferredReferenceProfile(state.render3d,state.engine);state.render3d.checkEntityManager(state.world);resetRealRendererBenchmarkMetrics(state);await runRealRendererBenchmarkFrame(state);
      const reference=await readFloatTexture(device,state.render3d._postScenePasses._postRenderer.sceneTexture);
      if(referenceProfile.backend.lastSource.stats.pointCount!==count)throw Error('Reference source count mismatch');
      let litPixels=0;for(let i=0;i<reference.length;i+=4)if(reference[i]+reference[i+1]+reference[i+2]>0)litPixels++;
      if(count>=128&&litPixels<1024)throw Error('Reference receiver is not visibly lit');
      const referenceLdr=await readFloatTexture(device,target.colorTexture);
      for(const [mode,tiled] of [['normal',{}],['local-overflow',{tileCapacity:2}],['total-overflow',{maxTileRecords:2}],['no-storage',{maxTileRecords:0}]]){
        progress.textContent=`${count} overlap=${overlap} ${mode}`;
        const profile=await createDeferredReferenceProfile(state.render3d,state.engine,{tiled:{forceCulling:true,...tiled}});resetRealRendererBenchmarkMetrics(state);await runRealRendererBenchmarkFrame(state);
        const actual=await readFloatTexture(device,state.render3d._postScenePasses._postRenderer.sceneTexture),ldr=await readFloatTexture(device,target.colorTexture);
        let maxHdrDelta=0,maxLdrDelta=0;
        for(let i=0;i<reference.length;i++){
          const delta=Math.abs(actual[i]-reference[i]);maxHdrDelta=Math.max(maxHdrDelta,delta);maxLdrDelta=Math.max(maxLdrDelta,Math.abs(ldr[i]-referenceLdr[i])*255);
          if(!Number.isFinite(actual[i])||delta>Math.max(.002,Math.abs(reference[i])*.002))throw Error(`HDR mismatch ${count}/${overlap}/${mode}/${i}: ${actual[i]} vs ${reference[i]}`);
        }
        if(maxLdrDelta>2.001)throw Error(`LDR mismatch ${maxLdrDelta}`);
        const diagnostics=profile.backend.tileDiagnostics,words=await readTiles(device,diagnostics.binding);
        const membership=validateTileMembership(words,diagnostics.plan,profile.backend.lastSource,mat4.inverse(state.render3d._viewProjMatrix),64,64);
        if(overlap&&count===256&&mode==='normal'&&membership.overflowTiles!==16)throw Error('Expected every tile to overflow');
        const validation=await device.popErrorScope();if(validation)errors.push(validation.message);if(errors.length)throw Error(errors.join('\n'));device.pushErrorScope('validation');
        cases.push({count,overlap,mode,litPixels,maxHdrDelta,maxLdrDelta,plan:diagnostics.plan,membership,passes:profile.backend.passes,coverage:profile.backend.diagnostics.completeCoverage});
      }
    }
    const boundaryCases=await verifyTiledBoundaries({state,lights,receiver,readTiles});
    const viewCases=await verifyTiledViews({state,lights,readTiles});
    const capacityCases=await verifySourceCapacity(state,lights);
    const validation=await device.popErrorScope();if(validation)errors.push(validation.message);if(errors.length)throw Error(errors.join('\n'));
    return result={status:'passed',schemaVersion:1,scope:'64x64 render/overflow/membership and mixed-view diagnostic; performance qualification separate',adapter:{vendor:adapter.info.vendor,architecture:adapter.info.architecture,isFallbackAdapter:adapter.info.isFallbackAdapter},cases,boundaryCases,viewCases,capacityCases,validationErrors:errors};
  }catch(error){failure=error;throw error;}
  finally{
    try{if(state){await destroyRealRendererBenchmarkScenario(state);if(result)result.cleanup={ownerResidual:state.finalMetrics.ownerResidual,liveGpuResources:state.finalMetrics.liveGpuResources};}}
    catch(cleanupError){if(!failure)throw cleanupError;failure.stack+=`\nCleanup also failed: ${cleanupError.stack}`;}
    finally{target.destroy();device.destroy();}
  }
}

async function verifySourceCapacity(state,lights){
  lights.forEach(light=>{light.disabled=false;});
  const extra=Array.from({length:769},(_,i)=>new Entity(`capacity-light:${i}`).addComponent(new Transform3D().setTranslation(0,0,2)).addComponent(new PointLight({intensity:.001,range:3})));
  extra.forEach(light=>state.world.add(light));
  const cases=[];
  try{
    for(const failurePolicy of ['strict','forward']){
      const profile=await createDeferredReferenceProfile(state.render3d,state.engine,{tiled:{forceCulling:true},failurePolicy});
      const record=profile.backend.record.bind(profile.backend);let thrown=null;
      // Observe the strict exception at the backend boundary, then let the test frame
      // close normally. Production strict mode still propagates this exception.
      profile.backend.record=input=>{try{return record(input);}catch(error){thrown={name:error.name,reason:error.reason,observed:error.observed,supported:error.supported};return false;}};
      resetRealRendererBenchmarkMetrics(state);await runRealRendererBenchmarkFrame(state);
      const diagnostics={...profile.backend.diagnostics};
      if(diagnostics.reason!=='point-capacity'||diagnostics.completeCoverage!==false||diagnostics.effective!=='forward')throw Error('Source capacity silently accepted');
      if(failurePolicy==='strict'?(thrown?.reason!=='point-capacity'||thrown.observed!==1025||thrown.supported!==1024):thrown!==null)throw Error('Source capacity failure policy changed');
      extra.at(-1).disabled=true;await runRealRendererBenchmarkFrame(state);
      const recovered=profile.backend.lastSource.stats.pointCount;
      if(recovered!==1024||profile.backend.diagnostics.completeCoverage!==true)throw Error('Source capacity recovery failed');
      cases.push({id:'cull-source-capacity-error',failurePolicy,requested:1025,thrown,diagnostics,recovered});
      extra.at(-1).disabled=false;
    }
    return cases;
  }finally{for(const light of extra)state.world.removeEntity(light);}
}
