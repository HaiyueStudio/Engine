import { Entity, PointLight, Transform3D, ColorLinear, AmbientLight, EnvironmentLight, ClippingPlanes, mat4, runRealRendererBenchmarkFrame } from '../../artifacts/engine-0.2.1/g02/fixture.js';

/** Pixel oracles exercise production material upload/binding paths, with linear texture values. */
export async function verifyDeferredMaterials({state,profile,material,receiver,lights,cases,readPixel,near}) {
  const {device,world,render3d}=state, results=[], textures=[];
  const frame=async()=>{await runRealRendererBenchmarkFrame(state);return readPixel(device,render3d._postScenePasses._postRenderer.sceneTexture,32,32);};
  const surface=async()=>Promise.all(profile.backend.lastAttachments.textures.slice(0,3).map(t=>readPixel(device,t,32,32)));
  const texture=(width,data)=>{
    const t=device.createTexture({size:[width,1],format:'rgba8unorm',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST});
    device.queue.writeTexture({texture:t},new Uint8Array(data),{bytesPerRow:width*4},{width,height:1});textures.push(t);return t;
  };
  try {
    lights.forEach(light=>{light.disabled=true;});
    const base=new Float32Array(4);material.baseColor.writeLinear(base);
    material.baseColorTexture=texture(2,[255,0,0,255,0,255,0,255]);
    material.setTextureSampler('baseColor',{minFilter:'nearest',magFilter:'nearest',addressModeU:'clamp-to-edge'});
    await frame();let g=await surface();near(g[0],[0,base[1],0,0],.001,.0005,'UV0 green texel');
    material.setTextureMapping('baseColor',{texCoord:1});
    await frame();g=await surface();near(g[0],[base[0],0,0,0],.001,.0005,'UV1 red texel');
    material.setTextureMapping('baseColor',{texCoord:1,offset:[1,0]});
    await frame();g=await surface();near(g[0],[0,base[1],0,0],.001,.0005,'clamp sampler');
    material.setTextureSampler('baseColor',{minFilter:'nearest',magFilter:'nearest',addressModeU:'repeat'});
    await frame();g=await surface();near(g[0],[base[0],0,0,0],.001,.0005,'repeat sampler');
    results.push({id:'uv0-uv1-transform-samplers',gbuffer:g});
    material.baseColorTexture=null;material.setTextureMapping('baseColor',{});
    material.normalTexture=texture(1,[204,128,230,255]);
    await frame();g=await surface();
    const expected=[204,128,230].map(v=>v/255*2-1), length=Math.hypot(...expected);
    const normal=g[1].slice(0,3), nLength=Math.hypot(...normal);
    const angle=Math.acos(Math.min(1,Math.max(-1,normal.reduce((sum,v,i)=>sum+v*expected[i],0)/(length*nLength))))*180/Math.PI;
    if(angle>.1)throw new Error(`Normal map angle ${angle} > 0.1 degrees`);
    results.push({id:'normal-map',angleDegrees:angle,gbuffer:g});material.normalTexture=null;
    material.metallic=.8;material.metallicRoughnessTexture=texture(1,[0,128,64,255]);
    material.occlusionTexture=texture(1,[64,0,0,255]);material.occlusionStrength=.75;
    material.emissiveFactor=[.2,.3,.4];material.emissiveTexture=texture(1,[32,64,128,255]);
    await frame();g=await surface();
    near(g[0],[...base.slice(0,3),.8*64/255],.001,.0005,'metallic texture');
    near(g[1],[0,0,1,.6*128/255],.001,.0005,'roughness texture');
    near(g[2],[.2*32/255,.3*64/255,.4*128/255,.25+.75*64/255],.001,.0005,'emissive/occlusion textures');
    results.push({id:'metallic-roughness-occlusion-emissive-textures',gbuffer:g});
    material.metallic=0;material.metallicRoughnessTexture=null;material.occlusionTexture=null;material.emissiveTexture=null;
    material.emissiveFactor=[.1,.1,.1];material.baseColorTexture=texture(1,[255,255,255,0]);material.alphaMode='mask';
    near((await frame()).slice(0,3),[0,0,0],0,0,'texture alpha mask');
    results.push({id:'texture-alpha-mask'});material.baseColorTexture=null;material.alphaMode='opaque';
    const clipping=new ClippingPlanes([{normal:[0,0,1],constant:-1}]);receiver.addComponent(clipping);
    near((await frame()).slice(0,3),[0,0,0],0,0,'world clipping discard');
    clipping.clear();near((await frame()).slice(0,3),[.1,.1,.1],.001,.0005,'world clipping cleared');
    results.push({id:'clipping-update'});
    receiver.getComponent(Transform3D).setMatrix(mat4.scaling([-1,1,1]));material.doubleSided=false;
    near((await frame()).slice(0,3),[0,0,0],0,0,'back face culling');
    material.doubleSided=true;near((await frame()).slice(0,3),[.1,.1,.1],.001,.0005,'double sided back face');
    results.push({id:'double-sided'});receiver.getComponent(Transform3D).setMatrix(mat4.identity());material.doubleSided=false;material.emissiveFactor=[0,0,0];
    const environment=new Entity('oracle-environment').addComponent(new EnvironmentLight({intensity:.4}));
    const ambient=new Entity('oracle-ambient').addComponent(new AmbientLight({intensity:.2}));
    world.add(environment);world.add(ambient);
    const global=await frame();if(!global.slice(0,3).some(v=>v>0))throw new Error('Missing environment/ambient contribution');
    lights.forEach((light,i)=>{light.disabled=i>=128;});
    const globalLit=await frame();near(globalLit.slice(0,3),cases.find(c=>c.count===128).pixel.slice(0,3).map((v,c)=>v+global[c]),.002,.002,'environment and ambient exactly once');
    results.push({id:'environment-ambient-once',global,globalLit});world.removeEntity(environment);world.removeEntity(ambient);
    lights.forEach(light=>{light.disabled=true;});const last=lights.at(-1);last.disabled=false;
    const before=await frame(), id=profile.backend.lastSource.records[0].identity[1];
    last.getComponent(PointLight).color=new ColorLinear(1,0,0);
    const red=await frame();near(red.slice(0,3),[before[0],0,0],.002,.002,'last light color update');
    world.removeEntity(last);near((await frame()).slice(0,3),[0,0,0],0,0,'last light removal');
    const added=new Entity('oracle-added').addComponent(new Transform3D().setTranslation(Math.sin(255)*2,Math.cos(255)*2,3)).addComponent(new PointLight({intensity:.05,range:12}));world.add(added);
    const after=await frame();near(after,before,.002,.002,'new light addition');
    const addedId=profile.backend.lastSource.records[0].identity[1];if(addedId===id)throw new Error('Removed light ID reused');
    results.push({id:'light-color-remove-add',before,red,after,removedId:id,addedId});world.removeEntity(added);
  } finally { for(const t of textures)t.destroy(); }
  return results;
}
