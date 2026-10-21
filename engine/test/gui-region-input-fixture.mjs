import {RenderPipeline,RenderView,Entity,World,GPUResourceTracker,createGPUResourceOwner} from '/engine/dist/experimental.js';
import {GuiSystem,GuiRoot,GuiButton} from '/engine/dist/gui.js';

const canvas=document.querySelector('canvas'),result=document.querySelector('#result'),errors=[],cases=[],live=[];
const check=(v,m)=>{if(!v)throw Error(m);};let device,tracker,scoped=false;
try{
 const adapter=await navigator.gpu.requestAdapter({powerPreference:'high-performance'});check(adapter&&!adapter.info.isFallbackAdapter,'Native adapter required');device=await adapter.requestDevice();device.pushErrorScope('validation');scoped=true;
 device.addEventListener('uncapturederror',e=>errors.push(e.error.message));tracker=new GPUResourceTracker({debug:true});tracker.instrumentDevice(device,createGPUResourceOwner('system','G05 region input'));
 function fixture(cache){
  const width=320,height=200,displayWidth=256,displayHeight=160,format='rgba8unorm',world=new World(),textures=[],color=device.createTexture({size:[width,height],format,usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.COPY_SRC}),depth=device.createTexture({size:[width,height],format:'depth24plus',usage:GPUTextureUsage.RENDER_ATTACHMENT});textures.push(color,depth);
  const target={key:`g05-${cache}`,width,height,displayWidth,displayHeight,format,getOutputView:()=>color.createView(),getRenderPassDescriptor:()=>({colorAttachments:[{view:color.createView(),loadOp:'clear',storeOp:'store',clearValue:{r:0,g:0,b:0,a:0}}],depthStencilAttachment:{view:depth.createView(),depthLoadOp:'clear',depthStoreOp:'store',depthClearValue:1}})};
  const engine={device,...(cache?{canvas}:{}),format,width,height,displayWidth,displayHeight,msaaSamples:1,reverseZ:false,clearColor:{r:0,g:0,b:0,a:0},getDepthFormat:()=> 'depth24plus',getRenderPassDescriptor:target.getRenderPassDescriptor};
  const view=new RenderView({camera:new Entity(),target,sampleCount:1}),region=view.createRegion({id:'input',bounds:{x:-10.5,y:20.25,width:100.5,height:100.5},updateMode:'demand',clearMode:'on-update',visible:true}),pipeline=new RenderPipeline(engine),root=new GuiRoot();let clicks=0,cancels=0,records=0,frame=0;
  const a=root.add(new GuiButton({id:`${cache}-a`,x:20,y:10,width:40,height:30,text:'',onClick:()=>clicks++,onPointerCancel:()=>cancels++})),b=root.add(new GuiButton({id:`${cache}-b`,x:20,y:60,width:40,height:30,text:''}));
  const gui=new GuiSystem(engine,{roots:new Set([root]),font:{chars:'? ',atlasSize:64}});world.addEntity(new Entity().addComponent(root));world.addSystem(gui);pipeline.add(gui,{region});const record=gui.record.bind(gui);gui.record=(...args)=>{records++;return record(...args);};
  const f={root,a,b,world,region,view,gui,pipeline,color,get clicks(){return clicks;},get cancels(){return cancels;},get records(){return records;},render(){const context=pipeline.execute(world,++frame*16,16,{view,regionCache:cache});return{stats:pipeline.getDebugSnapshot().regions,submitted:context.submitted};},async destroy(){pipeline.clear();world.destroy();view.destroy();for(const t of textures)t.destroy();await device.queue.onSubmittedWorkDone();}};live.push(f);return f;
 }
 async function pixels(texture){const stride=Math.ceil(texture.width*4/256)*256,buffer=device.createBuffer({size:stride*texture.height,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ}),encoder=device.createCommandEncoder();encoder.copyTextureToBuffer({texture},{buffer,bytesPerRow:stride},[texture.width,texture.height]);device.queue.submit([encoder.finish()]);await buffer.mapAsync(GPUMapMode.READ);const bytes=new Uint8Array(buffer.getMappedRange()),copy=new Uint8Array(texture.width*texture.height*4);for(let y=0;y<texture.height;y++)copy.set(bytes.subarray(y*stride,y*stride+texture.width*4),y*texture.width*4);buffer.unmap();buffer.destroy();return copy;}
 const cached=fixture(true),direct=fixture(false);cached.render();direct.render();
 const scene=[],off=cached.gui.onUnhandledInput(e=>scene.push(e.type));
 window.probe={
  state:()=>({focus:cached.gui.focus.focused===cached.a?'a':cached.gui.focus.focused===cached.b?'b':null,clicks:cached.clicks,cancels:cached.cancels,scene:[...scene],pressed:cached.a.pressed}),
  async check(id){
   for(const key of ['a','b']){direct[key].hovered=cached[key].hovered;direct[key].pressed=cached[key].pressed;direct[key].markDirty();}
   if(cached.gui.focus.focused===cached.a)direct.gui.focus.focus(direct.a);else if(cached.gui.focus.focused===cached.b)direct.gui.focus.focus(direct.b);else direct.gui.focus.blur();
   const actual=cached.render();direct.render();const a=await pixels(cached.color),b=await pixels(direct.color);let max=0,different=0;for(let i=0;i<a.length;i++){const d=Math.abs(a[i]-b[i]);max=Math.max(max,d);if(d>2)different++;}check(!different,`${id}: retained and fresh pixels differ`);const data={id,maxChannelDifference:max,differentChannels:different,channelsCompared:a.length,actual,...this.state()};cases.push(data);return data;
  },
  disable:()=>{cached.world.disabled=true;},
  async finish(){off();for(const f of live)await f.destroy();live.length=0;const validation=await device.popErrorScope();scoped=false;if(validation)errors.push(validation.message);check(!errors.length,errors.join(';'));const residue=tracker.getDebugSnapshot().byType;check((residue.buffer?.current??0)===0&&(residue.texture?.current??0)===0,'Resource residue');return{status:'passed',caseCount:cases.length,cases,residue,errors,adapter:{vendor:adapter.info.vendor,architecture:adapter.info.architecture,isFallbackAdapter:adapter.info.isFallbackAdapter},qualification:'Actual RenderView fractional negative-origin region, non-unit CSS scale and DPR; trusted browser input; retained vs independently fresh GUI pixels with unchanged 2/255 tolerance.'};},
 };
 canvas.dataset.ready='true';
}catch(error){for(const f of live)await f.destroy();if(scoped)await device.popErrorScope();result.textContent=JSON.stringify({status:'failed',error:String(error.stack??error),cases,errors});result.dataset.status='failed';}
