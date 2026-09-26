import { readFloatTexture } from './float-texture-readback.mjs';
import { Camera3D, PointLight, createAuditTarget, createDeferredReferenceProfile, runRealRendererBenchmarkFrame } from '../../artifacts/engine-0.2.1/g02/fixture.js';

export async function verifyDeferredViews({state,lights,readPixel,near}) {
  const {device,render3d}=state, original=state.views[0], camera=original.camera, results=[];
  lights.forEach((light,i)=>{light.disabled=i>=8;});
  const read=()=>readPixel(device,render3d._postScenePasses._postRenderer.sceneTexture,32,32);
  const step=async(label,run)=>{
    document.querySelector('#progress').textContent=label;
    let timer;try{return await Promise.race([run(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(`Timed out at ${label}: ${document.querySelector('#progress').textContent}`)),30000);})]);}finally{clearTimeout(timer);}
  };
  try {
    for(const projection of ['perspective','orthographic'])for(const reverseZ of [false,true])for(const remapDepth of [false,true]) {
      document.querySelector('#progress').textContent=`View ${projection} reverseZ=${reverseZ} depthRemap=${remapDepth}`;
      camera.addComponent(new Camera3D(projection==='perspective'?{near:.1,far:100}:{type:'orthographic',left:-8,right:8,bottom:-8,top:8,near:.1,far:100}));
      state.views[0]={...original,reverseZ,depthConvention:reverseZ?'reverse':'standard',viewport:remapDepth?{x:0,y:0,width:64,height:64,minDepth:.2,maxDepth:.8}:null};
      render3d.setRenderProfile('batched');await step(`${projection}/${reverseZ}/${remapDepth} Forward frame`,()=>runRealRendererBenchmarkFrame(state));const forward=await step('Read Forward pixel',read);
      await step('Initialize next Deferred profile',()=>createDeferredReferenceProfile(render3d,state.engine));await step('Record next Deferred frame',()=>runRealRendererBenchmarkFrame(state));const deferred=await step('Read next Deferred pixel',read);
      if(!forward.slice(0,3).every(v=>v>0))throw new Error('Projection parity has no lit receiver');
      near(deferred,forward,.005,.003,`${projection}/${reverseZ}/${remapDepth} reconstruction`);
      results.push({id:'view-reconstruction',projection,reverseZ,remapDepth,forward,deferred});
    }
    state.views[0]=original;camera.addComponent(new Camera3D({near:.1,far:100}));
    if(device.features.has('indirect-first-instance')) {
      document.querySelector('#progress').textContent='GPU-driven indirect draw';
      const profile=await createDeferredReferenceProfile(render3d,state.engine,{baseline:'gpu-driven'});
      const before=state.audit.bundleExecutions;
      const originalCreateBindGroup=device.createBindGroup, createdGroups=[], ids=new WeakMap();
      let nextId=0;
      const resourceId=value=>{if(!ids.has(value))ids.set(value,++nextId);return ids.get(value);};
      device.createBindGroup=function(descriptor){
        createdGroups.push({frame:state.frameId,label:descriptor.label??'',entries:[...descriptor.entries].map(entry=>{
          const resource=entry.resource,buffer=resource.buffer;
          return {binding:entry.binding,id:resourceId(buffer??resource),label:(buffer??resource).label??'',
            ...(buffer?{offset:resource.offset??0,size:resource.size??buffer.size}: {})};
        })});
        return originalCreateBindGroup.call(device,descriptor);
      };
      try {
      await runRealRendererBenchmarkFrame(state);
      if(state.audit.bundleExecutions<=before)throw new Error('GPU-driven Deferred did not execute indirect bundles');
      const indirect=await read();
      near(indirect,results[0].forward,.005,.003,'indirect/Forward parity');
      results.push({id:'gpu-driven-indirect',pixel:indirect,bundleExecutions:state.audit.bundleExecutions-before});
      // Warm all normal frame slots, then require resource/upload reuse on unchanged scenes.
      for(let i=0;i<8;i++)await runRealRendererBenchmarkFrame(state);
      const counters=()=>({buffers:state.audit.buffersCreated,bindGroups:state.audit.bindGroupsCreated,pipelines:state.audit.renderPipelinesCreated,sourceUploads:profile.backend.uploadStats.sourceUploads});
      const baseline=counters();for(let i=0;i<8;i++)await runRealRendererBenchmarkFrame(state);
      const current=counters(), dynamicStart=createdGroups.length;if(JSON.stringify(current)!==JSON.stringify(baseline))throw new Error(`Stationary resource reuse failed: ${JSON.stringify({baseline,current})}`);
      results.push({id:'stationary-resource-reuse',frames:8,baseline,current});
      for(let i=0;i<8;i++){lights[0].getComponent(PointLight).intensity=.05+i*.001;await runRealRendererBenchmarkFrame(state);}
      const dynamic=counters();if(dynamic.buffers!==current.buffers||dynamic.bindGroups!==current.bindGroups||dynamic.pipelines!==current.pipelines)throw new Error(`Dynamic resource reuse failed: ${JSON.stringify({current,dynamic,createdGroups:createdGroups.slice(dynamicStart),allCreatedGroups:createdGroups})}`);
      results.push({id:'dynamic-resource-reuse',frames:8,current,dynamic,createdGroups:createdGroups.slice(dynamicStart)});
      } finally {device.createBindGroup=originalCreateBindGroup;}
    } else results.push({id:'gpu-driven-indirect',status:'unavailable',reason:'device feature indirect-first-instance unavailable'});
    lights[0].getComponent(PointLight).intensity=.05;
    // Isolate depth reconstruction under camera jitter; temporal resolve belongs to G04.
    const owner=render3d._postScenePasses,resolveJitter=owner.resolveProjectionJitter;
    try {
      owner.resolveProjectionJitter=(_passes,_context,out)=>{out[0]=.375;out[1]=-.25;return out;};
      render3d.setRenderProfile('batched');await runRealRendererBenchmarkFrame(state);const forward=await read();
      await createDeferredReferenceProfile(render3d,state.engine);await runRealRendererBenchmarkFrame(state);const deferred=await read();
      near(deferred,forward,.005,.003,'jittered depth reconstruction');results.push({id:'jitter-reconstruction',jitter:[.375,-.25],forward,deferred});
    } finally {owner.resolveProjectionJitter=resolveJitter;}
    const targets=Array.from({length:3},()=>createAuditTarget(device,64,64,true));
    try {
      state.views.splice(0,state.views.length,...[original.target,...targets].map((target,i)=>({...original,key:`oracle-multiview:${i}`,target,loadOp:'clear'})));
      const attachmentsByView=new Map();
      const activate=async()=>{
        const profile=await createDeferredReferenceProfile(render3d,state.engine);
        const record=profile.backend.record.bind(profile.backend);
        profile.backend.record=input=>{
          const result=record(input);
          attachmentsByView.set(input.view.key,profile.backend.lastAttachments);
          return result;
        };
        return profile;
      };
      let profile=await activate();
      const fail=async(frame,next,expected)=>{
        const validation=await device.popErrorScope();device.pushErrorScope('validation');
        const gbuffer=await Promise.all(profile.backend.lastAttachments.textures.map(async(t,i)=>{
          const values=await readFloatTexture(device,t,i===3);return Array.from(values.slice((32*64+32)*4,(32*64+32)*4+4));
        }));
        // Re-read unchanged targets without rendering: distinguish a render failure from readback corruption.
        const reread=[];
        for(const target of [original.target,...targets])reread.push(await readOutput(device,target));
        const fullOutputs=[];
        for(const target of [original.target,...targets])fullOutputs.push(await inspectOutput(device,target));
        const allGbuffers=[];
        for(const [key,attachments] of attachmentsByView)allGbuffers.push({key,pixels:await Promise.all(attachments.textures.slice(0,3).map(t=>readPixel(device,t,32,32)))});
        const hdr=await readPixel(device,render3d._postScenePasses._postRenderer.sceneTexture,32,32);
        throw new Error(`Multi-view mismatch ${JSON.stringify({frame,next,reread,fullOutputs,expected,gbuffer,allGbuffers,hdr,validation:validation?.message,source:profile.backend.lastSource.stats,visible:render3d.lastVisibleCount,draws:state.audit.draws})}`);
      };
      await runRealRendererBenchmarkFrame(state);
      const validation=await device.popErrorScope();device.pushErrorScope('validation');
      if(validation)throw new Error(`Multi-view GPU validation: ${validation.message}`);
      if(render3d.lastViewCount!==4||profile.backend.uploadStats.sourceUploads!==1)throw new Error('Four-view source reuse failed');
      const pixels=await Promise.all([original.target,...targets].map(target=>readOutput(device,target)));
      if(pixels.some(pixel=>!pixel.slice(0,3).some(v=>v>0)||pixel.some((v,i)=>v!==pixels[0][i])))await fail(0,pixels,null);
      for(let frame=1;frame<576;frame++) {
        if(frame>=512 && frame%8===0){
          if(profile.backend.uploadStats.sourceUploads!==1)throw new Error('Static source uploaded repeatedly before profile teardown');
          profile=await activate();
        }
        await runRealRendererBenchmarkFrame(state);
        const next=await Promise.all([original.target,...targets].map(target=>readOutput(device,target)));
        if(next.some(pixel=>pixel.some((v,i)=>v!==pixels[0][i]))) {
          await fail(frame,next,pixels);
        }
      }
      if(profile.backend.uploadStats.sourceUploads!==1)throw new Error('Static multi-view source was uploaded repeatedly');
      results.push({id:'four-view-source-reuse',frames:576,profileActivations:9,viewCount:render3d.lastViewCount,sourceUploads:profile.backend.uploadStats.sourceUploads,pixels});
    } finally {state.views.splice(0,state.views.length,original);for(const target of targets)target.destroy();}
  } finally {state.views[0]=original;}
  return results;
}

