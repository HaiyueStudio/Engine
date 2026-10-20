import {createRealRendererBenchmarkScenario,runRealRendererBenchmarkFrame,destroyRealRendererBenchmarkScenario,createAuditTarget,resetRealRendererBenchmarkMetrics,
  Entity,PointLight,Transform3D,Mesh3D,Geometry3D,PbrMaterial,createDeferredReferenceProfile} from '../../artifacts/engine-0.2.1/g04/fixture.js';
import {COMPATIBILITY_MATERIALS,COMPATIBILITY_LIGHT_COUNTS} from './deferred-compatibility-policy.mjs';
import {readFloatTexture} from './float-texture-readback.mjs';
const node=document.querySelector('#result'),progress=document.querySelector('#progress');
try{node.textContent=JSON.stringify(await run());node.dataset.status='passed';}
catch(error){node.textContent=JSON.stringify({schemaVersion:2,status:'failed',error:error.stack??String(error)});node.dataset.status='failed';}
function compare(actual,expected,label,{rgbOnly=false,requireLit=true}={}) {
  let maxDelta=0,litPixels=0;
  for(let i=0;i<expected.length;i++){
    if(rgbOnly&&i%4===3)continue;
    const delta=Math.abs(actual[i]-expected[i]);maxDelta=Math.max(delta,maxDelta);
    if(!Number.isFinite(actual[i])||delta>Math.max(.003,Math.abs(expected[i])*.005))throw Error(`${label}: channel ${i}: ${actual[i]} != ${expected[i]}; center=${Array.from(actual.slice(8320,8324))} expected=${Array.from(expected.slice(8320,8324))}`);
    if(i%4===0&&actual[i]+actual[i+1]+actual[i+2]>.001)litPixels++;
  }
  if(requireLit&&litPixels<1024)throw Error(`${label}: insufficient visible coverage ${litPixels}`);
  return {maxDelta,litPixels};
}
async function run(){
  const preference=new URLSearchParams(location.search).get('powerPreference')??'high-performance';
  const adapter=await navigator.gpu.requestAdapter({powerPreference:preference});
  if(!adapter||adapter.info.isFallbackAdapter)throw Error('Native adapter required');
  const device=await adapter.requestDevice(),errors=[];
  device.addEventListener('uncapturederror',event=>errors.push(event.error.message));device.pushErrorScope('validation');
  const target=createAuditTarget(device,64,64,true);let state,result,failure;const textures=[];
  try{
    state=await createRealRendererBenchmarkScenario({device,target,entityCount:0,viewCount:1,renderProfile:'batched'});
    for(const entity of [...state.world.entities.values()])if(!entity.name.startsWith('real-camera:'))state.world.removeEntity(entity);
    state.render3d.passes.length=0;
    const geometry=new Geometry3D({positions:new Float32Array([-8,-8,0,8,-8,0,8,8,0,-8,-8,0,8,8,0,-8,8,0]),normals:new Float32Array(Array.from({length:6},()=>[0,0,1]).flat()),textureCoordinates:[{set:0,data:new Float32Array([0,1,1,1,1,0,0,1,1,0,0,0])}]});
    // Distinct depths/colors reveal sorting, opaque occlusion and accidental double shading.
    const surfaces=[
      {z:0,color:[.5,.3,.2,1],alphaMode:'opaque'},
      {z:.4,color:[.15,.7,.2,.4],alphaMode:'blend'},
      {z:.8,color:[.2,.25,.8,.6],alphaMode:'blend'},
      {z:-.5,color:[1,0,0,.8],alphaMode:'blend'},
    ];
    const materials=surfaces.map(s=>new PbrMaterial({baseColor:s.color,alphaMode:s.alphaMode,metallic:0,roughness:.6}));
    const transforms=[];
    for(const [i,s] of surfaces.entries())state.world.add(new Entity(`surface:${i}`).addComponent((transforms[i]=new Transform3D().setTranslation(0,0,s.z)))
      .addComponent(new Mesh3D(geometry,materials[i])));
    const lights=Array.from({length:128},(_,i)=>{
      const entity=new Entity(`point:${i}`).addComponent(new Transform3D().setTranslation(Math.sin(i)*2,Math.cos(i)*2,3))
        .addComponent(new PointLight({intensity:.05,range:12}));state.world.add(entity);return entity;
    });
    state.render3d.checkEntityManager(state.world);
    // Initialize HDR through the Deferred owner, then use unmodified Forward for the oracle.
    await createDeferredReferenceProfile(state.render3d,state.engine);resetRealRendererBenchmarkMetrics(state);await runRealRendererBenchmarkFrame(state);
    const texture=(rgba)=>{const t=device.createTexture({size:[1,1],format:'rgba8unorm',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST});device.queue.writeTexture({texture:t},new Uint8Array(rgba),{bytesPerRow:4},{width:1,height:1});textures.push(t);return t;};
    const factors=texture([180,140,100,200]),normal=texture([150,120,245,255]);
    const mask=device.createTexture({size:[2,2],format:'rgba8unorm',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST});
    device.queue.writeTexture({texture:mask},new Uint8Array([255,255,255,0,255,255,255,255,255,255,255,255,255,255,255,0]),{bytesPerRow:8},{width:2,height:2});textures.push(mask);
    const cases=[],contributions=[];
    for(const materialCase of COMPATIBILITY_MATERIALS){
    const opaque=materialCase.startsWith('opaque-'),fullIndex=materialCase.endsWith('-proxy')?2:1;
    for(const [i,material] of materials.entries()){
      material.alphaMode=i===0?'opaque':'blend';material.baseColorTexture=null;
      transforms[i].setTranslation(0,0,surfaces[i].z);
    }
    if(opaque){
      materials[1].alphaMode='opaque';materials[2].alphaMode='opaque';
      transforms[fullIndex].setTranslation(0,0,.8);transforms[3-fullIndex].setTranslation(0,0,materialCase.includes('coplanar')?.8:.4);
      if(materialCase.endsWith('-mask')){materials[fullIndex].alphaMode='mask';materials[fullIndex].alphaCutoff=.2;materials[fullIndex].baseColorTexture=mask;}
    }
    for(const [materialIndex,material] of materials.entries()){
      Object.assign(material,{clearcoatFactor:0,clearcoatTexture:null,clearcoatRoughnessTexture:null,clearcoatNormalTexture:null,
        transmissionFactor:0,transmissionTexture:null,thicknessFactor:0,thicknessTexture:null,attenuationDistance:Infinity,attenuationColor:[1,1,1],
        ior:1.5,specularFactor:1,specularColorFactor:[1,1,1],specularTexture:null,specularColorTexture:null,sheenColorFactor:[0,0,0],sheenColorTexture:null,sheenRoughnessTexture:null});
      if(materialIndex===0||(opaque?materialIndex!==fullIndex:false))continue;
      if(materialCase.includes('clearcoat'))Object.assign(material,{clearcoatFactor:.7,clearcoatRoughness:.3,clearcoatTexture:factors,clearcoatRoughnessTexture:factors,clearcoatNormalTexture:normal});
      if(materialCase.includes('transmission'))Object.assign(material,{transmissionFactor:.75,transmissionTexture:factors,thicknessFactor:.4,thicknessTexture:factors,attenuationDistance:2,attenuationColor:[.7,.85,.95]});
      if(materialCase.endsWith('specular-sheen'))Object.assign(material,{ior:1.8,specularFactor:.6,specularColorFactor:[.8,.6,.9],specularTexture:factors,specularColorTexture:factors,sheenColorFactor:[.2,.1,.3],sheenRoughness:.4,sheenColorTexture:factors,sheenRoughnessTexture:factors});
    }
    state.render3d.setRenderProfile('batched');resetRealRendererBenchmarkMetrics(state);
    const sum=new Float64Array(64*64*4),expected=new Map([[0,sum.slice()]]);
    lights.forEach(light=>{light.disabled=true;});
    await runRealRendererBenchmarkFrame(state);
    expected.set(0,await readFloatTexture(device,state.render3d._postScenePasses._postRenderer.sceneTexture));
    for(let i=0;i<lights.length;i++){
      progress.textContent=`Original Forward independent light ${i+1}/128`;
      if(i)lights[i-1].disabled=true;lights[i].disabled=false;
      await runRealRendererBenchmarkFrame(state);
      const image=await readFloatTexture(device,state.render3d._postScenePasses._postRenderer.sceneTexture);
      const center=Array.from(image.slice((32*64+32)*4,(32*64+32)*4+3));
      if(!center.every(v=>Number.isFinite(v)&&v>0))throw Error(`Light ${i} has no independent contribution`);
      contributions.push({materialCase,entityId:lights[i].id,pixel:center});
      for(let c=0;c<sum.length;c++){if(c%4!==3)sum[c]+=image[c];else sum[c]=image[c];}
      if(COMPATIBILITY_LIGHT_COUNTS.includes(i+1))expected.set(i+1,sum.slice());
    }
    for(const algorithm of ['reference','tiled']){
      const profile=await createDeferredReferenceProfile(state.render3d,state.engine,algorithm==='tiled'?{tiled:{forceCulling:true}}:{});resetRealRendererBenchmarkMetrics(state);
      for(const count of COMPATIBILITY_LIGHT_COUNTS){
        progress.textContent=`${materialCase}/${algorithm}: ${count} lights with sorted transparent surfaces`;
        lights.forEach((light,i)=>{light.disabled=i>=count;});await runRealRendererBenchmarkFrame(state);
        const image=await readFloatTexture(device,state.render3d._postScenePasses._postRenderer.sceneTexture);
        const validation=await device.popErrorScope();if(validation)errors.push(validation.message);if(errors.length)throw Error(errors.join('\n'));device.pushErrorScope('validation');
        let comparison;try{comparison=compare(image,expected.get(count),`${materialCase}/${algorithm}/${count} independent Forward sum`,{requireLit:count>0});}catch(error){const g1=await readFloatTexture(device,profile.backend.lastAttachments.textures[1]);const depth=await readFloatTexture(device,profile.backend.lastAttachments.textures[3],true);throw Error(`${error.message}; G1=${Array.from(g1.slice(8320,8324))}, depth=${depth[8320]}, opaqueIndices=${profile.backend._opaqueForwardIndices}, draws=${state.audit.draws}`);}
        if(profile.backend.lastSource.stats.pointCount!==count||!profile.backend.diagnostics.completeCoverage)throw Error('Complete light table was not used');
        cases.push({id:'sorted-transparent-independent-sum',materialCase,algorithm,count,...comparison,passes:profile.backend.passes,completeCoverage:true});
      }
    }
    }
    const validation=await device.popErrorScope();if(validation)errors.push(validation.message);if(errors.length)throw Error(errors.join('\n'));
    return result={schemaVersion:2,status:'passed',scope:'G04 transparent and opaque proxy full-list pixel diagnostic; effects and lifecycle remain separate',
      adapter:{vendor:adapter.info.vendor,architecture:adapter.info.architecture,isFallbackAdapter:adapter.info.isFallbackAdapter},cases,contributions,validationErrors:errors};
  }catch(error){failure=error;throw error;}finally{
    try{if(state){await destroyRealRendererBenchmarkScenario(state);if(result)result.cleanup={ownerResidual:state.finalMetrics.ownerResidual,liveGpuResources:state.finalMetrics.liveGpuResources};}}
    catch(error){if(!failure)throw error;failure.stack+=`\nCleanup also failed: ${error.stack}`;}
    finally{for(const t of textures)t.destroy();target.destroy();device.destroy();}
  }
}
