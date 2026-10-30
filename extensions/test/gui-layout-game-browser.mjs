import {World} from '@haiyue/engine/ecs';
import {GuiSystem,hitTestGui} from '@haiyue/engine/gui';
import {FrameDiagnostics,GPUResourceTracker,createGPUResourceOwner} from '@haiyue/engine/experimental';
import {attachGuiLayout,createGuiContainer} from '@haiyue/extensions/gui-layout';
import {BilliardsHud} from './out/BilliardsHud.js';
const canvas=document.querySelector('#canvas'),result=document.querySelector('#result'),preview=document.querySelector('#preview');
const check=(v,m)=>{if(!v)throw Error(m)},hash=async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),n=>n.toString(16).padStart(2,'0')).join('');
let device,system,world,hud,output,depth,root,controls;
let width=800,height=600,clicks=0,releases=0,frames=0;
const cases=[],errors=[],diagnostics=new FrameDiagnostics({enabled:true}),tracker=new GPUResourceTracker({debug:true,frameDiagnostics:diagnostics});
try{
 const adapter=await navigator.gpu.requestAdapter({powerPreference:'high-performance'});check(adapter&&!adapter.info.isFallbackAdapter,'Native adapter required');
 device=await adapter.requestDevice();device.addEventListener('uncapturederror',e=>errors.push(e.error.message));device.pushErrorScope('validation');tracker.instrumentDevice(device,createGPUResourceOwner('system','g03-packed-game'));
 const host={device,canvas,format:'rgba8unorm',displayWidth:width,displayHeight:height,reverseZ:false,msaaSamples:1,getDepthFormat:()=> 'depth24plus'};
 world=new World('packed-billiards');system=new GuiSystem(host);world.add(system);
 const mount=(gui,widgets)=>{
  root=gui;controls=widgets;
  const binding=attachGuiLayout(gui);
  try{
   const top=gui.add(createGuiContainer('column',{id:'hud-heading',style:{width:'auto',height:240,anchors:{left:0,top:0,right:1,bottom:0},offsets:{left:20,top:14,right:-20},rowGap:8,alignItems:'stretch'}}));
   top.add(widgets.title);top.add(widgets.help);
   const stats=top.add(createGuiContainer('flow',{id:'hud-stats',style:{width:{percent:100},height:'auto',columnGap:10,rowGap:10}}));
   stats.add(widgets.score);stats.add(widgets.state);
   for(const label of [widgets.title,widgets.help])binding.setStyle(label,{width:'auto',height:'auto',shrink:0});
   for(const panel of [widgets.score,widgets.state])binding.setStyle(panel,{basis:136,grow:1,minWidth:100,height:52});
   binding.setStyle(widgets.newGame,{width:122,height:42,anchors:{left:1,top:1,right:1,bottom:1},offsets:{left:-142,top:-62}});
  }catch(error){binding.dispose();throw error}
  return ()=>{releases++;binding.dispose()};
 };
 const resize=()=>{output?.destroy();depth?.destroy();canvas.width=width;canvas.height=height;host.displayWidth=width;host.displayHeight=height;output=device.createTexture({size:[width,height],format:host.format,usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.COPY_SRC});depth=device.createTexture({size:[width,height],format:'depth24plus',usage:GPUTextureUsage.RENDER_ATTACHMENT})};
 const frame=async id=>{
  diagnostics.beginFrame(++frames);const start=performance.now();world.update(performance.now(),16);system.prepareRoots(world,width,height);system.dispatchPendingEvents(world);
  const encoder=device.createCommandEncoder(),pass=encoder.beginRenderPass({colorAttachments:[{view:output.createView(),loadOp:'clear',storeOp:'store',clearValue:[0.02,0.07,0.04,1]}],depthStencilAttachment:{view:depth.createView(),depthLoadOp:'clear',depthStoreOp:'discard',depthClearValue:1}});
  diagnostics.increment('passes');system.renderer.render(pass,root?[root]:[],host);pass.end();const cpuMs=performance.now()-start;
  const stride=Math.ceil(width*4/256)*256,read=device.createBuffer({size:stride*height,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});encoder.copyTextureToBuffer({texture:output},{buffer:read,bytesPerRow:stride},[width,height]);device.queue.submit([encoder.finish()]);root?.clearDirty();
  const wait=performance.now();await read.mapAsync(GPUMapMode.READ);const queueAndReadbackWaitMs=performance.now()-wait,bytes=new Uint8Array(read.getMappedRange()).slice();read.unmap();read.destroy();
  if(id){
   const image=new ImageData(width,height);for(let y=0;y<height;y++)image.data.set(bytes.subarray(y*stride,y*stride+width*4),y*width*4);preview.width=width;preview.height=height;preview.getContext('2d').putImageData(image,0,0);
   const geometry=Object.fromEntries(Object.entries(controls).map(([k,e])=>[k,{...e.rect}]));
   for(const [name,r]of Object.entries(geometry))check(r.width>0&&r.height>0&&r.x>=0&&r.y>=0&&r.x+r.width<=width+0.01&&r.y+r.height<=height+0.01,'Out of viewport '+name+': '+JSON.stringify({r,width,height,geometry}));
   check(controls.score.rect.x+controls.score.rect.width<=controls.state.rect.x+0.01||controls.score.rect.y+controls.score.rect.height<=controls.state.rect.y+0.01,'Stats overlap');
   cases.push({id,width,height,geometry,pixelSha256:await hash(bytes),cpuMs,queueAndReadbackWaitMs,metrics:diagnostics.snapshot().counters});
  }
  return diagnostics.snapshot().counters;
 };
 resize();hud=new BilliardsHud(world,()=>clicks++,mount);await frame();await frame('wide');
 const staticMetrics=await frame('static');check(staticMetrics.bufferUploads===0,'Static HUD uploaded buffers');
 hud.setScore(7);hud.setState('Ready to shoot');await frame('game-state-update');
 controls.help.setText('Drag the cue ball to shoot. This translated instruction is deliberately longer and must wrap to the available viewport width.');await frame('long-instruction');
 width=360;resize();await frame('narrow');
 const help=controls.help.rect;check(help.height>28,'Long instruction did not wrap');check(controls.score.rect.y>=help.y+help.height,'Stats overlap translated text');
 const r=controls.newGame.rect,x=r.x+r.width/2,y=r.y+r.height/2;check(hitTestGui(world,new Set([root]),x,y)===controls.newGame,'New Game hit geometry differs');
 for(const type of ['pointerdown','pointerup'])canvas.dispatchEvent(new PointerEvent(type,{clientX:x,clientY:y,pointerId:8,pointerType:'touch',buttons:type==='pointerup'?0:1,bubbles:true}));
 await frame();check(clicks===1,'New Game callback did not activate exactly once');
 hud.dispose();hud.dispose();hud=null;root=null;check(releases===1,'HUD detach was not idempotent');await frame();
 hud=new BilliardsHud(world,()=>clicks++,mount);await frame('remounted');check(controls.score.text==='POTTED  0 / 10','Remount retained stale game state');hud.dispose();hud=null;root=null;
 system.destroy();system=null;world.destroy();world=null;output.destroy();depth.destroy();output=depth=null;await device.queue.onSubmittedWorkDone();await Promise.resolve();
 const residue=tracker.getDebugSnapshot().byType;check((residue.buffer?.current??0)===0&&(residue.texture?.current??0)===0,'Packed game leaked resources');const validation=await device.popErrorScope();check(!validation,'GPU validation: '+validation?.message);check(errors.length===0,'Uncaptured GPU validation');
 result.textContent=JSON.stringify({status:'passed',caseCount:cases.length,cases,clicks,releases,resourceResidue:residue,errors,adapter:adapter.info,qualification:'Actual Billiards HUD from isolated local tarballs; native GUI integration, not complete gameplay or final production performance'});result.dataset.status='passed';
}catch(error){result.textContent=JSON.stringify({status:'failed',error:String(error.stack??error),cases,errors});result.dataset.status='failed'}
finally{hud?.dispose();system?.destroy();world?.destroy();output?.destroy();depth?.destroy();device?.destroy()}
