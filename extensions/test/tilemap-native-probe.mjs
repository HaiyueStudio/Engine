import{createRenderFrameContext}from'@haiyue/engine/experimental';
import{identity,projection,atlasPixels,FullMapReference}from'./tilemap-reference.mjs';
const packaged=globalThis.G08_PACKAGE?await import('@haiyue/extensions/tilemap'):null,privateRuntime=packaged?null:await import(globalThis.G08_MODULE),Map2D=packaged?.Tilemap2DComponent??privateRuntime.Tilemap2DComponent,node=document.querySelector('#result'),cases=[],errors=[];
const {Entity,World}=await import('@haiyue/engine/ecs');
function makeRenderer(engine){if(!packaged)return new privateRuntime.Tilemap2DRenderer();const system=new packaged.Tilemap2DRenderSystem(engine,new Entity('pixel probe camera'));system.record(new World(),{device:engine.device,encoder:engine.device.createCommandEncoder()});const renderer=system.renderer;renderer.g08System=system;return renderer;}
let device;
try{
 const adapter=await navigator.gpu.requestAdapter({powerPreference:'high-performance'});device=await adapter.requestDevice();device.addEventListener('uncapturederror',event=>errors.push(event.error.message));device.pushErrorScope('validation');
 const palette=await(await fetch('/shader-language/src/render-family/stdlib/2d-ui/tilemap2d.wgsl')).text(),textured=await(await fetch('/shader-language/src/render-family/stdlib/2d-ui/spine2d.wgsl')).text(),pixels=atlasPixels(),texture=device.createTexture({size:[pixels.width,pixels.height],format:'rgba8unorm',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST});device.queue.writeTexture({texture},pixels.bytes,{bytesPerRow:pixels.width*4},[pixels.width,pixels.height]);
 const atlas={source:{texture},sourceWidth:pixels.width,sourceHeight:pixels.height,tileWidth:4,tileHeight:4,margin:1,spacing:2},transforms=['none','flip-x','flip-y','rotate-90','rotate-180','rotate-270'];
 for(const texturedMode of [false,true])for(const samples of [1,4])for(const dpr of [1,2])for(const transform of ['identity','translation','mirror','rotation'])for(const gap of [0,1]){
  const width=320*dpr,height=240*dpr,format='rgba8unorm',depth='depth24plus',targets=[0,1].map(()=>device.createTexture({size:[width,height],format,usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.COPY_SRC})),msaa=samples===4?[0,1].map(()=>device.createTexture({size:[width,height],format,sampleCount:4,usage:GPUTextureUsage.RENDER_ATTACHMENT})):[],depths=[0,1].map(()=>device.createTexture({size:[width,height],format:depth,sampleCount:samples,usage:GPUTextureUsage.RENDER_ATTACHMENT})),readbacks=[0,1].map(()=>device.createBuffer({size:width*height*4,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ}));
  const engine={device,format,msaaSamples:samples,reverseZ:false,getDepthFormat:()=>depth},renderer=makeRenderer(engine),reference=new FullMapReference(device,{palette,textured,format,samples,depth}),map=new Map2D({columns:65,rows:33,cells:Array.from({length:65*33},(_,i)=>i%7===0?0:1+i%2),cellWidth:10,cellHeight:10,gap,chunkSize:32,maxResidentChunks:1,palette:[[0,0,0,0],[1,.2,.4,.5],[.1,.8,.3,1]],...(texturedMode?{atlas}: {})});
  for(let y=0;y<map.rows;y++)for(let x=0;x<map.columns;x++)map.setCellTransform(x,y,transforms[(x+y)%6]);
  renderer.prepare(engine);renderer.msaaSamples=samples;renderer.updateCamera(projection(320,240,130,30));const world=identity();
  if(transform==='translation'){world[12]=17;world[13]=-13;}if(transform==='mirror'){world[0]=-1;world[12]=600;}if(transform==='rotation'){world[0]=Math.cos(.2);world[1]=Math.sin(.2);world[4]=-Math.sin(.2);world[5]=Math.cos(.2);}
  try{
   for(let i=0;i<2;i++){
    const descriptor={colorAttachments:[{view:(msaa[i]??targets[i]).createView(),...(msaa[i]?{resolveTarget:targets[i].createView()}:{}),loadOp:'clear',storeOp:'store',clearValue:{r:.06,g:.09,b:.13,a:1}}],depthStencilAttachment:{view:depths[i].createView(),depthLoadOp:'clear',depthStoreOp:'store',depthClearValue:1}},context=createRenderFrameContext(engine,{descriptor}),pass=context.beginPass();
    if(i===0)renderer.render(pass,1,map,world,context);else reference.record(pass,map,projection(320,240,130,30),world,texturedMode?atlas:null);
    context.endPass();context.encoder.copyTextureToBuffer({texture:targets[i]},{buffer:readbacks[i],bytesPerRow:width*4},[width,height]);context.submit();
   }
   const arrays=[];for(const buffer of readbacks){await buffer.mapAsync(GPUMapMode.READ);arrays.push(new Uint8Array(buffer.getMappedRange()).slice());buffer.unmap();}
   let maxDelta=0,changed=0;for(let i=0;i<arrays[0].length;i++){const delta=Math.abs(arrays[0][i]-arrays[1][i]);maxDelta=Math.max(maxDelta,delta);if(delta>1)changed++;}
   cases.push({texturedMode,samples,dpr,transform,gap,maxDelta,changed,stats:renderer.stats});if(changed)throw Error('Pixel mismatch '+JSON.stringify(cases.at(-1)));
  }finally{renderer.destroy();renderer.g08System?.destroy();await device.queue.onSubmittedWorkDone();for(let i=0;i<6;i++)await Promise.resolve();reference.destroy();for(const object of [...targets,...msaa,...depths,...readbacks])object.destroy();}
 }
 texture.destroy();const error=await device.popErrorScope();if(error)errors.push(error.message);if(errors.length)throw Error(errors.join('; '));node.textContent=JSON.stringify({schemaVersion:1,status:'passed',role:'native implementation diagnostic; not formal release/performance qualification',adapter:{vendor:adapter.info.vendor,description:adapter.info.description,isFallbackAdapter:adapter.info.isFallbackAdapter},cases,errors});node.dataset.status='passed';
}catch(error){node.textContent=JSON.stringify({status:'failed',error:String(error.stack??error),cases,errors});node.dataset.status='failed';}
finally{device?.destroy();}
