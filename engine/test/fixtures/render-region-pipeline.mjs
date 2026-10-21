import {RenderPipeline,RenderView,Entity,World,FrameDiagnostics,GPUResourceTracker,createGPUResourceOwner} from '/engine/dist/experimental.js';
import {GuiRoot,GuiElement,GuiLabel,GuiImage,GuiSystem,GuiButton} from '/engine/dist/gui.js';

const result=document.querySelector('#result'),progress=document.querySelector('#progress'),canvas=document.querySelector('canvas');
const check=(v,m)=>{if(!v)throw Error(m)},digest=async b=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',b)),n=>n.toString(16).padStart(2,'0')).join('');
const cases=[],errors=[],live=new Set();let device,summary;
try{
 await document.fonts.ready;
 const adapter=await navigator.gpu.requestAdapter({powerPreference:'high-performance'});check(adapter&&!adapter.info.isFallbackAdapter,'Native adapter required');device=await adapter.requestDevice();
 device.pushErrorScope('validation');device.addEventListener('uncapturederror',e=>errors.push(e.error.message));
 const diagnostics=new FrameDiagnostics({enabled:true}),tracker=new GPUResourceTracker({debug:true,frameDiagnostics:diagnostics});tracker.instrumentDevice(device,createGPUResourceOwner('system','g04-native-regional-GUI'));
 const calls={encoders:0,submits:0,uploads:0,uploadBytes:0};
 const encode=device.createCommandEncoder.bind(device);Object.defineProperty(device,'createCommandEncoder',{configurable:true,value:(...args)=>{calls.encoders++;return encode(...args)}});
 const submit=device.queue.submit.bind(device.queue);Object.defineProperty(device.queue,'submit',{configurable:true,value:(...args)=>{calls.submits++;return submit(...args)}});
 const write=device.queue.writeBuffer.bind(device.queue);Object.defineProperty(device.queue,'writeBuffer',{configurable:true,value:(...args)=>{calls.uploads++;calls.uploadBytes+=args[4]??args[2].byteLength;return write(...args)}});
 const snapshot=()=>({...calls});
 const delta=(a,b)=>Object.fromEntries(Object.keys(a).map(k=>[k,b[k]-a[k]]));
 function fixture(samples,cache){
  // Independent offscreen reference worlds retain equal logical focus; synthetic replay
  // must not move the document focus between them. Native focus is covered by G05.
  const inputCanvas=canvas.cloneNode();inputCanvas.focus=()=>{};document.body.append(inputCanvas);
  const width=128,height=80,format='rgba8unorm',world=new World(),textures=[];let acquired=0,frame=0;
  const make=(label,format,sampleCount=1)=>{const t=device.createTexture({label,size:[width,height],format,sampleCount,usage:GPUTextureUsage.RENDER_ATTACHMENT|(sampleCount===1&&format==='rgba8unorm'?GPUTextureUsage.COPY_SRC:0)});textures.push(t);return t};
  const output=make('G04 full output',format),msaa=samples===4?make('G04 output MSAA',format,4):null,depth=make('G04 output depth','depth24plus',samples);
  const target={key:`output-${samples}-${cache}`,format,width,height,displayWidth:width,displayHeight:height,getOutputView(){acquired++;return output.createView()},getRenderPassDescriptor(){return{colorAttachments:[{view:msaa?msaa.createView():this.getOutputView(),...(msaa?{resolveTarget:this.getOutputView()}:{}),loadOp:'clear',storeOp:'store',clearValue:{r:0,g:0,b:0,a:0}}],depthStencilAttachment:{view:depth.createView(),depthLoadOp:'clear',depthStoreOp:'store',depthClearValue:1}}}};
  const engine={device,canvas:inputCanvas,format,width,height,displayWidth:width,displayHeight:height,msaaSamples:samples,reverseZ:false,clearColor:{r:0,g:0,b:0,a:0},getDepthFormat:()=> 'depth24plus',getRenderPassDescriptor:()=>target.getRenderPassDescriptor()};
  const view=new RenderView({camera:new Entity(),target,sampleCount:samples,clearColor:engine.clearColor}),pipeline=new RenderPipeline(engine);
  const root=new GuiRoot({theme:{radius:0,fontSize:12}}),background=root.add(new GuiElement({width:'100%',height:'100%',style:{backgroundColor:'#4060a080',radius:0}}));
  root.add(new GuiElement({x:2,y:3,width:27,height:20,style:{backgroundColor:'#e0404080',radius:6}}));
  const label=root.add(new GuiLabel({x:3,y:27,width:44,height:17,text:'GUI',fontSize:12,style:{color:'#d0f090b0'}}));
  const imageCanvas=document.createElement('canvas');imageCanvas.width=imageCanvas.height=8;const imageContext=imageCanvas.getContext('2d');imageContext.fillStyle='rgba(60,180,220,0.5)';imageContext.fillRect(0,0,8,8);
  const image=root.add(new GuiImage({x:7,y:50,width:21,height:18,source:imageCanvas,tint:'#e0a0ffb0'}));
  const sceneRoot=new GuiRoot({theme:{radius:0}}),sceneBackground=sceneRoot.add(new GuiElement({width:'100%',height:'100%',style:{backgroundColor:'#208040',radius:0}}));let clicks=0;
  sceneRoot.add(new GuiButton({x:12,y:20,width:36,height:20,text:'',onClick:()=>{clicks++;label.setText('AB')}}));
  const ui=new GuiSystem(engine,{roots:new Set([root]),font:{chars:'GUIAB? ',fontSize:12,atlasSize:128}}),scene=new GuiSystem(engine,{roots:new Set([sceneRoot]),font:{chars:'? ',atlasSize:64}});
  world.addEntity(new Entity().addComponent(root));world.addEntity(new Entity().addComponent(sceneRoot));world.addSystem(ui);world.addSystem(scene);
  const side=view.createRegion({id:'sidebar',bounds:{x:0,y:0,width:48,height},updateMode:'demand',clearMode:'on-update',visible:true}),dynamic=view.createRegion({id:'scene',bounds:{x:48,y:0,width:80,height},updateMode:'continuous',clearMode:'on-update',visible:true});
  const recordCounts={ui:0,scene:0},guiUploads=[];let solves=0;
  const layout=root.root.layout.bind(root.root);root.root.layout=(...args)=>{solves++;return layout(...args)};
  for(const [system,key]of [[ui,'ui'],[scene,'scene']]){const record=system.record.bind(system);system.record=(...args)=>{const before=snapshot();recordCounts[key]++;const value=record(...args);if(key==='ui')guiUploads.push(delta(before,snapshot()));return value}}
  pipeline.add(ui,{region:side});pipeline.add(scene,{region:dynamic});
  const f={inputCanvas,pipeline,world,ui,scene,root,background,label,image,imageCanvas,side,dynamic,sceneBackground,recordCounts,guiUploads,latest:null,get solves(){return solves},get acquired(){return acquired},get clicks(){return clicks},
   render(){diagnostics.beginFrame();const before=snapshot(),a=acquired,start=performance.now();const context=pipeline.execute(world,++frame*16,16,{view,regionCache:cache}),facts={cpuMs:performance.now()-start,calls:delta(before,snapshot()),acquisitions:acquired-a,stats:pipeline.getDebugSnapshot().regions};f.latest=facts;return {context,...facts}},
   async pixels(){const read=device.createBuffer({label:'G04 full pixel readback',size:width*4*height,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ}),encoder=device.createCommandEncoder();encoder.copyTextureToBuffer({texture:output},{buffer:read,bytesPerRow:width*4},[width,height]);device.queue.submit([encoder.finish()]);const wait=performance.now();await read.mapAsync(GPUMapMode.READ);const pixels=new Uint8Array(read.getMappedRange()).slice(),queueAndReadbackWaitMs=performance.now()-wait;read.unmap();read.destroy();return {pixels,queueAndReadbackWaitMs}},
   poison(){const encoder=device.createCommandEncoder(),pass=encoder.beginRenderPass({colorAttachments:[{view:output.createView(),loadOp:'clear',storeOp:'store',clearValue:{r:1,g:0,b:1,a:1}}]});pass.end();device.queue.submit([encoder.finish()])},
   async destroy(){pipeline.clear();world.destroy();view.destroy();for(const t of textures)t.destroy();await device.queue.onSubmittedWorkDone();await Promise.resolve();inputCanvas.remove();live.delete(f)}
  };live.add(f);return f;
 }
 const linear=n=>n<=0.04045?n/12.92:((n+0.055)/1.055)**2.4,srgb=n=>n<=0.0031308?n*12.92:1.055*n**(1/2.4)-0.055;
 const over=(top,base)=>{const alpha=top[3]+base[3]*(1-top[3]);return [0,1,2].map(i=>(top[i]*top[3]+base[i]*base[3]*(1-top[3]))/alpha).concat(alpha)};
 const byte=c=>c.slice(0,3).map(v=>Math.round(srgb(v)*c[3]*255)).concat(Math.round(c[3]*255));
 const bg=[64,96,160].map(v=>linear(v/255)).concat(128/255);
 const checkPoint=(pixels,x,y,expected,id)=>{const actual=Array.from(pixels.slice((y*128+x)*4,(y*128+x)*4+4));check(actual.every((v,i)=>Math.abs(v-expected[i])<=2),`${id}: ${actual} != ${expected}`);return {x,y,actual,expected}};
 const compare=async(id,cached,direct)=>{
  const a=await cached.pixels(),b=await direct.pixels();let max=0,changed=0;
  for(let p=0;p<a.pixels.length;p++){const d=Math.abs(a.pixels[p]-b.pixels[p]);max=Math.max(max,d);if(d>2)changed++}
  check(!changed,`${id}: ${changed} channels differ >2 (max ${max})`);
  check(a.pixels.some((v,i)=>i%4!==3&&v>0),'Empty GUI reference');
  const independentOracles=[checkPoint(a.pixels,1,72,byte(bg),id+' background transfer/alpha'),checkPoint(a.pixels,10,10,byte(over([224,64,64].map(v=>linear(v/255)).concat(128/255),bg)),id+' translucent shapes')];
  if(id.startsWith('transparent-shape')){const imageColor=[60,180,220].map((v,i)=>linear(v/255)*linear([224,160,255][i]/255)).concat((128/255)*(176/255));independentOracles.push(checkPoint(a.pixels,13,57,byte(over(imageColor,bg)),id+' translucent image/tint'))}
  cases.push({id,pixels:128*80,channelsCompared:a.pixels.length,maxChannelDifference:max,independentOracles,sha256:await digest(a.pixels),referenceSha256:await digest(b.pixels),queueAndReadbackWaitMs:a.queueAndReadbackWaitMs+ b.queueAndReadbackWaitMs,cachedFrame:cached.latest,directFrame:direct.latest});
 };
 for(const samples of [1,4]){
  progress.textContent='Regional GUI MSAA '+samples;
  const cached=fixture(samples,true),direct=fixture(samples,false);
  cached.render();direct.render();await compare('transparent-shape-text-image-'+samples,cached,direct);
  const before={...cached.recordCounts},solves=cached.solves,uploads=cached.guiUploads.length;
  cached.poison();direct.poison();cached.render();direct.render();await compare('fresh-whole-presentation-'+samples,cached,direct);
  check(cached.recordCounts.ui===before.ui&&cached.recordCounts.scene===before.scene+1,'Static GUI was redrawn or continuous scene paused');check(cached.solves===solves&&cached.guiUploads.length===uploads,'Static GUI layout/upload did not stay zero');
  cases.at(-1).staticGui={producerRecords:cached.recordCounts.ui-before.ui,recursiveLayoutSolves:cached.solves-solves,uploadCalls:0,uploadBytes:0,continuousProducerRecords:cached.recordCounts.scene-before.scene};
  cached.label.setText('AB');direct.label.setText('AB');cached.render();direct.render();await compare('program-first-frame-'+samples,cached,direct);
  cached.root.remove(cached.image);direct.root.remove(direct.image);cached.render();direct.render();await compare('remove-image-no-old-pixels-'+samples,cached,direct);
  cached.dynamic.setMode('demand');cached.render();const idle=cached.render();check(!idle.context.submitted&&idle.calls.encoders===0&&idle.calls.submits===0&&idle.acquisitions===0,'Idle acquired or submitted GPU work');cases.push({id:'native-all-idle-'+samples,...idle,context:undefined});
  cached.label.setText('GUI');cached.render();check(cached.pipeline.getDebugSnapshot().regions.updates===1,'Program invalidation did not wake only GUI');
  for(const host of [cached,direct]){const rect=host.inputCanvas.getBoundingClientRect();for(const type of ['pointerdown','pointerup'])host.inputCanvas.dispatchEvent(new PointerEvent(type,{clientX:rect.left+66,clientY:rect.top+30,pointerId:4,buttons:type==='pointerdown'?1:0,button:0}));}
  const interaction=cached.render();check(cached.clicks===1&&cached.label.text==='AB','Nonzero logical region origin input did not reach the button');check(interaction.stats.updates===2,'Cross-root interaction was not included in the first presented frame');
  direct.render();await compare('nonzero-region-input-first-present-'+samples,cached,direct);cases.at(-1).interaction={clicks:cached.clicks,label:cached.label.text,calls:interaction.calls,stats:interaction.stats};
  await cached.destroy();await direct.destroy();
 }
 const validation=await device.popErrorScope();check(!validation,'Validation: '+validation?.message);check(!errors.length,'Uncaptured validation errors: '+errors.join('; '));
 const residue=tracker.getDebugSnapshot().byType;check((residue.texture?.current??0)===0&&(residue.buffer?.current??0)===0,'Regional GUI resource residue');
 summary={status:'passed',caseCount:cases.length,cases,residue,errors,adapter:{vendor:adapter.info.vendor,architecture:adapter.info.architecture,device:adapter.info.device,description:adapter.info.description,isFallbackAdapter:adapter.info.isFallbackAdapter},gpuDuration:{status:'not-measured'},qualification:'Native GUI direct/cache whole-frame pixels and independent CPU color oracles, transparent shape/text/image, MSAA 1/4, program/remove invalidation, poisoned previous presentation, structural GUI skip, all-idle and unsnapped regional input. Not full G04 or formal performance qualification.'};
}catch(error){summary={status:'failed',error:String(error.stack??error),cases,errors}}
finally{for(const f of live)await f.destroy();device?.destroy()}
result.textContent=JSON.stringify(summary);result.dataset.status=summary.status;
