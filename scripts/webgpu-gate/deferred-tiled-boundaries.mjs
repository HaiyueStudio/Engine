import {Camera3D,Mesh3D,Entity,PointLight,Transform3D,createDeferredReferenceProfile,runRealRendererBenchmarkFrame,resetRealRendererBenchmarkMetrics,mat4} from '../../artifacts/engine-0.2.1/g03/fixture.js';
import {readFloatTexture} from './float-texture-readback.mjs';
import {validateTileMembership} from './deferred-tile-oracle.mjs';

export async function verifyTiledBoundaries({state,lights,receiver,readTiles}){
  const {device,render3d}=state,original=state.views[0],camera=original.camera;
  const jitterOwner=render3d._postScenePasses,originalJitter=jitterOwner.resolveProjectionJitter;
  const results=[],material=receiver.getComponent(Mesh3D).material;
  const originalMaterial={roughness:material.roughness,metallic:material.metallic};
  const reset=()=>{
    state.views[0]=original;receiver.disabled=false;
    material.roughness=originalMaterial.roughness;material.metallic=originalMaterial.metallic;
    camera.getComponent(Transform3D).setTranslation(0,0,8);
    camera.addComponent(new Camera3D({near:.1,far:100}));
    jitterOwner.resolveProjectionJitter=originalJitter;
    lights.forEach((light,i)=>{light.disabled=i>=128;light.getComponent(Transform3D).setTranslation((i%16)-7.5,Math.floor(i/16)-3.5,2);const point=light.getComponent(PointLight);point.range=3;point.intensity=.05;});
  };
  const capture=async(profile)=>{
    resetRealRendererBenchmarkMetrics(state);await runRealRendererBenchmarkFrame(state);
    const hdr=await readFloatTexture(device,render3d._postScenePasses._postRenderer.sceneTexture);
    const ldr=await readFloatTexture(device,original.target.colorTexture);
    const g1=await readFloatTexture(device,profile.backend.lastAttachments.textures[1]);
    let geometryPixels=0;for(let i=0;i<g1.length;i+=4)if(g1[i]**2+g1[i+1]**2+g1[i+2]**2>.5)geometryPixels++;
    return {hdr,ldr,geometryPixels};
  };
  const pair=async(id,{expectGeometry=true,tiled={},afterReference}={})=>{
    document.querySelector('#progress').textContent=`Boundary ${id}`;
    const refProfile=await createDeferredReferenceProfile(render3d,state.engine),reference=await capture(refProfile);
    const profile=await createDeferredReferenceProfile(render3d,state.engine,{tiled:{forceCulling:true,...tiled}});
    if(afterReference)await afterReference(profile);
    const actual=await capture(profile);
    let maxHdrDelta=0,maxLdrDelta=0;
    for(let i=0;i<actual.hdr.length;i++){
      const delta=Math.abs(actual.hdr[i]-reference.hdr[i]);maxHdrDelta=Math.max(maxHdrDelta,delta);
      maxLdrDelta=Math.max(maxLdrDelta,Math.abs(actual.ldr[i]-reference.ldr[i])*255);
      if(!Number.isFinite(actual.hdr[i])||delta>Math.max(.002,Math.abs(reference.hdr[i])*.002))throw Error(`${id}: HDR mismatch at ${i}`);
    }
    if(maxLdrDelta>2.001)throw Error(`${id}: LDR mismatch ${maxLdrDelta}`);
    if(expectGeometry&&Math.min(reference.geometryPixels,actual.geometryPixels)<1024)throw Error(`${id}: missing receiver`);
    const diagnostics=profile.backend.tileDiagnostics;
    const membership=validateTileMembership(await readTiles(device,diagnostics.binding),diagnostics.plan,profile.backend.lastSource,mat4.inverse(render3d._viewProjMatrix),64,64);
    const validation=await device.popErrorScope();device.pushErrorScope('validation');if(validation)throw Error(`${id}: ${validation.message}`);
    results.push({id,maxHdrDelta,maxLdrDelta,geometryPixels:actual.geometryPixels,source:profile.backend.lastSource.stats,membership});
    return {profile,membership};
  };
  try{
    for(const type of ['perspective','orthographic'])for(const reverseZ of [false,true])for(const remap of [false,true]){
      reset();camera.addComponent(new Camera3D(type==='perspective'?{near:.1,far:100}:{type,left:-8,right:8,bottom:-8,top:8,near:.1,far:100}));
      state.views[0]={...original,reverseZ,depthConvention:reverseZ?'reverse':'standard',viewport:remap?{x:0,y:0,width:64,height:64,minDepth:.2,maxDepth:.8}:null};
      jitterOwner.resolveProjectionJitter=(_passes,_context,out)=>{out[0]=.375;out[1]=-.25;return out;};
      await pair(`cull-${type}-${reverseZ?'reverse':'standard'}-${remap?'remapped':'default'}-jitter`);
    }
    reset();lights[0].getComponent(Transform3D).setTranslation(0,0,7.95);lights[0].getComponent(PointLight).range=.2;
    await pair('cull-near-plane');
    reset();lights[0].getComponent(Transform3D).setTranslation(0,0,8);lights[0].getComponent(PointLight).range=10;
    await pair('cull-inside-light');
    reset();lights.forEach(light=>{light.disabled=false;light.getComponent(Transform3D).setTranslation(-.5,.5,.1);light.getComponent(PointLight).range=.2;});
    const cluster=await pair('cull-all-in-one-tile');
    if(cluster.membership.heatmap.filter(tile=>tile.count>0).length!==1||cluster.membership.overflowTiles!==1)throw Error('Cluster did not isolate one overflowing tile');
    reset();lights.forEach(light=>{light.getComponent(Transform3D).setTranslation(1e5,1e5,1e5);light.getComponent(PointLight).range=1;});
    const empty=await pair('cull-empty-tile');if(empty.membership.references!==0)throw Error('Offscreen spheres were not rejected');
    reset();receiver.disabled=true;await pair('cull-empty-background',{expectGeometry:false});
    reset();lights[0].getComponent(PointLight).range=1e-6;lights[1].getComponent(PointLight).range=1e6;lights[2].getComponent(Transform3D).setTranslation(1e5,0,0);lights[2].getComponent(PointLight).range=1e5;
    await pair('cull-extreme-range');
    reset();lights[0].getComponent(Transform3D).setTranslation(-.2,0,2);lights[0].getComponent(PointLight).range=.2;
    await pair('cull-tangent-boundary');
    // Keep the Tiled provider alive while content changes, then compare with the restored reference.
    reset();await pair('cull-source-mutation',{afterReference:async()=>{
      const light=lights[0],point=light.getComponent(PointLight);const initial=point.intensity;
      light.disabled=true;resetRealRendererBenchmarkMetrics(state);await runRealRendererBenchmarkFrame(state);
      light.disabled=false;point.intensity=initial*2;resetRealRendererBenchmarkMetrics(state);await runRealRendererBenchmarkFrame(state);
      point.intensity=initial;
    }});
    reset();const removed=lights[8];
    const mutation=await pair('cull-source-add-remove',{afterReference:async profile=>{
      state.world.removeEntity(removed);resetRealRendererBenchmarkMetrics(state);await runRealRendererBenchmarkFrame(state);
      if(profile.backend.lastSource.stats.pointCount!==127)throw Error('Removed light remains in source');
      const replacement=new Entity('replacement-tile-light').addComponent(new Transform3D().setTranslation(.5,-3.5,2)).addComponent(new PointLight({intensity:.05,range:3}));
      state.world.add(replacement);lights[8]=replacement;
    }});
    if(mutation.profile.backend.lastSource.entityIds.includes(removed.id)||!mutation.profile.backend.lastSource.entityIds.includes(lights[8].id))throw Error('Stale identity after light replacement');
    // BRDF specialization must preserve both the compact and full-list loops,
    // including zero contribution behind the surface and outside a light range.
    for(const roughness of [0,.001,.05,.6,1])for(const metallic of [0,.5,1])for(const mode of ['compact','full-list']){
      reset();material.roughness=roughness;material.metallic=metallic;
      lights.forEach((light,i)=>{light.disabled=false;light.getComponent(Transform3D).setTranslation((i%16)-7.5,Math.floor(i/16)-7.5,i%3===1?-2:2);light.getComponent(PointLight).range=i%3===2?.01:40;});
      await pair(`point-brdf-${roughness}-${metallic}-${mode}`,{tiled:mode==='full-list'?{maxTileRecords:0}:{}});
    }
    return results;
  }finally{reset();camera.getComponent(Transform3D).setTranslation(0,0,16);}
}
