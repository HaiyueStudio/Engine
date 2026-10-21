import {RenderPipeline,RenderView,RenderFrameContext,Entity,World,FrameDiagnostics,GPUResourceTracker,createGPUResourceOwner} from '/engine/dist/experimental.js';
import {RttEngine} from '/engine/dist/rtt.js';
import {GuiRoot,GuiElement,GuiLabel,GuiImage,GuiSystem,GuiButton} from '/engine/dist/gui.js';
import {SceneOutputPass} from '/region-target-build/region-copy.js';

const result=document.querySelector('#result'),progress=document.querySelector('#progress'),canvas=document.querySelector('canvas');
const check=(v,m)=>{if(!v)throw Error(m)},digest=async b=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',b)),n=>n.toString(16).padStart(2,'0')).join('');
const surfaceMode=new URLSearchParams(location.search).get('surface')==='1';
const cases=[],errors=[],live=new Set();let device,summary;
try{
 await document.fonts.ready;
 const adapter=await navigator.gpu.requestAdapter({powerPreference:'high-performance'});check(adapter&&!adapter.info.isFallbackAdapter,'Native adapter required');device=await adapter.requestDevice();device.pushErrorScope('validation');device.addEventListener('uncapturederror',e=>errors.push(e.error.message));
 const diagnostics=new FrameDiagnostics({enabled:true}),tracker=new GPUResourceTracker({debug:true,frameDiagnostics:diagnostics});tracker.instrumentDevice(device,createGPUResourceOwner('system','g04-clipped-region'));
 let encoders=0,submits=0;const encode=device.createCommandEncoder.bind(device),submit=device.queue.submit.bind(device.queue);
 Object.defineProperty(device,'createCommandEncoder',{configurable:true,value:(...args)=>{encoders++;return encode(...args)}});Object.defineProperty(device.queue,'submit',{configurable:true,value:(...args)=>{submits++;return submit(...args)}});
 const rects=[{id:'left-top',x:-17.25,y:-9.5,width:97.75,height:63.25},{id:'right-bottom',x:87.25,y:49.5,width:64.5,height:51.5},{id:'fractional-inside',x:13.25,y:7.5,width:75.5,height:53.25}];
 function fixture(samples,dpr,bounds,cached,forceDirect=false,clearColor={r:0,g:0,b:0,a:0}){
  const logicalWidth=surfaceMode?129:128,logicalHeight=surfaceMode?81:80,width=Math.floor(logicalWidth*dpr),height=Math.floor(logicalHeight*dpr),dx=width/logicalWidth,dy=height/logicalHeight,world=new World();let frame=0,acquired=0,records=0,clicks=0;
  const engine={device,canvas,format:'rgba8unorm',width,height,displayWidth:logicalWidth,displayHeight:logicalHeight,msaaSamples:samples,reverseZ:false,clearColor,getDepthFormat:()=> 'depth24plus'};
  const output=new RttEngine(engine,width,height,clearColor,'clip-output',null,'rgba8unorm');output.msaaSamples=samples;
  const wrap=(target,present=false)=>({key:target.key,format:target.format,width,height,displayWidth:logicalWidth,displayHeight:logicalHeight,getOutputView(){if(present)acquired++;return target.getOutputView()},getRenderPassDescriptor:options=>target.getRenderPassDescriptor(options)});
  const target=wrap(output,true),view=new RenderView({camera:new Entity(),target,sampleCount:samples,clearColor});
  const alpha=Math.max(0,Math.min(1,clearColor.a)),coverage=alpha===0?1:alpha,decode=v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4,linearClear={r:decode(clearColor.r/coverage)*coverage,g:decode(clearColor.g/coverage)*coverage,b:decode(clearColor.b/coverage)*coverage,a:alpha};
  const linear=cached?null:new RttEngine(engine,width,height,linearClear,'direct-full-GUI',null,'rgba16float');if(linear)linear.msaaSamples=samples;
  const left=Math.max(0,Math.floor(bounds.x*dx)),top=Math.max(0,Math.floor(bounds.y*dy)),right=Math.min(width,Math.ceil((bounds.x+bounds.width)*dx)),bottom=Math.min(height,Math.ceil((bounds.y+bounds.height)*dy));
  const directView=linear?new RenderView({camera:view.camera,target:wrap(linear),sampleCount:samples,clearColor:linearClear,scissor:{x:left,y:top,width:right-left,height:bottom-top}}):null;
  const root=new GuiRoot({x:cached?0:bounds.x,y:cached?0:bounds.y,width:bounds.width,height:bounds.height,theme:{radius:0,fontSize:12}});
  root.add(new GuiElement({width:'100%',height:'100%',style:{backgroundColor:'#4060a080',radius:0}}));
  root.add(new GuiElement({x:2,y:3,width:35,height:22,style:{backgroundColor:'#e0404080',radius:6}}));
  root.add(new GuiElement({x:37,y:6,width:55,height:41,style:{backgroundColor:'#50e080a0',radius:8}}));
  const label=root.add(new GuiLabel({x:3,y:27,width:90,height:17,text:'GUIABCDEFG',fontSize:12,style:{color:'#d0f090b0'}}));
  const imageCanvas=document.createElement('canvas');imageCanvas.width=imageCanvas.height=8;const ctx=imageCanvas.getContext('2d');ctx.fillStyle='rgba(60,180,220,0.5)';ctx.fillRect(0,0,8,8);ctx.fillStyle='rgba(240,40,70,0.8)';ctx.fillRect(0,0,4,4);
  root.add(new GuiImage({x:7,y:44,width:36,height:18,source:imageCanvas,tint:'#e0a0ffb0'}));
  root.add(new GuiButton({x:22,y:5,width:30,height:16,text:'',onClick:()=>{clicks++;label.setText('AB')}}));
  const ui=new GuiSystem(engine,{roots:new Set([root]),loadOp:cached?'load':'clear',font:{chars:'GUIABCDEFGAB? ',fontSize:12,atlasSize:256}});world.addEntity(new Entity().addComponent(root));world.addSystem(ui);
  const record=ui.record.bind(ui);ui.record=(...args)=>{records++;return record(...args)};
  const pipeline=new RenderPipeline(engine);let region,continuous;
  if(cached){region=view.createRegion({id:'clipped-gui',bounds,visible:true,updateMode:'demand',clearMode:'on-update'});continuous=view.createRegion({id:'presentation-clock',bounds:{x:logicalWidth-1,y:logicalHeight-1,width:1,height:1},visible:true,updateMode:'continuous',clearMode:'on-update'});pipeline.add(ui,{region});pipeline.add({record(){}},{region:continuous})}
  else pipeline.add(ui,{loadOp:'clear'});
  const copy=linear?new SceneOutputPass():null;if(copy)copy.prepare(device);
  const f={root,region,continuous,get records(){return records},get clicks(){return clicks},latest:null,logicalWidth,logicalHeight,
   suspend(field){const value=target[field];target[field]=0;return()=>{target[field]=value}},
   render(){diagnostics.beginFrame();const before={encoders,submits,acquired,records},start=performance.now();let context;
    if(cached)context=pipeline.execute(world,++frame*16,16,{view,regionCache:!forceDirect});
    else{context=new RenderFrameContext(engine,{view:directView});pipeline.execute(world,++frame*16,16,{view:directView,context});context.endPass();copy.setFrameIdentity(frame,'direct-output');copy.configure('rgba8unorm',1,'none',view.snapshot());copy.apply(context.encoder,linear.colorTexture,target.getOutputView(),device);context.submit()}
    f.latest={cpuMs:performance.now()-start,encoders:encoders-before.encoders,submits:submits-before.submits,acquired:acquired-before.acquired,producerRecords:records-before.records,stats:pipeline.getDebugSnapshot().regions,submitted:context.submitted};return f.latest;
   },
   async pixels(){const bytesPerRow=Math.ceil(width*4/256)*256,read=device.createBuffer({label:'clip-readback',size:bytesPerRow*height,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ}),encoder=device.createCommandEncoder();encoder.copyTextureToBuffer({texture:output.colorTexture},{buffer:read,bytesPerRow},[width,height]);device.queue.submit([encoder.finish()]);const start=performance.now();await read.mapAsync(GPUMapMode.READ);const raw=new Uint8Array(read.getMappedRange()),pixels=new Uint8Array(width*height*4);for(let y=0;y<height;y++)pixels.set(raw.subarray(y*bytesPerRow,y*bytesPerRow+width*4),y*width*4);const queueAndReadbackWaitMs=performance.now()-start;read.unmap();read.destroy();return{pixels,queueAndReadbackWaitMs}},
   async debug(){const rows=[];for(const t of pipeline._regions?.targets.targets.values()??[]){const texture=t.rtt.colorTexture,bytesPerRow=Math.ceil(t.width*8/256)*256,read=device.createBuffer({size:bytesPerRow*t.height,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ}),encoder=device.createCommandEncoder();encoder.copyTextureToBuffer({texture},{buffer:read,bytesPerRow},[t.width,t.height]);device.queue.submit([encoder.finish()]);await read.mapAsync(GPUMapMode.READ);const raw=new Uint16Array(read.getMappedRange());rows.push({label:texture.label,width:t.width,height:t.height,lastRows:[Math.max(0,t.height-3),Math.max(0,t.height-2),t.height-1].map(y=>({y,pixel:Array.from(raw.slice(y*bytesPerRow/2+Math.min(t.width-1,25)*4,y*bytesPerRow/2+Math.min(t.width-1,25)*4+4))}))});read.unmap();read.destroy()}return rows},
   poison(){const encoder=device.createCommandEncoder(),pass=encoder.beginRenderPass({colorAttachments:[{view:output.getOutputView(),loadOp:'clear',storeOp:'store',clearValue:{r:1,g:0,b:1,a:1}}]});pass.end();device.queue.submit([encoder.finish()])},
   async destroy(){pipeline.clear();world.destroy();view.destroy();directView?.destroy();copy?.destroy();output.destroy();linear?.destroy();await device.queue.onSubmittedWorkDone();await Promise.resolve();live.delete(f)}
  };live.add(f);return f;
 }
 const compare=async(id,a,b,meta)=>{const aa=await a.pixels(),bb=await b.pixels();let max=0,mismatch=0;const first=[];for(let i=0;i<aa.pixels.length;i++){const d=Math.abs(aa.pixels[i]-bb.pixels[i]);max=Math.max(max,d);if(d>2){mismatch++;if(first.length<8)first.push({byte:i,cached:aa.pixels[i],direct:bb.pixels[i]})}}if(mismatch)throw Error(id+': '+JSON.stringify({max,mismatch,first,debug:await a.debug()}));check(aa.pixels.some(v=>v>0),id+': blank output');cases.push({id,...meta,channelsCompared:aa.pixels.length,maxChannelDifference:max,cachedSha256:await digest(aa.pixels),directSha256:await digest(bb.pixels),cached:a.latest,direct:b.latest,queueAndReadbackWaitMs:aa.queueAndReadbackWaitMs+bb.queueAndReadbackWaitMs})};
 for(const forceDirect of surfaceMode?[false,true]:[false])for(const samples of [1,4])for(const dpr of surfaceMode?[1,1.25,2]:[1,2])for(const bounds of rects){
  const name=`${bounds.id}-dpr${dpr}-msaa${samples}-${forceDirect?'direct':'cache'}`,meta={samples,dpr,bounds,...(surfaceMode?{mode:forceDirect?'forced-direct':'retained',logical:[129,81],backing:[Math.floor(129*dpr),Math.floor(81*dpr)]}:{})};progress.textContent=name;
  const cached=fixture(samples,dpr,bounds,true,forceDirect);let direct=fixture(samples,dpr,bounds,false);
  cached.render();direct.render();await compare('initial-'+name,cached,direct,meta);
  cached.poison();direct.poison();const staticFrame=cached.render();direct.render();check(staticFrame.producerRecords===(forceDirect?1:0)&&staticFrame.stats.cropCopies===0,'Static cached GUI redrew or direct reconstruction did not run');await compare('poisoned-presentation-'+name,cached,direct,meta);
  const moved={...bounds,x:11.25,y:13.5};cached.region.setBounds(moved);await direct.destroy();direct=fixture(samples,dpr,moved,false);cached.render();direct.render();await compare('move-old-position-cleared-'+name,cached,direct,{...meta,bounds:moved});
  const rect=canvas.getBoundingClientRect();for(const type of ['pointerdown','pointerup'])canvas.dispatchEvent(new PointerEvent(type,{clientX:rect.left+(moved.x+30)*rect.width/cached.logicalWidth,clientY:rect.top+(moved.y+12)*rect.height/cached.logicalHeight,pointerId:4,buttons:type==='pointerdown'?1:0,button:0}));cached.render();direct.render();check(cached.clicks===1&&direct.clicks===1,'Fractional logical pointer inversion failed');await compare('fractional-input-first-frame-'+name,cached,direct,{...meta,bounds:moved});
  cached.continuous.setMode('demand');cached.render();const idle=cached.render();check(!idle.submitted&&idle.encoders===0&&idle.submits===0&&idle.acquired===0,'Clipped all-idle still touches presentation');cases.at(-1).idle=idle;
  await cached.destroy();await direct.destroy();
 }
 if(surfaceMode){
  for(const samples of [1,4])for(const forceDirect of [false,true])for(const clearColor of [{r:.12,g:.23,b:.37,a:1},{r:.18,g:.08,b:.04,a:.5},{r:.12,g:.04,b:.08,a:0}]){
   const bounds={x:20.25,y:18.5,width:61,height:43},a=fixture(samples,1,bounds,true,forceDirect,clearColor),b=fixture(samples,1,bounds,false,false,clearColor);a.render();b.render();await compare(`colored-clear-${samples}-${forceDirect}-${clearColor.a}`,a,b,{samples,mode:forceDirect?'forced-direct':'retained',clearColor});const p=(await a.pixels()).pixels.slice(0,4),expected=[clearColor.r,clearColor.g,clearColor.b,clearColor.a].map(v=>Math.round(v*255));check(Array.from(p).every((v,i)=>Math.abs(v-expected[i])<=2),'Clear colors changed by regional display transfer');cases.at(-1).clearPixel={actual:Array.from(p),expected};await a.destroy();await b.destroy();
  }
  for(const samples of [1,4]){
   const bounds={x:11.25,y:13.5,width:75.5,height:53.25},a=fixture(samples,1.25,bounds,true),b=fixture(samples,1.25,bounds,false);a.region.setMode('once');a.continuous.setMode('demand');let restore=a.suspend('width'),zero=a.render();check(zero.encoders===0&&zero.submits===0&&zero.acquired===0&&zero.producerRecords===0,'Zero output touched GPU');restore();a.render();b.render();await compare('zero-initial-once-restored-'+samples,a,b,{samples,zero});check(a.latest.producerRecords===1,'Zero output consumed once');a.poison();restore=a.suspend('displayHeight');zero=a.render();check(zero.encoders===0&&zero.submits===0&&zero.acquired===0,'Zero logical output touched GPU');restore();a.render();b.render();await compare('zero-cached-output-restored-'+samples,a,b,{samples,zero});check(a.latest.producerRecords===0&&a.latest.stats.presentations===1,'Restoring blank output did not recompose cache');await a.destroy();await b.destroy();
  }
 }
 const validation=await device.popErrorScope();check(!validation,'Validation: '+validation?.message);check(!errors.length,'Uncaptured: '+errors.join('; '));const residue=tracker.getDebugSnapshot().byType;check((residue.buffer?.current??0)===0&&(residue.texture?.current??0)===0,'Clipped resources retained');
 summary={status:'passed',caseCount:cases.length,cases,residue,errors,adapter:{vendor:adapter.info.vendor,architecture:adapter.info.architecture,device:adapter.info.device,description:adapter.info.description,isFallbackAdapter:adapter.info.isFallbackAdapter},gpuDuration:{status:'not-measured'},qualification:surfaceMode?'Cached and uncached GUI clipping/fractional projection, independently rounded DPR axes, opaque/premultiplied/additive clear values, zero-size once preservation and cached output restoration; no tolerance relaxation. Actual3D clipped projection, multiview and remaining G04 lifecycle still pending.':'Clipped and fractional GUI projection against ordinary full-output GUI, DPR 1/2, MSAA 1/4, initialized/poisoned output, movement, input, static crop skip and idle. Cache refusal/direct fallback and full G04 remain pending.'};
}catch(error){summary={status:'failed',error:String(error.stack??error),cases,errors}}
finally{for(const f of live)await f.destroy();device?.destroy()}
result.textContent=JSON.stringify(summary);result.dataset.status=summary.status;
