import {GuiRoot,GuiElement,GuiLabel} from '/engine/dist/gui.js';
import {GuiRenderer} from '/engine/dist/experimental.js';
const result=document.querySelector('#result'),canvas=document.querySelector('#view');
let device;
try{
  const adapter=await navigator.gpu.requestAdapter();if(!adapter)throw Error('Native WebGPU adapter unavailable');
  device=await adapter.requestDevice();const validationErrors=[];device.addEventListener('uncapturederror',e=>validationErrors.push(e.error.message));device.pushErrorScope('validation');
  const info=adapter.info,context=canvas.getContext('webgpu'),format=navigator.gpu.getPreferredCanvasFormat();context.configure({device,format,alphaMode:'premultiplied',usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.COPY_SRC});
  const root=new GuiRoot({width:320,height:720});root.add(new GuiElement({width:320,height:720,style:{backgroundColor:'#112233'}}));
  for(let i=0;i<126;i++){const options={x:(i%8)*40,y:Math.floor(i/8)*24,width:40,height:24};root.add(i%4===0?new GuiLabel({...options,text:'AB',fontSize:12}):new GuiElement({...options,style:{backgroundColor:'#334455'}}));}
  const renderer=new GuiRenderer({chars:'AB?',fontSize:12,atlasSize:128}),cohorts=[];
  const host={device,format,displayWidth:1280,displayHeight:720,reverseZ:false,msaaSamples:1,getDepthFormat:()=> 'depth24plus'};
  for(const samples of [1,4]){
    host.msaaSamples=samples;
    const depth=device.createTexture({size:[1280,720],format:'depth24plus',sampleCount:samples,usage:GPUTextureUsage.RENDER_ATTACHMENT});
    const color=samples===4?device.createTexture({size:[1280,720],format,sampleCount:4,usage:GPUTextureUsage.RENDER_ATTACHMENT}):null;
    const cpu=[],pacing=[],visibility=[],pixels=[];let previous;
    for(let frame=0;frame<180;frame++){
      const stamp=await new Promise(requestAnimationFrame);const t=performance.now();
      root.layout(320,720);const output=context.getCurrentTexture(),encoder=device.createCommandEncoder();
      const pass=encoder.beginRenderPass({colorAttachments:[{view:(color??output).createView(),...(color?{resolveTarget:output.createView()}:{}),clearValue:{r:0.1+frame%60/120,g:0.08,b:0.15,a:1},loadOp:'clear',storeOp:'store'}],depthStencilAttachment:{view:depth.createView(),depthClearValue:1,depthLoadOp:'clear',depthStoreOp:'discard'}});
      renderer.render(pass,[root],host);pass.end();
      let read;
      if(frame===179){read=device.createBuffer({size:5120*720,usage:GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST});encoder.copyTextureToBuffer({texture:output},{buffer:read,bytesPerRow:5120},[1280,720]);}
      device.queue.submit([encoder.finish()]);root.clearDirty();
      if(frame>=60){cpu.push(performance.now()-t);pacing.push(stamp-previous);visibility.push(document.visibilityState);}previous=stamp;
      if(read){await read.mapAsync(GPUMapMode.READ);const data=new Uint8Array(read.getMappedRange());for(const x of [2,600]){const offset=600*5120+x*4;pixels.push([...data.slice(offset,offset+4)]);}read.unmap();read.destroy();}
    }
    await device.queue.onSubmittedWorkDone();color?.destroy();depth.destroy();
    const p95=xs=>[...xs].sort((a,b)=>a-b)[Math.ceil(xs.length*.95)-1];
    cohorts.push({samples,warmupFrames:60,measuredFrames:120,cpuMs:cpu,pacingMs:pacing,p95CpuMs:p95(cpu),p95CadenceMs:p95(pacing),visibility,pixels,renderTargetBytes:{depth:1280*720*4*samples,multisampleColor:color?1280*720*4*samples:0,plannedSidebarResolveRgba8:320*720*4,plannedSidebarMsaaColor:samples===4?320*720*4*samples:0},note:'current direct GUI drawn each frame over animated attachment clear; no retained-region implementation; canvas cadence is not physical scanout'});
  }
  renderer.destroy();await device.queue.onSubmittedWorkDone();const error=await device.popErrorScope();if(error||validationErrors.length)throw Error(JSON.stringify({error:error?.message,validationErrors}));
  result.textContent=JSON.stringify({status:'passed',kind:'g01-native-region-baseline-diagnostic',adapter:{vendor:info.vendor,architecture:info.architecture,device:info.device,description:info.description},userAgent:navigator.userAgent,dpr:devicePixelRatio,cohorts,validationErrors,qualification:false});result.dataset.status='passed';
}catch(error){result.textContent=JSON.stringify({status:'failed',error:String(error.stack??error)});result.dataset.status='failed';}finally{device?.destroy();}
