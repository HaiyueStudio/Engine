import {Camera3D,Entity,Transform3D,PointLight,RenderView,createAuditTarget,createDeferredReferenceProfile,runRealRendererBenchmarkFrame,resetRealRendererBenchmarkMetrics} from '../../artifacts/engine-0.2.1/g03/fixture.js';
import {createFloatTextureReadback} from './float-texture-readback.mjs';
import {validateTileMembership} from './deferred-tile-oracle.mjs';

export async function verifyTiledViews({state,lights,readTiles}){
  const original=state.views[0],{device,render3d}=state;
  const targets=[[64,64],[17,33],[64,32],[32,64]].map(([w,h])=>createAuditTarget(device,w,h,true));
  const cameras=targets.map((_,i)=>new Entity(`tile-camera:${i}`).addComponent(new Transform3D().setTranslation((i-1.5)*3,i%2,8)).addComponent(new Camera3D(i===2?{type:'orthographic',left:-8,right:8,bottom:-8,top:8,near:.1,far:100}:{near:.1,far:100})));
  cameras.forEach(camera=>state.world.add(camera));
  let activeReadbacks=[];
  const activate=async(tiled,forceCulling=true)=>{
    const profile=await createDeferredReferenceProfile(render3d,state.engine,tiled?{tiled:{forceCulling}}:{}),record=profile.backend.record.bind(profile.backend);
    profile.backend.record=input=>{
      const result=record(input);if(!result)throw Error('Unexpected tiled view fallback');
      const readback=createFloatTextureReadback(device,render3d._postScenePasses._postRenderer.sceneTexture);
      readback.encode(input.context.encoder);
      activeReadbacks.push({key:input.view.key,width:input.view.width,height:input.view.height,readback,
        passes:profile.backend.passes.map(pass=>pass.name),source:profile.backend.lastSource,diagnostics:{...profile.backend.diagnostics},inverse:Array.from(input.sceneFrame.data.slice(32,48)),tiles:profile.backend.tileDiagnostics});
      return result;
    };
    return profile;
  };
  const capture=async()=>{
    resetRealRendererBenchmarkMetrics(state);await runRealRendererBenchmarkFrame(state);
    const entries=activeReadbacks;activeReadbacks=[];const results=[];
    try{for(const entry of entries){const pixels=await entry.readback.read();results.push({...entry,pixels});}}
    finally{for(const entry of entries)entry.readback.destroy();}
    return results;
  };
  try{
    state.views.splice(0,state.views.length,...targets.map((target,i)=>new RenderView({key:`tiled-view:${i}`,target,camera:cameras[i],depthConvention:i===3?'reverse':'standard'}).snapshot()));
    lights.forEach((light,i)=>{light.disabled=i>=128;light.getComponent(PointLight).range=3;});
    await activate(false);const reference=await capture();
    const tiled=await activate(true),actual=await capture(),views=[];
    if(new Set(actual.map(entry=>entry.tiles.binding.buffer)).size!==4)throw Error('View tile buffers alias');
    if(tiled.backend.uploadStats.sourceUploads!==1)throw Error('Shared World source uploaded more than once');
    for(let view=0;view<4;view++){
      const a=actual[view],b=reference[view];let maxHdrDelta=0,geometryPixels=0;
      for(let i=0;i<a.pixels.length;i++){
        const delta=Math.abs(a.pixels[i]-b.pixels[i]);maxHdrDelta=Math.max(maxHdrDelta,delta);
        if(!Number.isFinite(a.pixels[i])||delta>Math.max(.002,Math.abs(b.pixels[i])*.002))throw Error(`Multiview ${view} pixel ${i} differs`);
        if(i%4===0&&a.pixels[i]+a.pixels[i+1]+a.pixels[i+2]>0)geometryPixels++;
      }
      if(!geometryPixels)throw Error('Multiview receiver missing');
      const membership=validateTileMembership(await readTiles(device,a.tiles.binding),a.tiles.plan,a.source,a.inverse,a.width,a.height);
      views.push({key:a.key,width:a.width,height:a.height,maxHdrDelta,geometryPixels,membership});
    }
    // Remove diagnostic allocations before checking stable-frame resource counters.
    const provider=tiled.backend,wrapped=provider.record;
    // Restore the original prototype method, retaining the same provider and caches.
    provider.record=Object.getPrototypeOf(provider).record.bind(provider);
    const counters=()=>{
      const computePipelines=state.tracker.getDebugSnapshot().byType['compute-pipeline']?.created;
      if(!Number.isInteger(computePipelines)||computePipelines<1)throw Error('Compute pipeline resource statistics unavailable');
      return {buffers:state.audit.buffersCreated,bindGroups:state.audit.bindGroupsCreated,pipelines:state.audit.renderPipelinesCreated,computePipelines};
    };
    for(let i=0;i<8;i++)await runRealRendererBenchmarkFrame(state);
    const baseline=counters();for(let i=0;i<8;i++){lights[0].getComponent(PointLight).intensity=.05+i*.001;await runRealRendererBenchmarkFrame(state);}
    const dynamic=counters();if(JSON.stringify(baseline)!==JSON.stringify(dynamic))throw Error(`Tiled dynamic allocations ${JSON.stringify({baseline,dynamic})}`);
    // Replace one target and restore it on the same provider; old lists cannot survive dimensions.
    provider.record=wrapped;
    const smaller=createAuditTarget(device,31,17,true);
    try{
      state.views[0]=new RenderView({key:'tiled-view:0',target:smaller,camera:cameras[0]}).snapshot();
      const resized=await capture(),view=resized[0];
      const membership=validateTileMembership(await readTiles(device,view.tiles.binding),view.tiles.plan,view.source,view.inverse,view.width,view.height);
      if(view.tiles.plan.columns!==2||view.tiles.plan.rows!==2)throw Error('Resize retained old tile dimensions');
      const validation=await device.popErrorScope();device.pushErrorScope('validation');if(validation)throw Error(validation.message);
      const auto=await activate(true,false),transitions=[];
      for(const range of [40,3,40]){
        for(const light of lights)light.getComponent(PointLight).range=range;
        const records=await capture();
        const effective='deferred-tiled',reason=range===40?'all-lights-cover-near-plane':null;
        if(records.some(entry=>entry.diagnostics.effective!==effective||entry.diagnostics.completeCoverage!==true||entry.diagnostics.reason!==reason))throw Error('Incorrect automatic full-list transition');
        const cullPasses=records.map(entry=>entry.passes.filter(name=>name==='deferred-tile-cull').length);
        if(cullPasses.some(count=>count!==(range===40?0:1)))throw Error('Bypass unexpectedly runs compute');
        transitions.push({range,cullPasses,paths:records.map(entry=>entry.diagnostics),tileBuffers:records.filter(entry=>entry.tiles.binding).length});
      }
      auto.backend.record=Object.getPrototypeOf(auto.backend).record.bind(auto.backend);
      return {views,sourceUploadsAcrossFourViews:1,reuse:{frames:8,baseline,dynamic},resize:{width:31,height:17,membership},transitions};
    }finally{smaller.destroy();}
  }finally{
    for(const entry of activeReadbacks)entry.readback.destroy();
    state.views.splice(0,state.views.length,original);lights[0].getComponent(PointLight).intensity=.05;for(const light of lights)light.getComponent(PointLight).range=3;
    for(const camera of cameras)state.world.removeEntity(camera);for(const target of targets)target.destroy();
  }
}
