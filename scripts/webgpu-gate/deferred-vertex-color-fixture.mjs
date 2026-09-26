import { Camera3D, DirectionalLight, Entity, Geometry3D, GrayscalePass, Mesh3D, OutlineTarget, Transform3D, setGeometryVertexColors, createDeferredReferenceProfile, runRealRendererBenchmarkFrame, mat4 } from '../../artifacts/engine-0.2.1/g02/fixture.js';
import { readFloatTexture } from './float-texture-readback.mjs';

class CoverageProbe extends GrayscalePass {
  needsDepthTexture = true;
  needsNormalTexture = true;
  needsMotionTexture = true;
  needsOutlineMask = true;
  setSceneTextures(textures) { this.textures = textures; }
}

/** Actual production draws: interpolation, HDR parity, then all alpha coverage consumers. */
export async function verifyVertexColors({state,receiver,material,lights,near}) {
  const {device,render3d,world}=state, results=[];
  document.querySelector('#progress').textContent='Vertex RGBA and auxiliary coverage';
  lights.forEach((light,i)=>{light.disabled=i!==0;});
  state.views[0].camera.getComponent(Transform3D).setTranslation(0,0,3);
  state.views[0].camera.addComponent(new Camera3D({type:'orthographic',left:-1,right:1,bottom:-1,top:1,near:.1,far:10}));
  const geometry=new Geometry3D({positions:new Float32Array([-1,-1,0,1,-1,0,1,1,0,-1,1,0]),
    normals:new Float32Array([0,0,1,0,0,1,0,0,1,0,0,1]),indices:new Uint32Array([0,1,2,0,2,3]),
    textureCoordinates:[{set:0,data:new Float32Array([0,1,1,1,1,0,0,0])}],
    morphTargets:[{positions:new Float32Array(12),normals:new Float32Array([0,.6,-.2,0,.6,-.2,0,.6,-.2,0,.6,-.2])}],morphWeights:[1],
    skinning:{joints:new Float32Array(16),weights:new Float32Array([1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0]),jointMatrices:mat4.identity()},
  });
  receiver.getComponent(Mesh3D).geometry=geometry;
  material.emissiveFactor=[.1,.1,.1];material.alphaMode='opaque';material.baseColor.a=.8;
  const base=new Float32Array(4);material.baseColor.writeLinear(base);
  const texture=device.createTexture({size:[1,1],format:'rgba8unorm',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST});
  device.queue.writeTexture({texture},new Uint8Array([128,192,255,204]),{bytesPerRow:4},[1,1]);material.baseColorTexture=texture;
  const colors=new Float32Array([1,0,.25,0,0,1,.75,1,0,1,.75,1,1,0,.25,0]);
  const frame=async()=>{await runRealRendererBenchmarkFrame(state);return readFloatTexture(device,render3d._postScenePasses._postRenderer.sceneTexture);};
  const pixel=(data,x,y=32)=>Array.from(data.slice((y*64+x)*4,(y*64+x)*4+4));
  try {
    setGeometryVertexColors(geometry,colors);
    let profile=await createDeferredReferenceProfile(render3d,state.engine);
    const deferred=await frame(), g=await readFloatTexture(device,profile.backend.lastAttachments.textures[0]);
    const sampled=[];
    for(const x of [16,48]) {
      const t=(x+.5)/64, expected=[base[0]*128/255*(1-t),base[1]*192/255*t,base[2]*(.25+.5*t),0];
      near(pixel(g,x),expected,.001,.0005,'interpolated linear RGBA times base and texture');sampled.push({x,pixel:pixel(g,x),expected});
    }
    results.push({id:'vertex-color-interpolation',sampled});
    render3d.setRenderProfile('batched');const forward=await frame();
    for(let i=0;i<forward.length;i++)near([deferred[i]],[forward[i]],.005,.003,`vertex RGB parity ${i}`);
    material.alphaMode='mask';material.alphaCutoff=.4;
    const maskedForward=await frame();profile=await createDeferredReferenceProfile(render3d,state.engine);const maskedDeferred=await frame();
    for(let i=0;i<maskedForward.length;i++)near([maskedDeferred[i]],[maskedForward[i]],.005,.003,`vertex mask parity ${i}`);
    near(pixel(maskedForward,16).slice(0,3),[0,0,0],0,0,'vertex alpha hole');
    if(pixel(maskedForward,48)[0]<=0)throw new Error('Vertex alpha rejected covered pixels');
    setGeometryVertexColors(geometry,null);await frame();
    const white=await readFloatTexture(device,profile.backend.lastAttachments.textures[0]);
    near(pixel(white,16),[base[0]*128/255,base[1]*192/255,base[2],0],.001,.0005,'removed colors restore white');
    results.push({id:'vertex-color-forward-deferred',pixels:64*64,opaqueAndMask:true,whiteRestored:true});

    render3d.setRenderProfile('batched');setGeometryVertexColors(geometry,colors);
    lights.forEach(light=>{light.disabled=true;});
    receiver.addComponent(new OutlineTarget());
    const sun=new Entity('vertex-color-shadow').addComponent(new Transform3D()).addComponent(new DirectionalLight({direction:[0,0,-1],castShadow:true,shadow:{extent:2,near:.1,far:20,mapSize:64}}));world.add(sun);
    const probe=new CoverageProbe();render3d.passes.push(probe);render3d.checkEntityManager(world);
    const capture=async label=>{
      const color=await frame(), output={color};
      for(const key of ['depth','normal','motion','outlineMask','outlineVisibleMask'])if(probe.textures[key])output[key]=await readFloatTexture(device,probe.textures[key]);
      output.shadow=await readFloatTexture(device,render3d._renderers.shadow._texture,true);
      for(let i=0;i<64*64;i++){
        const covered=color[i*4]>.01;
        if(output.depth && (output.depth[i*4]<.999)!==covered)throw new Error(`${label}: depth coverage ${i}`);
        if(output.normal && (output.normal[i*4+1]>.6)!==covered)throw new Error(`${label}: normal coverage ${i}`);
        for(const key of ['outlineMask','outlineVisibleMask'])if((output[key][i*4]>.5)!==covered)throw new Error(`${label}: ${key} coverage ${i}`);
      }
      return output;
    };
    await capture('warm mask');receiver.getComponent(Transform3D).setTranslation(.1,0,0);
    const fused=await capture('moving mask');
    for(let i=0;i<64*64;i++)near([fused.motion[i*4]],[fused.color[i*4]>.01?.05:0],0,.001,'vertex alpha motion coverage');
    probe.needsMotionTexture=false;const normalDepth=await capture('normal depth mask');
    probe.needsNormalTexture=false;const depth=await capture('standalone depth mask');
    for(let i=0;i<64*64;i++)near([normalDepth.depth[i*4]],[depth.depth[i*4]],0,.00001,'standalone and fused coverage');
    const shadowCount=output=>Array.from(output.shadow).filter((v,i)=>i%4===0&&v<.999).length;
    const maskedShadow=shadowCount(fused);material.alphaMode='opaque';const opaque=await capture('opaque ignores vertex alpha');
    if(maskedShadow<=0||shadowCount(opaque)<=maskedShadow)throw new Error('Vertex alpha shadow hole missing');
    material.alphaMode='mask';setGeometryVertexColors(geometry,new Float32Array(16));const rejected=await capture('updated zero alpha');
    if(rejected.color.some((v,i)=>i%4<3&&v!==0)||shadowCount(rejected)!==0)throw new Error('Updated vertex alpha did not reject all passes');
    results.push({id:'vertex-alpha-auxiliary',morphAndSkin:true,maskedShadow,opaqueShadow:shadowCount(opaque),updatedZeroAlpha:true});
  } finally {
    await device.queue.onSubmittedWorkDone();material.baseColorTexture=null;texture.destroy();
  }
  return results;
}
