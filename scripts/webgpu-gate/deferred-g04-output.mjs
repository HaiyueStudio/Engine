import {createRealRendererBenchmarkScenario,runRealRendererBenchmarkFrame,destroyRealRendererBenchmarkScenario,createAuditTarget,resetRealRendererBenchmarkMetrics,Entity,Transform3D,Camera3D,RenderView,Mesh3D,Geometry3D,PbrMaterial,ColorLinear,BasicMaterial,PlanarMirror,MeshHelper,createDeferredReferenceProfile,TaaPass,RttEngine} from '../../artifacts/engine-0.2.1/g04/fixture.js';
import {readFloatTexture,createFloatTextureReadback} from './float-texture-readback.mjs';
const check=(v,m)=>{if(!v)throw Error(m);};
const encode=v=>v<=.0031308?v*12.92:1.055*v**(1/2.4)-.055,display=v=>encode(v/(1+v));
function quad(){return new Geometry3D({positions:new Float32Array([-.9,-.9,0,.9,-.9,0,.9,.9,0,-.9,.9,0]),normals:new Float32Array([0,0,1,0,0,1,0,0,1,0,0,1]),indices:new Uint32Array([0,1,2,0,2,3])});}
async function pixel(device,texture){const values=await readFloatTexture(device,texture);return Array.from(values.slice((Math.floor(texture.height/2)*texture.width+Math.floor(texture.width/2))*4,(Math.floor(texture.height/2)*texture.width+Math.floor(texture.width/2))*4+4));}
function near(a,b,label){check(a.every((v,i)=>Number.isFinite(v)&&Math.abs(v-b[i])<=.008),`${label}: ${a} != ${b}`);}
export async function runG04Output(device){const cases=[];
 for(const algorithm of ['reference','tiled']){
 const target=createAuditTarget(device,64,64,true),owned=[];let state,failure,result;
 try{
  state=await createRealRendererBenchmarkScenario({device,target,entityCount:0,renderProfile:'batched'});
  for(const e of [...state.world.entities.values()])state.world.removeEntity(e);state.render3d.passes.length=0;
  const camera=new Entity('output-camera').addComponent(new Transform3D().setTranslation(0,0,3)).addComponent(new Camera3D({type:'orthographic',left:-1,right:1,bottom:-1,top:1,near:.1,far:10}));state.world.add(camera);
  const material=new PbrMaterial({baseColor:[0,0,0,1],metallic:1,emissiveFactor:[4,2,1],doubleSided:true}),mesh=new Mesh3D(quad(),material),object=new Entity('emitter').addComponent(new Transform3D()).addComponent(mesh);state.world.add(object);
  const hdr=new RttEngine(state.engine,32,32,undefined,'g04.hdr',null,'rgba16float');owned.push(hdr);
  const mainView=new RenderView({key:'display',camera,target}).snapshot(),hdrView=new RenderView({key:'hdr',camera,target:hdr}).snapshot();state.views=[mainView,hdrView];state.render3d.checkEntityManager(state.world);
  const options={...(algorithm==='tiled'?{tiled:{forceCulling:true}}:{}),failurePolicy:'forward'},profile=await createDeferredReferenceProfile(state.render3d,state.engine,options),views=[];
  const debug=[];const record=profile.backend.record.bind(profile.backend);profile.backend.record=input=>{const prepare=input.prepareTransparent;input.prepareTransparent=()=>{prepare();const renderer=state.render3d._postScenePasses._postRenderer;for(const texture of [renderer.sceneTexture,renderer._buf1]){const rb=createFloatTextureReadback(device,texture);rb.encode(input.context.encoder);debug.push({key:input.view.key,rb,width:texture.width,height:texture.height});}};const r=record(input);views.push({key:input.view.key,...profile.backend.diagnostics});return r;};resetRealRendererBenchmarkMetrics(state);
  async function frame(id,expected,expectedHdr=[4,2,1,1]){views.length=0;await runRealRendererBenchmarkFrame(state);const validation=await device.popErrorScope();device.pushErrorScope('validation');if(validation)throw Error(`${id}: ${validation.message}`);const color=await pixel(device,target.colorTexture),linear=await pixel(device,hdr.colorTexture);let sceneColorCopies;if(id==='transmission-linear-copy'){const evidence=[];for(const x of debug){const data=await x.rb.read();evidence.push({key:x.key,pixel:Array.from(data.slice((Math.floor(x.height/2)*x.width+Math.floor(x.width/2))*4,(Math.floor(x.height/2)*x.width+Math.floor(x.width/2))*4+4))});x.rb.destroy();}debug.length=0;for(const entry of evidence)near(entry.pixel,[4,2,1,1],`${id}/${entry.key}/copy`);sceneColorCopies=evidence;}near(color,expected,id);near(linear,expectedHdr,`${id}/hdr`);check(views.length===2&&views.every(v=>v.completeCoverage),`${id}: child coverage`);cases.push({id,algorithm,color,linear,sceneColorCopies,views:[...views]});}
  await frame('hdr-rtt',[display(4),display(2),display(1),1]);
  material.clearcoatFactor=.5;await frame('opaque-proxy-hdr',[display(4),display(2),display(1),1]);
  const taa=new TaaPass({jitterScale:0,sharpness:0});state.render3d.passes.push(taa);
  await frame('taa-hdr',[display(4),display(2),display(1),1]);
  const history=taa._historyStore.histories.get('display');near(await pixel(device,history.colors[history.readIndex]),[4,2,1,1],'linear history');
  state.render3d.exposure=.5;await frame('exposure-once',[display(2),display(1),display(.5),1]);near(await pixel(device,history.colors[history.readIndex]),[4,2,1,1],'exposure history');
  state.render3d.exposure=1;state.render3d.passes.length=0;taa.destroy();
  const glass=new Entity('transmission').addComponent(new Transform3D().setTranslation(0,0,.2)).addComponent(new Mesh3D(quad(),new PbrMaterial({baseColor:[1,1,1,1],metallic:0,transmissionFactor:1,ior:1,specularFactor:0,roughness:0})));
  state.world.add(glass);state.render3d.checkEntityManager(state.world);await frame('transmission-linear-copy',[display(4),display(2),display(1),1]);state.world.removeEntity(glass);
  state.views=[mainView];
  // Unsupported whole-view surfaces retain truthful diagnostics and the original output.
  mesh.material=new BasicMaterial({color:new ColorLinear(4,2,1)});state.render3d.checkEntityManager(state.world);views.length=0;await runRealRendererBenchmarkFrame(state);
  near(await pixel(device,target.colorTexture),[display(4),display(2),display(1),1],'basic fallback');check(views[0].effective==='forward'&&!views[0].completeCoverage&&views[0].reason==='unsupported-material-surface','false Basic coverage');cases.push({id:'basic-fallback',algorithm,views:[...views]});
  mesh.material=material;object.addComponent(new MeshHelper());views.length=0;await runRealRendererBenchmarkFrame(state);check(views[0].reason==='unsupported-forward-surface'&&!views[0].completeCoverage,'false helper coverage');cases.push({id:'helper-fallback',algorithm,views:[...views]});object.removeComponent(MeshHelper);
  const mirror=new PlanarMirror({width:64,height:64,maxBounces:1,localNormal:[0,0,1]});state.world.add(new Entity('mirror').addComponent(new Transform3D().setTranslation(0,0,-1)).addComponent(new Mesh3D(quad(),new BasicMaterial())).addComponent(mirror));state.render3d.checkEntityManager(state.world);
  views.length=0;await runRealRendererBenchmarkFrame(state);const reflection=mirror.material.getReflection(mainView.key);check(reflection?.texture.format==='rgba16float','reflection HDR target');
  const reflected=await readFloatTexture(device,reflection.texture);check(reflected.some((r,i)=>i%4===0&&Math.abs(r-4)<.02&&Math.abs(reflected[i+1]-2)<.02&&Math.abs(reflected[i+2]-1)<.02),'reflection lost radiance');
  check(views.some(v=>v.key==='display'&&v.effective==='forward'&&!v.completeCoverage)&&views.some(v=>v.key!=='display'&&v.completeCoverage),'reflection child/main diagnostics');cases.push({id:'reflection-child',algorithm,views:[...views],reflectionFormat:reflection.texture.format});
  result={algorithm};
 }catch(error){failure=error;throw error;}finally{if(state){try{await destroyRealRendererBenchmarkScenario(state);}catch(error){if(!failure)throw error;failure.stack+=`\nCleanup: ${error.stack}`;}if(result)result.cleanup={ownerResidual:state.finalMetrics.ownerResidual,liveGpuResources:state.finalMetrics.liveGpuResources};}for(const resource of owned)resource.destroy();target.destroy();}
 check(result.cleanup.ownerResidual===0&&result.cleanup.liveGpuResources===0,'output residue');for(const c of cases.filter(c=>c.algorithm===algorithm))c.cleanup=result.cleanup;
 }
 return {cases};
}
