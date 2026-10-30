import {HaiyueEngine,Entity,Transform2D,World} from '@haiyue/engine';
import {Camera2D} from '@haiyue/engine/components';
import {RttEngine} from '@haiyue/engine/rtt';
import {RenderPipeline} from '@haiyue/engine/experimental/renderer';
import {getEngineDiagnosticsSnapshot} from '@haiyue/engine/diagnostics';
import {parseAnimation} from '@haiyue/animation-spec';
import * as candidate from '@g11/mask-candidate';
import * as reference from '@g11/mask-reference';
const result=document.querySelector('#result'),cases=[],captures=[],errors=[],failures=[];
const repeatedPixels=new WeakMap();
const check=(value,message)=>{if(!value)throw Error(message);};
let engine,scoped=false;const live=new Set();
function fixture(){
 const nodes=[{id:'back',components:[{type:'shape2d',shape:'rect',size:[320,240],fill:[.08,.12,.18,.6]}],transform:{position:[160,120]}}],tracks=[];
 for(let i=0;i<40;i++)nodes.push({id:'m'+i,transform:{position:[60+(i%8)*24,45+Math.floor(i/8)*26],opacity:i===39?0:1},components:[{type:'shape2d',shape:i%2?'ellipse':'rect',size:[85+i%7,65+i%9],fill:[i%3/2,(i+1)%3/2,(i+2)%3/2,.25+(i%4)*.25]}]});
 for(let i=0;i<6;i++)nodes.push({id:'p'+i,transform:{position:[110+i*8,90]},components:[{type:'shape2d',shape:'rect',size:[190,130],fill:[1,.8,.5,.9]}],composite:{layers:[{kind:'mask',source:'m'+i,mode:'alpha',operation:'add'},{kind:'mask',source:'m'+(i+1),mode:'alpha-inverted',operation:'intersect'}]}});
 const modes=['alpha','alpha-inverted','luma','luma-inverted'];
 for(let i=0;i<40;i++)nodes.push({id:'out'+i,transform:{position:[80+i%8*22,50+Math.floor(i/8)*27]},components:[{type:'shape2d',shape:'rect',size:[95,75],fill:[(i%5+1)/6,(i%7+1)/8,(i%3+1)/4,.55]}],composite:{layers:[{kind:'mask',source:i%7===0?'p'+i%6:'m'+i,mode:modes[i%4],operation:'add'},{kind:'mask',source:'m'+(i+11)%40,mode:'alpha',operation:i%3===0?'subtract':'intersect'}]}});
 nodes.push({id:'front',transform:{position:[173,117]},components:[{type:'shape2d',shape:'ellipse',size:[45,35],fill:[.9,.2,.1,.4]}]});
 tracks.push({node:'m0',property:'opacity',times:[0,.5,1],values:[1,0,1],interpolation:'linear'});
 return parseAnimation({format:'haiyue-animation',version:'1.0',canvas:{width:320,height:240,coordinateSystem:'screen-y-down'},duration:1,nodes,tracks});
}
function create(module,document,width,height,maxMaskTargets=16,samples=1){
 const rtt=new RttEngine(engine,width,height,{r:0,g:0,b:0,a:0},'G11.mask',null,'rgba8unorm');rtt.msaaSamples=samples;
 const world=new World('mask native'),camera=new Entity('camera').addComponent(new Camera2D({width:document.canvas.width,height:document.canvas.height,designWidth:document.canvas.width,designHeight:document.canvas.height,viewportMode:'fixed'}));world.addEntity(camera);
 const system=new module.Animation2DSystem({assetManager:engine.assetManager}),renderer=new module.Animation2DRenderSystem(rtt,camera,{loadOp:'clear',maxMaskTargets});
 world.addSystem(system);world.addSystem(renderer);const player=new module.Animation2DComponent(document,{autoplay:false,loop:false});world.addEntity(new Entity('player').addComponent(new Transform2D()).addComponent(player));
 // The unchanged old renderer has measured same-input MSAA variation up to 4.
 // Its draws remain the pixel oracle, but each reference draw has an explicit
 // stored attachment boundary. No shader, geometry, blend order, candidate
 // input, production target limit or tolerance changes. This is a correctness
 // reference only: neither its extra passes nor the 64-target oracle are a
 // production/performance profile. The original failed comparisons are retained.
 if(module===reference){
 const begin=renderer.beginOutputSegment;
 renderer.beginOutputSegment=function(context,first){
  const descriptor={...context.descriptor,colorAttachments:Array.from(context.descriptor.colorAttachments,x=>x?{...x,storeOp:'store'}:x)};
  let pass=begin.call(this,{device:context.device,encoder:context.encoder,descriptor},first).passEncoder,drawn=false;const state=new Map();
  const methods=new Set(['setViewport','setScissorRect','setPipeline','setBindGroup','setVertexBuffer','setIndexBuffer','setBlendConstant','setStencilReference']);
  const proxy=new Proxy({}, {get:(_,name)=>{
   if(name==='end')return ()=>pass.end();
   if(methods.has(name))return (...args)=>{const key=name+((name==='setBindGroup'||name==='setVertexBuffer')?':'+args[0]:'');state.set(key,{name,args});return pass[name](...args);};
   if(name==='draw'||name==='drawIndexed')return (...args)=>{if(drawn){pass.end();const next={...descriptor,colorAttachments:Array.from(descriptor.colorAttachments,x=>x?{...x,loadOp:'load'}:x),depthStencilAttachment:descriptor.depthStencilAttachment?{...descriptor.depthStencilAttachment,depthLoadOp:'load'}:undefined};pass=context.encoder.beginRenderPass(next);for(const command of state.values())pass[command.name](...command.args);}drawn=true;return pass[name](...args);};
   const value=pass[name];return typeof value==='function'?value.bind(pass):value;
  }});return {passEncoder:proxy,ownsPass:true};
 };
 }
 const pipeline=new RenderPipeline(rtt);pipeline.add(renderer,{pass:'isolated',loadOp:'clear'});
 const value={rtt,world,renderer,player,pipeline,width,height,document,samples,zeroInactive:false,render(time=0){
  // Reference-only preparation: the original runtime defers inactive source
  // visuals and cannot distinguish them from an invalid source. Materialize
  // only their analytically zero output using its existing public override API.
  if(this.zeroInactive){player.clearNodeOverrides();for(const node of document.nodes){const start=node.start??0,end=start+(node.duration??document.duration);if(time<start||time>end)player.setNodeOverride(node.id,{enabled:true,opacity:0});}}
  player.seek(time);world.update(time*1000,0);return pipeline.execute(world,time*1000,0);
 },resize(w,h){rtt.resize(w,h);this.width=w;this.height=h;},async close(){if(!live.delete(this))return;await engine.device.queue.onSubmittedWorkDone();renderer.destroy();system.destroy();world.destroy();pipeline.clear();rtt.destroy();}};live.add(value);return value;
}
async function pixels(scene){
 const {width,height}=scene,row=Math.ceil(width*4/256)*256,buffer=engine.device.createBuffer({size:row*height,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
 try{const encoder=engine.device.createCommandEncoder();encoder.copyTextureToBuffer({texture:scene.rtt.colorTexture},{buffer,bytesPerRow:row},[width,height]);engine.device.queue.submit([encoder.finish()]);await buffer.mapAsync(GPUMapMode.READ);const source=new Uint8Array(buffer.getMappedRange()),out=new Uint8Array(width*height*4);for(let y=0;y<height;y++)out.set(source.subarray(y*row,y*row+width*4),y*width*4);buffer.unmap();return out;}finally{buffer.destroy();}
}
function png(bytes,width,height){const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;const value=new Uint8ClampedArray(bytes);for(let i=0;i<value.length;i+=4){const alpha=value[i+3];if(alpha)for(let c=0;c<3;c++)value[i+c]=Math.min(255,Math.round(value[i+c]*255/alpha));}canvas.getContext('2d').putImageData(new ImageData(value,width,height),0,0);return canvas.toDataURL();}
async function pair(id,a,b,time,capture=false){
 a.render(time);b.render(time);const [actual,expected]=await Promise.all([pixels(a),pixels(b)]);let maximum=0,different=0,visible=0;
 for(let i=0;i<actual.length;i++){const d=Math.abs(actual[i]-expected[i]);maximum=Math.max(maximum,d);if(d)different++;if(i%4===3&&actual[i]>4)visible++;}
 const row={id,time,width:a.width,height:a.height,maximumChannelDifference:maximum,differentChannels:different,visiblePixels:visible,candidate:a.renderer.stats,reference:b.renderer.stats};cases.push(row);
 const key=JSON.stringify([time,a.width,a.height]),previous=repeatedPixels.get(a)?.get(key);
 if(previous){let actualRepeat=0,referenceRepeat=0;for(let i=0;i<actual.length;i++){actualRepeat=Math.max(actualRepeat,Math.abs(actual[i]-previous.actual[i]));referenceRepeat=Math.max(referenceRepeat,Math.abs(expected[i]-previous.expected[i]));}Object.assign(row,{sameInputCandidateDifference:actualRepeat,sameInputReferenceDifference:referenceRepeat});}
 const memory=repeatedPixels.get(a)??new Map();if(!previous)memory.set(key,{actual,expected});repeatedPixels.set(a,memory);
 if(capture)captures.push({id,actual:png(actual,a.width,a.height),reference:png(expected,b.width,b.height)});
 if(!visible)failures.push(id+': empty output');if(maximum>2)failures.push(id+': maximum pixel channel difference '+maximum);if(a.renderer.stats.maskTargetCount>16)failures.push(id+': production target count exceeded 16');return row;
}
try{
 const canvas=document.createElement('canvas');canvas.style.width='64px';canvas.style.height='64px';document.body.append(canvas);
 engine=new HaiyueEngine({canvas,devicePixelRatio:1,timestampQuery:false,renderProfile:'simple',diagnostics:{enabled:true}});await engine.init();engine.device.addEventListener('uncapturederror',event=>errors.push(event.error.message));engine.device.pushErrorScope('validation');scoped=true;
 const doc=fixture();
 const original=create(reference,doc,320,240,16);let rejection;try{original.render(0);}catch(error){rejection={code:error.code,path:error.path,message:error.message};}check(rejection?.code==='E_ANIMATION_LIMIT_EXCEEDED','original production profile must retain its count failure');cases.push({id:'original-production-16-rejected',rejection});await original.close();
 for(const samples of [1,4]){
  const a=create(candidate,doc,320,240,16,samples),b=create(reference,doc,320,240,64,samples);
  for(const time of [0,.5,1])await pair('synthetic-msaa'+samples+'-t'+time,a,b,time,time===0);
  if(samples===4)for(let repeat=0;repeat<3;repeat++)await pair('synthetic-msaa4-repeated-'+repeat,a,b,1);
  a.resize(400,300);b.resize(400,300);await pair('synthetic-resize-msaa'+samples,a,b,.25);
  await a.close();await b.close();
 }
 const input=await(await fetch('/animation-spec/corpus/.cache/generated/large__monster-mask-stress.hya')).arrayBuffer(),monster=parseAnimation(input);
 const a=create(candidate,monster,1280,1024,16),b=create(reference,monster,1280,1024,64);
 b.zeroInactive=true;
 for(const time of [0,monster.duration/2,monster.duration-.001])await pair('monster-t'+time,a,b,time,time===0);
 await a.close();await b.close();
 const c=create(candidate,doc,320,240);c.render(0);await engine.device.queue.onSubmittedWorkDone();const initial=getEngineDiagnosticsSnapshot(engine).gpuResources;
 c.resize(400,300);const failure={record(){throw Error('intentional cancelled frame');}};c.pipeline.add(failure,{pass:'isolated'});let cancelled=false;try{c.render(.25);}catch(error){check(String(error).includes('intentional cancelled frame'),'unexpected cancellation failure');cancelled=true;}c.pipeline.remove(failure);check(cancelled,'frame did not cancel');
 c.render(.25);await engine.device.queue.onSubmittedWorkDone();const after=getEngineDiagnosticsSnapshot(engine).gpuResources;cases.push({id:'cancelled-resize-resource-accounting',before:initial,after});check(after.byType.texture.current<=initial.byType.texture.current,'cancelled resize leaked retired mask targets');
 const beforeRecovery=await pixels(c),oldDevice=engine.device;const oldValidation=await oldDevice.popErrorScope();scoped=false;if(oldValidation)errors.push(oldValidation.message);
 c.renderer.suspendForDeviceLoss();oldDevice.destroy();await oldDevice.lost;await engine.waitForRecovery();check(engine.device!==oldDevice,'native recovery did not replace its GPUDevice');engine.device.addEventListener('uncapturederror',event=>errors.push(event.error.message));engine.device.pushErrorScope('validation');scoped=true;
 c.rtt.resize(c.width,c.height);c.renderer.recoverGpuResource(engine.device,new AbortController().signal);c.render(.25);const recovered=await pixels(c);let recoveryDifference=0;for(let i=0;i<recovered.length;i++)recoveryDifference=Math.max(recoveryDifference,Math.abs(recovered[i]-beforeRecovery[i]));cases.push({id:'actual-device-loss-and-recovery',maximumChannelDifference:recoveryDifference,stats:c.renderer.stats});check(recoveryDifference<=2,'device recovery changed pixels');await c.close();
 const validation=await engine.device.popErrorScope();scoped=false;if(validation)errors.push(validation.message);check(!errors.length,errors.join(';'));
 const beforeDestroy=getEngineDiagnosticsSnapshot(engine).gpuResources;engine.destroy();const afterDestroy=getEngineDiagnosticsSnapshot(engine).gpuResources;check(afterDestroy.totals.resources===0,'Engine destruction left tracked GPU resources');
 const status=failures.length?'failed':'passed';
 result.textContent=JSON.stringify({status,caseCount:cases.length,cases,captures,errors,failures,beforeDestroy,afterDestroy,referenceProfile:'Stateful original renderer with explicit per-draw store/load boundaries in the reference host only. Same-input original/original variation up to 4 is retained as diagnostic evidence; its internal driver cause is not asserted. Geometry, shader, material, sampling and blend order remain original. The pixel oracle alone permits 64 targets; candidate production remains at 16. Time-inactive real corpus sources are materialized through original public opacity-zero overrides, preserving analytically transparent output.',qualification:'Actual packed animation modules, real WebGPU pixels and target accounting; not full composed HYA player, physical Native or performance qualification'});result.dataset.status=status;
}catch(error){result.textContent=JSON.stringify({status:'failed',error:String(error.stack??error),cases,captures,errors,failures});result.dataset.status='failed';}
finally{for(const value of [...live])try{await value.close();}catch{}if(scoped)try{await engine.device.popErrorScope();}catch{}try{engine?.destroy();}catch{}}