async function readOutput(device,target) {
  const buffer=device.createBuffer({size:256,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
  try {
    const encoder=device.createCommandEncoder();encoder.copyTextureToBuffer({texture:target.colorTexture,origin:[32,32]},{buffer,bytesPerRow:256},{width:1,height:1});
    device.queue.submit([encoder.finish()]);await buffer.mapAsync(GPUMapMode.READ);const value=Array.from(new Uint8Array(buffer.getMappedRange()).slice(0,4));buffer.unmap();return value;
  } finally {buffer.destroy();}
}

async function inspectOutput(device,target) {
  const buffer=device.createBuffer({size:64*256,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
  try {
    const encoder=device.createCommandEncoder();encoder.copyTextureToBuffer({texture:target.colorTexture},{buffer,bytesPerRow:256},{width:64,height:64});
    device.queue.submit([encoder.finish()]);await buffer.mapAsync(GPUMapMode.READ);
    const bytes=new Uint8Array(buffer.getMappedRange()),center=Array.from(bytes.slice((32*64+32)*4,(32*64+32)*4+4));
    let transparent=0;for(let i=3;i<bytes.length;i+=4)if(bytes[i]===0)transparent++;
    buffer.unmap();return {center,transparent,pixels:64*64};
  } finally {buffer.destroy();}
}
