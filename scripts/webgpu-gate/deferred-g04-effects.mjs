import {createRealRendererBenchmarkScenario,runRealRendererBenchmarkFrame,destroyRealRendererBenchmarkScenario,createAuditTarget,resetRealRendererBenchmarkMetrics,
  Entity,PointLight,DirectionalLight,AmbientLight,EnvironmentLight,Fog,Transform3D,Camera3D,RenderView,Mesh3D,Geometry3D,PbrMaterial,OutlineTarget,
  createBox3D,createDeferredReferenceProfile,GtaoPass,SaoPass,SsaoPass,OutlinePass,TaaPass,MotionBlurPass} from '../../artifacts/engine-0.2.1/g04/fixture.js';
import {readFloatTexture} from './float-texture-readback.mjs';
import {G04_EFFECT_CASES,G04_AO_MODES} from './deferred-g04-suite-policy.mjs';
const check=(value,message)=>{if(!value)throw Error(message);};
const identity=()=>new Float32Array([1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]);
function quad(size=1){return new Geometry3D({positions:new Float32Array([-size,-size,0,size,-size,0,size,size,0,-size,size,0]),normals:new Float32Array([0,0,1,0,0,1,0,0,1,0,0,1]),textureCoordinates:[{set:0,data:new Float32Array([0,0,1,0,1,1,0,1])}],indices:new Uint32Array([0,1,2,0,2,3])});}
class TemporalProbe extends TaaPass {
  setSceneTextures(textures){super.setSceneTextures(textures);this.observed=textures;}
}
async function capture(device,id,algorithm,aoEnabled=true,lightMode='mixed'){
  const target=createAuditTarget(device,64,64,true),owned=[];let state,result,failure;
  try{
    state=await createRealRendererBenchmarkScenario({device,target,entityCount:0,renderProfile:'batched'});
    for(const entity of [...state.world.entities.values()])state.world.removeEntity(entity);
    const camera=new Entity('effects-camera').addComponent(new Transform3D().setTranslation(0,0,4)).addComponent(new Camera3D({type:'orthographic',left:-2,right:2,bottom:-2,top:2,near:.1,far:20}));
    state.world.add(camera);state.views=[new RenderView({key:'g04-effects',camera,target}).snapshot()];
    state.render3d.passes.length=0;
    const background=new Entity('background').addComponent(new Transform3D()).addComponent(new Mesh3D(quad(2),new PbrMaterial({baseColor:[.6,.5,.35,1],roughness:.8,metallic:0})));
    state.world.add(background);
    const moving=new Transform3D(),material=new PbrMaterial({baseColor:[.2,.6,.35,1],roughness:.4,metallic:0,clearcoatFactor:.5,clearcoatRoughness:.2});
    const geometry=id==='deformed'?quad(.45):createBox3D({width:.9,height:.9,depth:.8});
    if(id==='deformed'){
      // The same skin/morph geometry flows through opaque proxy, shadow and temporal passes.
      geometry.setMorphTargets([{positions:new Float32Array([.3,0,0,.3,0,0,.3,0,0,.3,0,0])}]);
      geometry.setSkinning({joints:new Float32Array(16),weights:new Float32Array([1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0]),jointMatrices:identity()});
      material.doubleSided=true;
    }
    const object=new Entity('moving-extended-pbr').addComponent(moving).addComponent(new Mesh3D(geometry,material)).addComponent(new OutlineTarget());state.world.add(object);
    state.world.add(new Entity('transparent-front').addComponent(new Transform3D().setTranslation(.8,-.1,1.2)).addComponent(new Mesh3D(quad(.45),new PbrMaterial({baseColor:[.2,.25,.8,.45],alphaMode:'blend',roughness:.5}))));
    if(lightMode==='mixed'||lightMode.endsWith('direct'))for(let i=0;i<3;i++)state.world.add(new Entity(`sun:${i}`).addComponent(new Transform3D()).addComponent(new DirectionalLight({direction:[[.5,-.2,-1],[-.3,.4,-1],[0,-.5,-1]][i],intensity:.35,castShadow:id==='shadows',shadow:{extent:3,near:.1,far:20,mapSize:512}})));
    if(lightMode==='mixed'||lightMode.endsWith('direct'))for(let i=0;i<3;i++)state.world.add(new Entity(`point:${i}`).addComponent(new Transform3D().setTranslation(i-1,1,2)).addComponent(new PointLight({range:8,intensity:.2})));
    if(lightMode==='mixed'||lightMode==='ambient')state.world.add(new Entity('ambient').addComponent(new AmbientLight({intensity:lightMode==='ambient'?1:.4})));
    if(lightMode.endsWith('emission'))for(const e of state.world.entities.values()){const mesh=e.getComponent(Mesh3D);if(mesh)mesh.material.emissiveFactor=[2,1,.5];}
    if(lightMode.startsWith('transmission')){material.transmissionFactor=1;material.metallic=0;material.clearcoatFactor=0;}
    if(lightMode==='ibl')state.world.add(new Entity('analytic-environment').addComponent(new EnvironmentLight({intensity:1,diffuseColor:[1,1,1],specularColor:[.4,.4,.4]})));
    if(id==='fog')state.world.add(new Entity('fog').addComponent(new Fog({color:[.1,.2,.7],distanceStart:1,distanceEnd:5,maxOpacity:.65})));
    if(id==='ibl'){
      const cube=device.createTexture({size:[1,1,6],format:'rgba8unorm',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST});owned.push(cube);
      for(let z=0;z<6;z++)device.queue.writeTexture({texture:cube,origin:[0,0,z]},new Uint8Array([180,100,70,255]),{bytesPerRow:4},{width:1,height:1});
      state.world.add(new Entity('environment').addComponent(new EnvironmentLight({diffuseTexture:cube,specularTexture:cube,intensity:1.2,rotation:.4})));
    }
    const ao={gtao:GtaoPass,sao:SaoPass,ssao:SsaoPass}[id];if(ao&&aoEnabled)state.render3d.passes.push(new ao({radius:2,intensity:3,resolutionScale:1,quality:'high'}));
    if(id==='outline')state.render3d.passes.push(new OutlinePass({edgeStrength:2,edgeThickness:2,visibleEdgeColor:[1,.1,.2]}));
    let temporal;
    if(id==='taa-motion'||id==='deformed'){temporal=new TemporalProbe({sharpness:0});state.render3d.passes.push(new MotionBlurPass(),temporal);}
    state.render3d.checkEntityManager(state.world);
    let profile;if(algorithm!=='forward')profile=await createDeferredReferenceProfile(state.render3d,state.engine,algorithm==='tiled'?{tiled:{forceCulling:true}}:{});
    resetRealRendererBenchmarkMetrics(state);
    for(let frame=0;frame<5;frame++){
      moving.setTranslation(-.5+frame*.08,0,.4);
      if(id==='deformed'){
        const matrix=identity();matrix[0]=-1.3;matrix[5]=.7;matrix[12]=-.5+frame*.08;matrix[14]=.4;moving.setMatrix(matrix);
        geometry.setMorphWeights([frame*.15]);const pose=identity();pose[12]=frame*.03;geometry.updateSkinningMatrices(pose);
      }
      await runRealRendererBenchmarkFrame(state);
    }
    if(profile)check(profile.backend.diagnostics.completeCoverage,`${id}/${algorithm}: unexpected fallback`);
    if(ao&&aoEnabled)check(state.render3d.passes[0].stats.frameCount===5,`${id}/${algorithm}: public AO frame statistics lost`);
    const image=await readFloatTexture(device,target.colorTexture);
    check(image.every(Number.isFinite),`${id}/${algorithm}: non-finite pixels`);
    const pixels=Array.from(image,value=>Math.round(value*255));
    let temporalEvidence=null;
    if(temporal){const motion=await readFloatTexture(device,temporal.observed.motion);let movingPixels=0;for(let i=0;i<motion.length;i+=4)if(Math.abs(motion[i])+Math.abs(motion[i+1])>.00001&&motion[i+3]===1)movingPixels++;
      check(movingPixels>10,`${id}: missing valid motion`);check(temporal.stats.historyCount===1,`${id}: invalid history ownership`);temporalEvidence={movingPixels,historyCount:temporal.stats.historyCount};}
    let minAo=1;
    if(profile&&ao&&aoEnabled){const slot=[...profile.backend._ambientOcclusion._slots][0];const visibility=await readFloatTexture(device,slot.textures[0]);for(let i=0;i<visibility.length;i+=4)minAo=Math.min(minAo,visibility[i]);}
    result={id,algorithm,pixels,minAo,temporal:temporalEvidence,shadowPasses:state.render3d.lastDirectionalShadowPassCount,coverage:profile?.backend.diagnostics??{effective:'forward',completeCoverage:false}};
    if(id==='shadows')check(result.shadowPasses===3,`expected three directional shadow passes, got ${result.shadowPasses}`);
    return result;
  }catch(error){failure=error;throw error;}finally{
    if(state){try{await destroyRealRendererBenchmarkScenario(state);}catch(error){if(!failure)throw error;failure.stack+=`\nCleanup: ${error.stack}`;}if(result)result.cleanup={ownerResidual:state.finalMetrics.ownerResidual,liveGpuResources:state.finalMetrics.liveGpuResources};}
    for(const texture of owned)texture.destroy();target.destroy();
  }
}
export async function runG04Effects(device){
  const cases=[],baseline=new Map();
  for(const id of G04_EFFECT_CASES){
    for(const algorithm of ['forward','reference','tiled']){
      document.querySelector('#progress').textContent=`G04 ${id}/${algorithm}`;
      const result=await capture(device,id,algorithm);let maxDelta=0,changedPixels=0;
      if(algorithm==='forward')baseline.set(id,result.pixels);
      else if(!['gtao','sao','ssao'].includes(id)||algorithm==='tiled')for(let i=0;i<result.pixels.length;i++){maxDelta=Math.max(maxDelta,Math.abs(result.pixels[i]-baseline.get(['gtao','sao','ssao'].includes(id)?`${id}/reference`:id)[i]));check(maxDelta<=3,`${id}/${algorithm}: pixel ${i} differs by ${maxDelta}/255`);}
      if(algorithm==='reference')baseline.set(`${id}/reference`,result.pixels);
      if(id!=='none')for(let i=0;i<result.pixels.length;i+=4)if(result.pixels.slice(i,i+3).some((v,c)=>Math.abs(v-baseline.get('none')[i+c])>3))changedPixels++;
      if(id!=='none')check(changedPixels>5,`${id}/${algorithm}: effect produced no visible change; center=${result.pixels.slice(8320,8324)}, baseline=${baseline.get('none').slice(8320,8324)}, maxDifference=${Math.max(...result.pixels.map((v,i)=>Math.abs(v-baseline.get('none')[i])))}`);
      cases.push({...result,maxDelta,changedPixels});
    }
  }
  const lightingAo=[];
  for(const id of ['gtao','sao','ssao'])for(const algorithm of ['reference','tiled'])for(const mode of G04_AO_MODES){
    const off=await capture(device,id,algorithm,false,mode),on=await capture(device,id,algorithm,true,mode);
    let maxDelta=0,darkenedPixels=0,brightenedPixels=0;
    for(let i=0;i<on.pixels.length;i+=4){let darker=false,brighter=false;for(let c=0;c<3;c++){
      const delta=on.pixels[i+c]-off.pixels[i+c];maxDelta=Math.max(maxDelta,Math.abs(delta));darker ||= delta < -3;brighter ||= delta > 1;
    }darkenedPixels+=+darker;brightenedPixels+=+brighter;}
    check(on.minAo<.95,`${id}/${mode}: oracle has no real occlusion (${on.minAo})`);
    if(['ambient','ibl'].includes(mode))check(darkenedPixels>5&&brightenedPixels===0,`${id}/${mode}: indirect lighting was not selectively occluded (${darkenedPixels}/${brightenedPixels})`);
    else check(maxDelta<=1,`${id}/${mode}: protected contribution changed by ${maxDelta}/255`);
    lightingAo.push({id,algorithm,mode,maxDelta,darkenedPixels,brightenedPixels,minAo:on.minAo,offCleanup:off.cleanup,onCleanup:on.cleanup});
  }
  return {cases,lightingAo};
}
