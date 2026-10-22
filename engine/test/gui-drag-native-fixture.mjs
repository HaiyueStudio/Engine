import {GuiRoot,GuiElement,GuiButton,GuiLabel,GuiImage,GuiScrollView,GuiModal,GuiSystem} from '/engine/dist/gui.js';
import {RenderPipeline,RenderView,Entity,World,GPUResourceTracker,createGPUResourceOwner,FrameDiagnostics} from '/engine/dist/experimental.js';
const canvas=document.querySelector('canvas'),result=document.querySelector('#result'),check=(value,message)=>{if(!value)throw Error(message);};
const width=640,height=360,dpr=Number(new URLSearchParams(location.search).get('dpr')??1),cases=[],errors=[],live=[];
let device,tracker,scope=false,borrowed,borrowedDestroyed=0;
const listenerAudits=[['canvas',canvas],['window',window],['document',document],['fonts',document.fonts]].map(([name,target])=>{
 const add=target.addEventListener,remove=target.removeEventListener,active=new Map();
 target.addEventListener=function(type,listener,...rest){let entries=active.get(type);if(!entries){entries=new Set();active.set(type,entries);}entries.add(listener);return add.call(this,type,listener,...rest);};
 target.removeEventListener=function(type,listener,...rest){active.get(type)?.delete(listener);return remove.call(this,type,listener,...rest);};
 return{name,active,restore(){target.addEventListener=add;target.removeEventListener=remove;}};
});
try {
 for(let i=0;devicePixelRatio!==dpr&&i<120;i++)await new Promise(requestAnimationFrame);
 check(devicePixelRatio===dpr,'Requested browser DPR did not take effect');
 await document.fonts.ready;
 const adapter=await navigator.gpu.requestAdapter({powerPreference:'high-performance'});check(adapter&&!adapter.info.isFallbackAdapter,'Native WebGPU required');
 device=await adapter.requestDevice();device.pushErrorScope('validation');scope=true;device.addEventListener('uncapturederror',e=>errors.push(e.error.message));
 const diagnostics=new FrameDiagnostics({enabled:true});tracker=new GPUResourceTracker({debug:true,frameDiagnostics:diagnostics});tracker.instrumentDevice(device,createGPUResourceOwner('system','G09 drag native'));
 canvas.width=width*dpr;canvas.height=height*dpr;canvas.style.width=width*1.2+'px';canvas.style.height=height*1.2+'px';
 borrowed=device.createTexture({label:'Caller-owned blue preview icon',size:[4,4],format:'rgba8unorm',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST|GPUTextureUsage.COPY_SRC});
 const blue=new Uint8Array(4*4*4);for(let i=0;i<blue.length;i+=4){blue[i+2]=255;blue[i+3]=255;}device.queue.writeTexture({texture:borrowed},blue,{bytesPerRow:16},[4,4]);
 const previewFactory=()=>{const preview=new GuiElement({width:96,height:40,pointerFilter:'stop',style:{backgroundColor:'#ffff00',radius:0}});preview.add(new GuiLabel({x:8,y:8,width:70,height:24,text:'PREVIEW',style:{color:'#000000'}}));preview.add(new GuiImage({x:80,y:4,width:12,height:12,source:borrowed}));return preview;};
 function create(cache) {
  const host={device,...(cache?{canvas}:{}),width:width*dpr,height:height*dpr,displayWidth:width,displayHeight:height,format:'rgba8unorm',reverseZ:false,msaaSamples:1,getDepthFormat:()=> 'depth24plus'};
  const color=device.createTexture({size:[host.width,host.height],format:host.format,usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.COPY_SRC}),depth=device.createTexture({size:[host.width,host.height],format:'depth24plus',usage:GPUTextureUsage.RENDER_ATTACHMENT});
  const descriptor=()=>({colorAttachments:[{view:color.createView(),loadOp:'clear',storeOp:'store',clearValue:{r:0,g:0,b:0,a:1}}],depthStencilAttachment:{view:depth.createView(),depthLoadOp:'clear',depthStoreOp:'store',depthClearValue:1}});host.getRenderPassDescriptor=descriptor;
  const target={key:'g09-'+cache,width:host.width,height:host.height,displayWidth:width,displayHeight:height,format:host.format,getOutputView:()=>color.createView(),getRenderPassDescriptor:descriptor};
  const view=new RenderView({camera:new Entity(),target,sampleCount:1}),world=new World(),pipeline=new RenderPipeline(host),roots=[new GuiRoot({style:{backgroundColor:'#142238',radius:0}}),new GuiRoot({style:{backgroundColor:'#143b2c',radius:0}}),new GuiRoot()];
  roots.forEach(root=>world.addEntity(new Entity().addComponent(root)));
  const bounds=[{x:12.5,y:10.25,width:210,height:300},{x:252.25,y:20.5,width:350,height:300},{x:0,y:0,width,height}];
  const regions=bounds.map((bounds,i)=>view.createRegion({id:'drag-'+i,bounds,visible:true,updateMode:'demand',clearMode:'on-update'}));
  const guis=roots.map(root=>{const gui=new GuiSystem(host,{roots:new Set([root]),font:{chars:'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 .?x-|',atlasSize:512}});world.addSystem(gui);return gui;});
  guis.forEach((gui,i)=>pipeline.add(gui,{region:regions[i]}));
  const counts={get:0,preview:0,dispose:0,drop:0,click:0,cancel:0,ends:[],hover:[]},data={resource:'sample',sameReference:true};let allow=true,hover=false,accepted=false,frame=0;
  const protocol={getData(){counts.get++;return data;},createPreview(){counts.preview++;return previewFactory();},disposePreview(){counts.dispose++;},onEnd:value=>counts.ends.push(value)};
  const source=roots[0].add(new GuiButton({id:'source',x:12,y:12,width:120,height:40,text:'Sample',dragSource:protocol,onClick:()=>counts.click++,onPointerCancel:()=>counts.cancel++}));
  const text=roots[1].add(new GuiLabel({id:'drop-count',x:20,y:5,width:220,height:26,text:'Drops 0'}));
  const dropProtocol={canDrop:value=>allow&&value===data,drop(value,position){check(value===data,'Payload identity changed');counts.drop++;counts.position={...position};text.setText('Drops '+counts.drop);},onHoverChange(active,value){hover=active;accepted=value;counts.hover.push([active,value]);zone.setStyle({backgroundColor:active?(value?'#00ff00':'#ff0000'):'#006600'});}};
  const zone=roots[1].add(new GuiElement({id:'zone',x:20,y:40,width:180,height:90,dropTarget:dropProtocol,style:{backgroundColor:'#006600',radius:0}}));zone.add(new GuiLabel({x:8,y:8,width:160,height:40,text:'Drop zone'}));
  const scroll=roots[1].add(new GuiScrollView({id:'scroll',x:20,y:150,width:180,height:90,contentHeight:380,showScrollbar:false}));
  const scrollZone=scroll.add(new GuiElement({id:'scroll-zone',y:240,width:150,height:60,dropTarget:dropProtocol,style:{backgroundColor:'#660066',radius:0}}));scrollZone.add(new GuiLabel({text:'Scrolled target',x:5,width:140,height:30}));
  const modal=roots[2].add(new GuiModal({id:'modal',title:'Modal',message:'Preview stays above this layer',width:500,height:280}));
  const modalSource=modal.confirmButton,modalZone=modal.cancelButton;modalSource.setDragSource(protocol);modalZone.setDropTarget(dropProtocol);
  function render(){diagnostics.beginFrame(++frame);const start=performance.now(),context=pipeline.execute(world,frame*16,16,{view,regionCache:cache});return{submitted:context.submitted,regions:pipeline.getDebugSnapshot().regions,metrics:diagnostics.snapshot().counters,cpuMs:performance.now()-start};}
  async function pixels(texture=color){const stride=Math.ceil(texture.width*4/256)*256,read=device.createBuffer({size:stride*texture.height,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ}),encoder=device.createCommandEncoder();encoder.copyTextureToBuffer({texture},{buffer:read,bytesPerRow:stride},[texture.width,texture.height]);device.queue.submit([encoder.finish()]);const start=performance.now();await read.mapAsync(GPUMapMode.READ);const waitMs=performance.now()-start,bytes=new Uint8Array(read.getMappedRange()),packed=new Uint8Array(texture.width*texture.height*4);for(let y=0;y<texture.height;y++)packed.set(bytes.subarray(y*stride,y*stride+texture.width*4),y*texture.width*4);read.unmap();read.destroy();return{bytes:packed,waitMs};}
  const state=()=>({counts:structuredClone(counts),allow,hover,accepted,session:guis[0].dragSession?{sourceId:guis[0].dragSession.sourceId,targetId:guis[0].dragSession.targetId,pointerId:guis[0].dragSession.pointerId??null}:null,preview:!!guis[2].dragPreview.root,pressed:source.pressed,modal:modal.visible,scrollY:scroll.scrollY,focus:guis[0].focus.focused?.id??null,sourceVisible:source.visible,targetVisible:zone.visible});
  const visibility=[true,true,true];
  const f={host,root:roots,guis,regions,visibility,source,zone,modal,modalSource,modalZone,scroll,scrollZone,text,counts,data,protocol,dropProtocol,render,pixels,state,
   regionVisible(index,value){visibility[index]=value;regions[index].setVisible(value);},
   setAllow(value){allow=value;zone.markDirty();},setHover(active,value){hover=active;accepted=value;zone.setStyle({backgroundColor:active?(value?'#00ff00':'#ff0000'):'#006600'});},
   async destroy(){pipeline.clear();world.destroy();view.destroy();color.destroy();depth.destroy();await device.queue.onSubmittedWorkDone();}};
  live.push(f);return f;
 }
 const cached=create(true),reference=create(false),scene=[],off=cached.guis[0].onUnhandledInput(event=>{if(event.type==='pointerdown'||event.type==='keydown')scene.push(event.type);});
 function mirror(){
  const s=cached.state();reference.setAllow(s.allow);reference.setHover(s.hover,s.accepted);reference.counts.drop=s.counts.drop;reference.text.setText(cached.text.text);reference.source.setVisible(s.sourceVisible);reference.zone.setVisible(s.targetVisible);reference.scroll.scrollTo(s.scrollY);s.modal?reference.modal.show():reference.modal.hide();
  cached.visibility.forEach((visible,i)=>reference.regionVisible(i,visible));
  const paired=new Map();const visit=(node,other)=>{paired.set(node,other);other.hovered=node.hovered;other.pressed=node.pressed;node.children.forEach((child,index)=>visit(child,other.children[index]));};cached.root.forEach((root,index)=>visit(root.root,reference.root[index].root));
  const focus=paired.get(cached.guis[0].focus.focused);reference.guis[0].focus.reconcile();reference.guis[0].focus.focus(focus??null);
  const active=cached.guis[2].dragPreview.root,display=reference.guis[2].dragPreview;
  if(active){const drag=cached.guis[0].inputDomain.drag.current;if(!display.root)display.show(previewFactory(),reference.root[drag.element===cached.modalSource?2:0],drag.point);else display.move(drag.point);}else display.hide();
  for(const root of reference.root)root.root.markDirty(31);display.root?.root.markDirty(31);
 }
 const at=(bytes,x,y)=>{const i=(Math.floor(y*dpr)*width*dpr+Math.floor(x*dpr))*4;return[...bytes.slice(i,i+4)];};
 cached.render();reference.render();cached.render();await new Promise(requestAnimationFrame);cached.render();
 window.probe={
  state:()=>cached.state(),
  hostPoint(x,y){const box=canvas.getBoundingClientRect();return{x:box.x+x*box.width/width,y:box.y+y*box.height/height};},
  point(id){for(const [index,root]of cached.root.entries()){const element=id==='modal-source'?(index===2?cached.modalSource:null):id==='modal-zone'?(index===2?cached.modalZone:null):root.findById(id);if(!element)continue;const r=cached.guis[index].inputParticipant.rect(element),box=canvas.getBoundingClientRect();return{x:box.x+(r.x+r.width/2)*box.width/width,y:box.y+(r.y+r.height/2)*box.height/height};}throw Error('Missing point '+id);},
  async check(id){const actual=cached.render();mirror();reference.render();const a=await cached.pixels(),b=await reference.pixels();let different=0,max=0;for(let i=0;i<a.bytes.length;i++){const delta=Math.abs(a.bytes[i]-b.bytes[i]);max=Math.max(max,delta);if(delta>2)different++;}if(different){const points=[];for(let i=0;i<a.bytes.length&&points.length<5;i+=4)if(a.bytes.subarray(i,i+4).some((v,k)=>Math.abs(v-b.bytes[i+k])>2))points.push({x:(i/4)%(width*dpr),y:Math.floor(i/4/(width*dpr)),a:[...a.bytes.slice(i,i+4)],b:[...b.bytes.slice(i,i+4)]});throw Error(id+': retained/direct pixels differ '+different+' '+JSON.stringify({points,focusA:cached.guis[0].focus.focused?.id,focusB:reference.guis[0].focus.focused?.id,sourceA:{focused:cached.source.focused,hovered:cached.source.hovered},sourceB:{focused:reference.source.focused,hovered:reference.source.hovered}}));}
   const drag=cached.guis[0].inputDomain.drag.current;if(drag?.preview&&drag.point.x+14<width&&drag.point.y+14<height){const sample=at(a.bytes,drag.point.x+14,drag.point.y+14);check(sample[0]>=253&&sample[1]>=253&&sample[2]<=2,'Global preview did not paint above all regions/modals: '+sample);}
   const report={id,actual,state:cached.state(),differentChannels:different,maxChannelDifference:max,comparedChannels:a.bytes.length,queueAndReadbackWaitMs:a.waitMs};cases.push(report);return report;},
  rule:value=>cached.setAllow(value),showModal:()=>cached.modal.show(),hideModal:()=>cached.modal.hide(),
  sourceVisible:value=>cached.source.setVisible(value),targetVisible:value=>cached.zone.setVisible(value),
  targetAttached(value){for(const f of [cached,reference]){if(value){f.root[1].add(f.zone);f.root[1].add(f.scroll);}else f.root[1].remove(f.zone);}},
  sourceRegionVisible(value){cached.regionVisible(0,value);reference.regionVisible(0,value);},
  targetRegionVisible(value){cached.regionVisible(1,value);reference.regionVisible(1,value);},
  scroll:value=>cached.scroll.scrollTo(value),
  pause:()=>cached.guis.forEach(gui=>gui.stopAnimations()),
  async resources(){await device.queue.onSubmittedWorkDone();for(let i=0;i<12;i++)await Promise.resolve();const snapshot=tracker.getDebugSnapshot(),byType=snapshot.byType,textureGroups={};for(const resource of snapshot.resources)if(resource.type==='texture'){const key=resource.label+':'+resource.estimatedBytes;textureGroups[key]=(textureGroups[key]??0)+1;}return{buffers:byType.buffer?.current??0,textures:byType.texture?.current??0,textureGroups,fontTextures:live.flatMap(f=>f.guis.map(gui=>gui.renderer.textRenderer.fontCache.size)),captures:cached.guis.reduce((n,gui)=>n+gui.capturedPointers.size,0),rootCaches:cached.guis.reduce((n,gui)=>n+gui.renderer.rootCaches.size,0),pointerOwners:cached.guis[0].inputDomain.pointers.size};},
  async pendingPreview(){
   const gui=cached.guis[2],host=cached.host;check(gui.dragPreview.root,'Preview must be active for the pending-frame test');
   const record=()=>{const texture=device.createTexture({size:[width*dpr,height*dpr],format:'rgba8unorm',usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.COPY_SRC}),depth=device.createTexture({size:[width*dpr,height*dpr],format:'depth24plus',usage:GPUTextureUsage.RENDER_ATTACHMENT}),encoder=device.createCommandEncoder(),submitted=[],cancelled=[];
    const pass=encoder.beginRenderPass({colorAttachments:[{view:texture.createView(),loadOp:'clear',storeOp:'store',clearValue:[0,0,0,1]}],depthStencilAttachment:{view:depth.createView(),depthLoadOp:'clear',depthStoreOp:'store',depthClearValue:1}});gui.renderer.render(pass,gui.renderRoots(),host,false,1,null,{afterSubmit:fn=>submitted.push(fn),afterCancel:fn=>cancelled.push(fn)});pass.end();const command=encoder.finish();return{texture,submit(){device.queue.submit([command]);submitted.forEach(fn=>fn(device.queue));},cancel(){cancelled.forEach(fn=>fn());texture.destroy();depth.destroy();},destroy(){texture.destroy();depth.destroy();}};};
   const expected=record();expected.submit();const before=(await cached.pixels(expected.texture)).bytes;expected.destroy();const held=record();cached.guis[0].dragSession.cancel();cached.render();held.submit();const after=(await cached.pixels(held.texture)).bytes;held.destroy();let max=0;for(let i=0;i<before.length;i++)max=Math.max(max,Math.abs(before[i]-after[i]));check(max===0,'A pending preview recording changed after transient root destruction');cases.push({id:'pending-preview-recording-after-session-end',comparedChannels:before.length,maxChannelDifference:max});return{maxChannelDifference:max};
  },
  async finish(){off();for(const f of live)await f.destroy();live.length=0;const surviving=(await cached.pixels(borrowed)).bytes;check(surviving.every((value,index)=>value===(index%4>=2?255:0)),'Caller-owned preview texture did not survive Engine teardown');borrowed.destroy();borrowedDestroyed++;borrowed=null;await device.queue.onSubmittedWorkDone();for(let i=0;i<12;i++)await Promise.resolve();const error=await device.popErrorScope();scope=false;if(error)errors.push(error.message);check(!errors.length,errors.join(';'));const residue=tracker.getDebugSnapshot().byType;check((residue.buffer?.current??0)===0&&(residue.texture?.current??0)===0,'GPU residue '+JSON.stringify(residue));check(!scene.length,'Input leaked to scene '+scene);const listenerResidue=listenerAudits.map(({name,active})=>({name,listeners:[...active.values()].reduce((n,set)=>n+set.size,0)}));check(listenerResidue.every(item=>item.listeners===0),'Native listener residue '+JSON.stringify(listenerResidue));listenerAudits.forEach(a=>a.restore());return{status:'passed',dpr,caseCount:cases.length,cases,residue,sceneEvents:scene,errors,listenerResidue,borrowedDestroyedByCaller:borrowedDestroyed,adapter:{vendor:adapter.info.vendor,architecture:adapter.info.architecture,isFallbackAdapter:adapter.info.isFallbackAdapter},gpuDuration:{status:'not-measured'},qualification:'Native WebGPU correctness: three fractional regions, CSS scale 1.2, DPR, global preview, trusted input, independent direct renderer, pending recordings and resource teardown. Formal performance, physical touch and Native qualification remain G13.'};}
 };
 canvas.dataset.ready='true';
}catch(error){result.dataset.status='failed';result.textContent=JSON.stringify({status:'failed',error:String(error.stack??error),cases,errors});}
