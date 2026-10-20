import { verifyDeferredSubmissionOrdering } from './deferred-submission-fixture.mjs';
import { verifyVertexColors } from './deferred-vertex-color-fixture.mjs';
import { createDeferredRoomFixture } from './deferred-room-fixture.mjs';
import { verifyDeferredMaterials } from './deferred-material-fixture.mjs';
import { verifyDeferredViews } from './deferred-view-fixture.mjs';
import { createRealRendererBenchmarkScenario, runRealRendererBenchmarkFrame, destroyRealRendererBenchmarkScenario, createAuditTarget, resetRealRendererBenchmarkMetrics, Entity, PointLight, Transform3D, Mesh3D, Geometry3D, PbrMaterial, createDeferredReferenceProfile, createBox3D, Camera3D, ColorLinear, AmbientLight, DirectionalLight, mat4 } from '../../artifacts/engine-0.2.1/g02/fixture.js';
const node = document.querySelector('#result');
try { node.textContent = JSON.stringify(await run()); node.dataset.status = 'passed'; }
catch (error) { node.textContent = JSON.stringify({schemaVersion:1,status:'failed',error:error.stack??String(error)}); node.dataset.status = 'failed'; }
async function run() {
  document.querySelector('#progress').textContent='Requesting WebGPU adapter';
  const preference = new URLSearchParams(location.search).get('powerPreference') ?? 'high-performance';
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: preference });
  if (!adapter) throw new Error('Missing WebGPU adapter');
  const device = await adapter.requestDevice({requiredFeatures:adapter.features.has('indirect-first-instance')?['indirect-first-instance']:[]});
  const createModule=device.createShaderModule.bind(device);
  device.createShaderModule=descriptor=>{
    const module=createModule(descriptor),getInfo=module.getCompilationInfo.bind(module);
    module.getCompilationInfo=()=>{document.querySelector('#progress').textContent=`Compilation info: ${descriptor.label}`;return getInfo();};return module;
  };
  const createPipelineAsync=device.createRenderPipelineAsync.bind(device);
  device.createRenderPipelineAsync=descriptor=>{document.querySelector('#progress').textContent=`Async pipeline: ${descriptor.label}`;return createPipelineAsync(descriptor);};
  document.querySelector('#progress').textContent='Creating renderer scenario';
  const errors = []; device.addEventListener('uncapturederror', e => errors.push(e.error.message));
  void device.lost.then(info=>{if(info.reason!=='destroyed'){node.textContent=JSON.stringify({schemaVersion:1,status:'failed',error:`Device lost: ${info.message}`});node.dataset.status='failed';}});
  device.pushErrorScope('validation');
  const roomMode = new URLSearchParams(location.search).get('room') === '1';
  const target = createAuditTarget(device, roomMode ? 1280 : 64, roomMode ? 720 : 64, true);
  let state, result;
  try {
    // Standalone queue-order oracle precedes renderer audit installation: its
    // uploads are not renderer-frame work and must not pollute frame metrics.
    const submission = !roomMode && new URLSearchParams(location.search).get('full') === '1'
      ? await verifyDeferredSubmissionOrdering(device) : null;
    state = await createRealRendererBenchmarkScenario({ device, target, entityCount: 0, viewCount: 1, renderProfile: 'batched' });
    for (const entity of [...state.world.entities.values()]) if (!entity.name.startsWith('real-camera:')) state.world.removeEntity(entity);
    state.render3d.passes.length = 0;
    if (roomMode) return result=await runRoom(state, adapter, errors);
    const geometry = new Geometry3D({ positions: new Float32Array([-8,-8,0,8,-8,0,8,8,0,-8,-8,0,8,8,0,-8,8,0]), normals: new Float32Array(Array.from({length:6},()=>[0,0,1]).flat()), textureCoordinates: [{set:0,data:new Float32Array([0,1,1,1,1,0,0,1,1,0,0,0])},{set:1,data:new Float32Array(Array.from({length:6},()=>[.25,.5]).flat())}] });
    const material = new PbrMaterial({ baseColor: [.5,.3,.2,1], metallic: 0, roughness: .6 });
    const receiver=new Entity('receiver').addComponent(new Transform3D()).addComponent(new Mesh3D(geometry, material));state.world.add(receiver);
    const lights = Array.from({length:256},(_,i)=>{
      const entity = new Entity(`point:${i}`).addComponent(new Transform3D().setTranslation(Math.sin(i)*2,Math.cos(i)*2,3)).addComponent(new PointLight({ intensity:.05,range:12 }));
      state.world.add(entity); return entity;
    });
    const profile = await createDeferredReferenceProfile(state.render3d, state.engine);
    state.render3d.checkEntityManager(state.world);
    resetRealRendererBenchmarkMetrics(state);
    const cases = [];
    for (const count of [0,1,8,9,32,128,256]) {
      document.querySelector('#progress').textContent=`Rendering ${count} lights`;
      lights.forEach((light,i)=>{light.disabled=i>=count;});
      await runRealRendererBenchmarkFrame(state);
      const frameValidation = await device.popErrorScope();
      if (frameValidation || errors.length) throw new Error(frameValidation?.message ?? errors.join('\n'));
      device.pushErrorScope('validation');
      const hdr = state.render3d._postScenePasses._postRenderer.sceneTexture;
      const pixel = await readPixel(device,hdr,32,32);
      if (count && !pixel.slice(0,3).some(x=>x>0)) {
        const gbuffer = await Promise.all(profile.backend.lastAttachments.textures.slice(0,3).map(t=>readPixel(device,t,32,32)));
        throw new Error(`${count} lights produced no radiance: ${JSON.stringify({pixel,gbuffer,source:profile.backend.lastSource.stats,records:profile.backend.lastSource.records,
          renderStats:Object.fromEntries(Object.entries(state.render3d).filter(([k,v])=>k.startsWith('last')&&typeof v==='number')),
          draws:state.audit.draws,camera:state.views[0].camera.name,viewProj:Array.from(state.render3d._viewProjMatrix),geometry:{count:geometry.vertexCount,cullMode:geometry.cullMode,frontFace:geometry.frontFace}})}`);
      }
      if (!pixel.every(Number.isFinite)) throw new Error('Nonfinite HDR result');
      if (profile.backend.lastSource.stats.pointCount !== count) throw new Error('Source light loss');
      cases.push({count,pixel,source:profile.backend.lastSource.stats,diagnostics:profile.backend.diagnostics,passes:profile.backend.passes});
    }
    const geometryAssertions = [];
    const gbuffer = await Promise.all(profile.backend.lastAttachments.textures.slice(0,3).map(t=>readPixel(device,t,32,32)));
    const linearBase = new Float32Array(4);material.baseColor.writeLinear(linearBase);
    near(gbuffer[0], [...linearBase.slice(0,3),0], .001, .0005, 'G0 base/metallic');
    near(gbuffer[1], [0,0,1,.6], .001, .0005, 'G1 normal/roughness');
    near(gbuffer[2], [0,0,0,1], .001, .0005, 'G2 emissive/occlusion');
    geometryAssertions.push({id:'standard-surface',gbuffer});
    const oracle = [];
    if (new URLSearchParams(location.search).get('full') === '1') {
      const sum = [0,0,0], contributions = [];
      lights.forEach(light=>{light.disabled=true;});
      for (let i=0;i<lights.length;i++) {
        document.querySelector('#progress').textContent=`Independent contribution ${i+1}/256`;
        if(i)lights[i-1].disabled=true;
        lights[i].disabled=false;
        await runRealRendererBenchmarkFrame(state);
        const pixel=await readPixel(device,state.render3d._postScenePasses._postRenderer.sceneTexture,32,32);
        if(!pixel.slice(0,3).every(x=>Number.isFinite(x)&&x>0))throw new Error(`Missing independent contribution ${i}`);
        contributions.push({entityId:lights[i].id,gpuId:profile.backend.lastSource.records[0].identity[1],pixel});
        for(let c=0;c<3;c++)sum[c]+=pixel[c];
        const combined=cases.find(c=>c.count===i+1);
        if(combined){near(combined.pixel.slice(0,3),sum,.002,.002,`${i+1} independent light sum`);oracle.push({count:i+1,combined:combined.pixel.slice(0,3),singleLightSum:[...sum]});}
      }
      oracle.push({id:'all-independent-contributions',contributions});
      // The source beyond the legacy Forward cap must reflect live property edits.
      const last=lights.at(-1).getComponent(PointLight), originalIntensity=last.intensity;
      last.intensity*=2;
      await runRealRendererBenchmarkFrame(state);
      const updated=await readPixel(device,state.render3d._postScenePasses._postRenderer.sceneTexture,32,32);
      near(updated.slice(0,3),contributions.at(-1).pixel.slice(0,3).map(v=>v*2),.002,.002,'last light intensity update');
      last.range=.1;
      await runRealRendererBenchmarkFrame(state);
      near((await readPixel(device,state.render3d._postScenePasses._postRenderer.sceneTexture,32,32)).slice(0,3),[0,0,0],0,0,'last light range update');
      last.range=12;last.intensity=originalIntensity;
      lights.forEach(light=>{light.disabled=true;});
      material.emissiveFactor=[.03,.07,.11];
      await runRealRendererBenchmarkFrame(state);
      const emissive=await readPixel(device,state.render3d._postScenePasses._postRenderer.sceneTexture,32,32);
      near(emissive.slice(0,3),material.emissiveFactor,.001,.0005,'emissive without lights');
      lights.forEach((light,i)=>{light.disabled=i>=128;});
      await runRealRendererBenchmarkFrame(state);
      const litEmissive=await readPixel(device,state.render3d._postScenePasses._postRenderer.sceneTexture,32,32);
      near(litEmissive.slice(0,3),cases.find(c=>c.count===128).pixel.slice(0,3).map((v,c)=>v+emissive[c]),.002,.002,'emissive applied exactly once');
      geometryAssertions.push({id:'emissive-once',emissive,litEmissive});
      material.emissiveFactor=[0,0,0];material.alphaMode='mask';material.baseColor.a=.2;
      await runRealRendererBenchmarkFrame(state);
      const masked=await readPixel(device,state.render3d._postScenePasses._postRenderer.sceneTexture,32,32);
      near(masked.slice(0,3),[0,0,0],0,0,'alpha mask discard');
      geometryAssertions.push({id:'alpha-mask',pixel:masked});
      material.baseColor.a=1;material.alphaMode='opaque';
      geometryAssertions.push(...await verifyDeferredMaterials({state,profile,material,receiver,lights,cases,readPixel,near}));
      document.querySelector('#progress').textContent='Forward parity';
      state.render3d.setRenderProfile('batched');
      for(const count of [0,1,8]){
        lights.forEach((light,i)=>{light.disabled=i>=count;});
        await runRealRendererBenchmarkFrame(state);
        const forward=await readPixel(device,state.render3d._postScenePasses._postRenderer.sceneTexture,32,32),deferred=cases.find(c=>c.count===count).pixel;
        near(deferred,forward,.005,.003,`Forward parity ${count}`);
        oracle.push({id:'forward-parity',count,forward,deferred});
      }
      oracle.push(submission);
      oracle.push(...await verifyDeferredViews({state,lights,readPixel,near}));
      geometryAssertions.push(...await verifyVertexColors({state,receiver,material,lights,near}));
    }
    const validation = await device.popErrorScope();
    if (validation || errors.length) throw new Error(validation?.message ?? errors.join('\n'));
    return result={schemaVersion:1,status:'passed',scope:'production-path reference correctness; no performance or release qualification',adapter:{vendor:adapter.info.vendor,architecture:adapter.info.architecture,isFallbackAdapter:adapter.info.isFallbackAdapter},cases,geometryAssertions,oracle,validationErrors:errors};
  } finally {
    if(state){await destroyRealRendererBenchmarkScenario(state);if(result)result.cleanup={ownerResidual:state.finalMetrics.ownerResidual,liveGpuResources:state.finalMetrics.liveGpuResources};}
    target.destroy();device.destroy();
  }
}
async function readPixel(device, texture, x, y) {
  const buffer = device.createBuffer({size:256,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
  try {
    const encoder=device.createCommandEncoder(); encoder.copyTextureToBuffer({texture,origin:[x,y]},{buffer,bytesPerRow:256},{width:1,height:1});
    device.queue.submit([encoder.finish()]); await buffer.mapAsync(GPUMapMode.READ);
    const values=Array.from(new Uint16Array(buffer.getMappedRange()).slice(0,4),half);buffer.unmap();return values;
  } finally { buffer.destroy(); }
}
function half(bits){const sign=bits&32768?-1:1,e=(bits>>10)&31,m=bits&1023;return e===0?sign*m*2**-24:e===31?(m?NaN:sign*Infinity):sign*(1+m/1024)*2**(e-15);}
function near(actual,expected,relative,absolute,label){for(let i=0;i<expected.length;i++)if(!Number.isFinite(actual[i])||Math.abs(actual[i]-expected[i])>Math.max(absolute,Math.abs(expected[i])*relative))throw new Error(`${label} channel ${i}: ${actual[i]} != ${expected[i]}`);}
async function runRoom(state, adapter, errors) {
  const {device,world,render3d}=state;
  const fixture=createDeferredRoomFixture();
  const materials=fixture.materials.map(m=>new PbrMaterial({baseColor:new ColorLinear(...m.color),metallic:m.metallic,roughness:m.roughness}));
  const box=createBox3D();
  for(const [i,b] of fixture.boxes.entries())world.add(new Entity(`room-box:${i}`).addComponent(new Transform3D().setTranslation(...b.position)).addComponent(new Mesh3D(box,materials[b.material])));
  const surfaces=[
    {p:[[-12,0,-12],[-12,0,12],[12,0,12],[12,0,-12]],n:[0,1,0]},
    {p:[[-12,0,12],[-12,0,-12],[-12,8,-12],[-12,8,12]],n:[1,0,0]},
    {p:[[12,0,-12],[12,0,12],[12,8,12],[12,8,-12]],n:[-1,0,0]},
    {p:[[-12,0,-12],[12,0,-12],[12,8,-12],[-12,8,-12]],n:[0,0,1]},
    {p:[[12,0,12],[-12,0,12],[-12,8,12],[12,8,12]],n:[0,0,-1]},
  ];
  for(const [i,s] of surfaces.entries())world.add(new Entity(`room-surface:${i}`).addComponent(new Transform3D()).addComponent(new Mesh3D(new Geometry3D({positions:new Float32Array(s.p.flat()),normals:new Float32Array(Array.from({length:4},()=>s.n).flat()),indices:new Uint32Array([0,1,2,0,2,3])}),materials[6])));
  const camera=state.views[0].camera;
  camera.addComponent(new Camera3D({type:'perspective',fov:Math.PI/3,near:.1,far:100}));
  world.add(new Entity('room-ambient').addComponent(new AmbientLight({intensity:.1})));
  world.add(new Entity('room-directional').addComponent(new DirectionalLight({direction:fixture.directional.direction,intensity:.5})));
  const lights=fixture.lights.map((p,i)=>{
    const transform=new Transform3D().setTranslation(...p.position),light=new PointLight({color:new ColorLinear(...p.color),intensity:2,range:2});
    const entity=new Entity(`room-point:${i}`).addComponent(transform).addComponent(light);world.add(entity);return {entity,transform,light};
  });
  render3d.checkEntityManager(world);
  const profile=await createDeferredReferenceProfile(render3d,state.engine);
  resetRealRendererBenchmarkMetrics(state);
  const cases=[];
  for(const [count,frame,overlap] of [[128,0,false],[256,0,false],[128,37,true],[256,37,true]]){
    const data=createDeferredRoomFixture({count:256,frame,overlap});
    camera.getComponent(Transform3D).setMatrix(mat4.cameraAim(data.cameras[0].position,data.cameras[0].target,[0,1,0]));
    for(let i=0;i<lights.length;i++){const light=lights[i],p=data.lights[i];light.entity.disabled=i>=count;light.transform.setTranslation(...p.position);light.light.range=p.range;}
    await runRealRendererBenchmarkFrame(state);
    const validation=await device.popErrorScope();if(validation||errors.length)throw new Error(validation?.message??errors.join('\n'));device.pushErrorScope('validation');
    const source=profile.backend.lastSource;
    if(source.stats.pointCount!==count||source.stats.directionalCount!==1||source.stats.ambientCount!==1)throw new Error('Room source counts lost lights');
    const image=await readSurface(device,render3d._postScenePasses._postRenderer.sceneTexture);
    let litPixels=0,maxChannel=0;
    for(let i=0;i<image.values.length;i+=4){if(image.values[i]+image.values[i+1]+image.values[i+2]>0)litPixels++;for(let c=0;c<3;c++){if(!Number.isFinite(image.values[i+c]))throw new Error('Room contains nonfinite radiance');maxChannel=Math.max(maxChannel,image.values[i+c]);}}
    if(litPixels<1280*720*.1)throw new Error('Room did not render a meaningful image');
    cases.push({id:`room-${count}-${overlap?'overlap':'sparse'}-frame${frame}`,count,frame,overlap,source:source.stats,stableIds:source.records.map(r=>r.identity[1]),litPixels,maxChannel,visibleMeshes:render3d.lastVisibleCount,completeCoverage:profile.backend.diagnostics.completeCoverage});
    if(count===256&&overlap){
      drawSurface(image,'HDR resolve',false,true);
      for(const [i,texture] of profile.backend.lastAttachments.textures.slice(0,3).entries())drawSurface(await readSurface(device,texture),['G0 · linear base / metallic','G1 · world normal / roughness','G2 · emissive / occlusion'][i],i===1,false);
    }
  }
  const validation=await device.popErrorScope();if(validation||errors.length)throw new Error(validation?.message??errors.join('\n'));
  return {schemaVersion:1,status:'passed',scope:'G02 fixed-room production path, correctness/visual only; no performance qualification',fixture:fixture.id,resolution:[1280,720],adapter:{vendor:adapter.info.vendor,architecture:adapter.info.architecture,isFallbackAdapter:adapter.info.isFallbackAdapter},cases,validationErrors:errors};
}
async function readSurface(device,texture){
  const width=texture.width,height=texture.height,stride=Math.ceil(width*8/256)*256;
  const buffer=device.createBuffer({size:stride*height,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
  try{const encoder=device.createCommandEncoder();encoder.copyTextureToBuffer({texture},{buffer,bytesPerRow:stride,rowsPerImage:height},{width,height});device.queue.submit([encoder.finish()]);await buffer.mapAsync(GPUMapMode.READ);const data=new Uint16Array(buffer.getMappedRange()),values=new Float32Array(width*height*4);for(let y=0;y<height;y++)for(let x=0;x<width*4;x++)values[y*width*4+x]=half(data[y*stride/2+x]);buffer.unmap();return {width,height,values};}finally{buffer.destroy();}
}
function drawSurface(image,title,normal,toneMap){
  const figure=document.createElement('figure'),label=document.createElement('figcaption'),canvas=document.createElement('canvas');label.textContent=title;figure.append(label,canvas);document.querySelector('#visuals').append(figure);canvas.width=image.width;canvas.height=image.height;
  const data=new Uint8ClampedArray(image.width*image.height*4);
  for(let i=0;i<data.length;i+=4){for(let c=0;c<3;c++){let v=image.values[i+c];if(normal)v=v*.5+.5;else {if(toneMap)v=v/(1+v);v=v<=.0031308?12.92*v:1.055*v**(1/2.4)-.055;}data[i+c]=Math.round(Math.max(0,Math.min(1,v))*255);}data[i+3]=255;}
  canvas.getContext('2d').putImageData(new ImageData(data,image.width,image.height),0,0);
}
