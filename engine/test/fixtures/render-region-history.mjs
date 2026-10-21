import {RenderPipeline,RenderView,RenderFrameContext,Entity,World,GPUResourceTracker,createGPUResourceOwner} from '/engine/dist/experimental.js';
import {RttEngine} from '/engine/dist/rtt.js';

const width=64,height=48,canvas=document.querySelector('canvas'),result=document.querySelector('#result'),progress=document.querySelector('#progress');
const cases=[],errors=[],live=new Set(),check=(v,m)=>{if(!v)throw Error(m)};
const hash=async b=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',b)),n=>n.toString(16).padStart(2,'0')).join('');
const half=n=>{const sign=n&32768?-1:1,e=(n>>>10)&31,m=n&1023;return sign*(e===0?m*2**-24:e===31?(m?NaN:Infinity):(1+m/1024)*2**(e-15));};
const red={rect:[1,2,8,7],color:[.8,.1,.2,.5]},green={rect:[5,4,9,8],color:[.1,.8,.2,.5]},blue={rect:[2,10,7,5],color:[.1,.2,.8,.5]};
let device,tracker,summary,scope=false;
try{
 const adapter=await navigator.gpu.requestAdapter({powerPreference:'high-performance'});check(adapter&&!adapter.info.isFallbackAdapter,'Native WebGPU required');device=await adapter.requestDevice();device.pushErrorScope('validation');scope=true;device.addEventListener('uncapturederror',e=>errors.push(e.error.message));
 tracker=new GPUResourceTracker({debug:true});tracker.instrumentDevice(device,createGPUResourceOwner('system','g04-independent-history'));
 const calls={encoders:0,submits:0,acquisitions:0},create=device.createCommandEncoder.bind(device),submit=device.queue.submit.bind(device.queue);
 Object.defineProperty(device,'createCommandEncoder',{configurable:true,value:(...args)=>{calls.encoders++;return create(...args)}});
 Object.defineProperty(device.queue,'submit',{configurable:true,value:(...args)=>{calls.submits++;return submit(...args)}});
 const snapshot=()=>({...calls}),delta=(a,b)=>Object.fromEntries(Object.keys(a).map(k=>[k,b[k]-a[k]]));
 const shaders=new Map();
 function draw(context,commands){
  const view=context.view,pass=context.beginPass(),viewport=view.viewport??{x:0,y:0,width:view.width,height:view.height};
  for(const command of commands){
   const key=JSON.stringify([view.sampleCount,command.color]);let pipeline=shaders.get(key);
   if(!pipeline){const [r,g,b,a]=command.color,module=device.createShaderModule({label:'G04 test-only solid rectangle',code:`@vertex fn vs(@builtin(vertex_index) i:u32)->@builtin(position) vec4f {let p=array<vec2f,3>(vec2f(-1.,-1.),vec2f(3.,-1.),vec2f(-1.,3.));return vec4f(p[i],0.,1.);} @fragment fn fs()->@location(0) vec4f{return vec4f(${r*a},${g*a},${b*a},${a});}`});
    pipeline=device.createRenderPipeline({label:'G04 independent-history paint',layout:'auto',vertex:{module,entryPoint:'vs'},fragment:{module,entryPoint:'fs',targets:[{format:'rgba16float',blend:{color:{srcFactor:'one',dstFactor:'one-minus-src-alpha',operation:'add'},alpha:{srcFactor:'one',dstFactor:'one-minus-src-alpha',operation:'add'}}}]},multisample:{count:view.sampleCount}});shaders.set(key,pipeline);
   }
   const [x,y,w,h]=command.rect,sx=viewport.width/view.displayWidth,sy=viewport.height/view.displayHeight;
   pass.setPipeline(pipeline);pass.setViewport(viewport.x+x*sx,viewport.y+y*sy,w*sx,h*sy,0,1);pass.draw(3);
  }
 }
 function fixture(samples,clearMode,initialDisabled=false){
  const world=new World(),engine={device,canvas,width,height,displayWidth:width,displayHeight:height,format:'rgba16float',msaaSamples:samples,reverseZ:false,clearColor:{r:.02,g:.04,b:.06,a:.4},getDepthFormat:()=> 'depth24plus'};
  let output=new RttEngine(engine,width,height,engine.clearColor,'G04 history output',null,'rgba16float'),version=0,frame=0;output.msaaSamples=samples;
  const target={key:'same-history-target',format:'rgba16float',width,height,displayWidth:width,displayHeight:height,getOutputView(){calls.acquisitions++;return output.getOutputView()},getRenderPassDescriptor:o=>output.getRenderPassDescriptor(o),getRenderPassDescriptorVersion:()=>version};
  engine.getRenderPassDescriptor=()=>target.getRenderPassDescriptor();
  const view=new RenderView({camera:new Entity(),target,sampleCount:samples,clearColor:engine.clearColor}),pipeline=new RenderPipeline(engine);
  const bounds={x:4,y:4,width:24,height:24},region=view.createRegion({id:'history',bounds,updateMode:initialDisabled?'disabled':'once',clearMode,visible:true}),dynamic=view.createRegion({id:'continuous',bounds:{x:40,y:0,width:24,height},updateMode:'continuous',clearMode:'on-update',visible:true});
  let commands=[red],records=0,dynamicRecords=0,layer=new Float64Array(bounds.width*bounds.height*4),visible=true,dynamicColor=[.1,.2,.3,1];
  const producer={record(_world,context){records++;draw(context,commands)}},scene={record(_world,context){dynamicRecords++;draw(context,[{rect:[0,0,24,height],color:dynamicColor}])}};
  pipeline.add(producer,{region,depth:false});pipeline.add(scene,{region:dynamic,depth:false});
  // This oracle owns only numeric pixels. It does not use the runtime's targets,
  // scheduling state, composition shaders or cache implementation.
  function model({update=false,reset=false}={}){
   if(reset||update&&clearMode==='on-update')layer=new Float64Array(bounds.width*bounds.height*4);
   if(update)for(const {rect:[x,y,w,h],color:[r,g,b,a]}of commands)for(let yy=y;yy<Math.min(y+h,bounds.height);yy++)for(let xx=x;xx<Math.min(x+w,bounds.width);xx++){const i=(yy*bounds.width+xx)*4;for(const [channel,value]of [r*a,g*a,b*a,a].entries())layer[i+channel]=value+layer[i+channel]*(1-a);}
   const color=view.clearColor,expected=new Float32Array(width*height*4);
   for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    const i=(y*width+x)*4;expected.set([color.r,color.g,color.b,color.a],i);
    if(visible&&x>=bounds.x&&x<bounds.x+bounds.width&&y>=bounds.y&&y<bounds.y+bounds.height){const j=((y-bounds.y)*bounds.width+x-bounds.x)*4,a=layer[j+3];for(let c=0;c<4;c++)expected[i+c]=layer[j+c]+expected[i+c]*(1-a);}
    if(x>=40)expected.set(dynamicColor,i);
   }return expected;
  }
  async function pixels(){const read=device.createBuffer({label:'G04 raw half history readback',size:width*8*height,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ}),encoder=device.createCommandEncoder();encoder.copyTextureToBuffer({texture:output.colorTexture},{buffer:read,bytesPerRow:width*8},[width,height]);device.queue.submit([encoder.finish()]);await read.mapAsync(GPUMapMode.READ);const raw=new Uint16Array(read.getMappedRange()).slice(),values=Float32Array.from(raw,half);read.unmap();read.destroy();return {raw,values};}
  const f={region,dynamic,pipeline,view,world,get records(){return records},get dynamicRecords(){return dynamicRecords},set commands(value){commands=value},set visible(value){visible=value;region.setVisible(value)},
   render(context){const before=snapshot(),beforeRecords=records,beforeDynamic=dynamicRecords;const ctx=pipeline.execute(world,++frame*16,16,{view,...(context?{context}:{})});return{context:ctx,calls:delta(before,snapshot()),producerRecords:records-beforeRecords,dynamicRecords:dynamicRecords-beforeDynamic,stats:pipeline.getDebugSnapshot().regions,gpuResourceSnapshot:tracker.getDebugSnapshot().byType};},
   poison(){const encoder=device.createCommandEncoder(),pass=encoder.beginRenderPass({colorAttachments:[{view:output.getOutputView(),loadOp:'clear',storeOp:'store',clearValue:{r:3,g:0,b:2,a:.8}}]});pass.end();device.queue.submit([encoder.finish()]);},
   move(next){Object.assign(bounds,next);region.setBounds(bounds);},
   replaceProducer(){pipeline.remove(producer);pipeline.add(producer,{region,depth:false});},
   async replaceOutput(){await device.queue.onSubmittedWorkDone();const old=output;output=new RttEngine(engine,width,height,engine.clearColor,'G04 replaced history output',null,'rgba16float');output.msaaSamples=samples;version++;old.destroy();},
   async capture(id,options={},expectedRecords=0){
    dynamicColor=[.1+(frame%3)*.07,.2,.3,1];f.poison();const facts=f.render();check(facts.producerRecords===expectedRecords,`${id}: expected ${expectedRecords} producer records, got ${facts.producerRecords}`);check(facts.dynamicRecords===1,`${id}: continuous producer stopped`);
    const expected=model(options),actual=await pixels();let max=0,bad=0,first;
    for(let i=0;i<expected.length;i++){const difference=Math.abs(expected[i]-actual.values[i]);max=Math.max(max,difference);if(!Number.isFinite(actual.values[i])||difference>2/255){bad++;first??={channel:i,actual:actual.values[i],expected:expected[i]};}}
    check(!bad,`${id}: ${bad} channels differ, max ${max}; ${JSON.stringify(first)}`);
    cases.push({id:`${id}-${clearMode}-${samples}`,clearMode,samples,channelsCompared:expected.length,maxRawChannelDifference:max,maxChannelDifference:max*255,sha256:await hash(actual.raw),referenceSha256:await hash(expected),regional:{...facts,context:undefined}});return facts;
   },
   async destroy(){pipeline.clear();world.destroy();view.destroy();output.destroy();await device.queue.onSubmittedWorkDone();await Promise.resolve();live.delete(f);}
  };live.add(f);return f;
 }
 for(const samples of [1,4])for(const mode of ['on-update','once','never-after-initialization']){
  const id=`${mode}-${samples}`;progress.textContent=id;const f=fixture(samples,mode);
  await f.capture('initial',{update:true,reset:true},1);
  await f.capture('unchanged-no-alpha-accumulation');
  f.region.invalidate('once retains dirty until a request');await f.capture('invalidate-once-no-update');
  f.commands=[green];f.region.requestOnce();await f.capture('requested-once',{update:true},1);
  f.view.clearColor={r:.12,g:.025,b:.08,a:.65};await f.capture('parent-clear-only');
  f.region.setMode('disabled');f.region.requestOnce();f.commands=[blue];await f.capture('disabled-keeps-pixels-and-pulse');
  f.region.setMode('once');await f.capture('reenable-consumes-request',{update:true},1);
  f.visible=false;f.region.requestOnce();f.commands=[red];await f.capture('hidden-retains-request');await f.capture('hidden-repeat');
  f.visible=true;await f.capture('visible-first-frame',{update:true},1);
  f.region.setMode('demand');f.region.invalidate('new demand paint');f.commands=[green];await f.capture('demand-update',{update:true},1);
  f.region.setMode('once');f.region.requestOnce();f.region.invalidate('cancelled once');f.commands=[blue];const borrowed=new RenderFrameContext({device,getRenderPassDescriptor:()=>undefined},{view:f.view});const cancelled=f.render(borrowed);check(cancelled.producerRecords===1&&!borrowed.submitted,'Borrowed attempt must record without submitting');borrowed.cancel();
  const retried=await f.capture('cancel-retry-preserves-history',{update:true},1);cases.at(-1).cancelledAttempt={producerRecords:cancelled.producerRecords,submitted:borrowed.submitted,calls:cancelled.calls};check(retried.context.submitted,'Retry did not submit');
  f.commands=[red];f.move({x:7,y:9});await f.capture('move-clears-new-generation',{update:true,reset:true},1);
  f.commands=[green];f.move({width:16,height:16});await f.capture('resize-clears-new-generation',{update:true,reset:true},1);
  f.commands=[blue];f.replaceProducer();await f.capture('producer-replacement-initializes',{update:true,reset:true},1);
  f.region.setMode('disabled');await f.replaceOutput();await f.capture('attachment-replacement-preserves-cache');
  f.dynamic.setMode('demand');f.render();const idle=f.render();check(!idle.context.submitted&&idle.calls.encoders===0&&idle.calls.submits===0&&idle.calls.acquisitions===0&&idle.producerRecords===0&&idle.dynamicRecords===0,'All idle frame performed work');cases.push({id:`all-idle-${id}`,clearMode:mode,samples,regional:{...idle,context:undefined}});
  f.dynamic.setMode('continuous');await f.capture('wake-disabled-cache');
  f.visible=false;f.region.dispose();await f.capture('remove-no-old-location');await f.destroy();
  const disabled=fixture(samples,mode,true);await disabled.capture('disabled-initial-transparent',{reset:true});await disabled.destroy();
 }
 const validation=await device.popErrorScope();scope=false;if(validation)errors.push(validation.message);check(!errors.length,errors.join('; '));const residue=tracker.getDebugSnapshot().byType;check((residue.texture?.current??0)===0&&(residue.buffer?.current??0)===0,'History buffer/texture residue');
 summary={status:'passed',caseCount:cases.length,cases,errors,residue,adapter:{vendor:adapter.info.vendor,architecture:adapter.info.architecture,device:adapter.info.device,description:adapter.info.description,isFallbackAdapter:adapter.info.isFallbackAdapter},gpuDuration:{status:'not-measured'},qualification:'Native retained region history vs independent numeric premultiplied CPU layers, all pixels, MSAA1/4 and three clear modes. Includes once/dirty, disabled/hidden requests, parent clear and same-key output attachment replacement, sequential cancel/retry, move/resize/producer replacement, poisoned output, idle/wake and cleanup. Test-only rectangle producers; does not qualify GUI overlays, arbitrary unsubmitted frames, multi-view or full G04/G13.'};
}catch(error){if(scope){const e=await device.popErrorScope();scope=false;if(e)errors.push(e.message)}summary={status:'failed',caseCount:cases.length,cases,errors,error:String(error.stack??error)}}
finally{for(const f of live)await f.destroy();device?.destroy()}
result.textContent=JSON.stringify(summary);result.dataset.status=summary.status;
