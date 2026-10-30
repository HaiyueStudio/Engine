import {GuiRoot,GuiElement,GuiLabel,GuiButton,GuiSystem} from '/engine/dist/gui.js';
import {RenderPipeline,RenderView,Entity,World,GPUResourceTracker,createGPUResourceOwner,FrameDiagnostics} from '/engine/dist/experimental.js';
import {attachGuiLayout,createGuiContainer,GuiSplitPanel,GuiTabContainer} from '/g08-layout-build/gui-layout.js';
import {readGuiLayoutCounters} from '/g08-layout-build/gui-layout/diagnostics.js';

const canvas=document.querySelector('canvas'),result=document.querySelector('#result'),check=(v,m)=>{if(!v)throw Error(m);};
const dpr=Number(new URLSearchParams(location.search).get('dpr')??1),cases=[],errors=[],live=[];
let device,tracker,scope=false,width=640,height=400,diagnostics;
try {
 const adapter=await navigator.gpu.requestAdapter({powerPreference:'high-performance'});check(adapter&&!adapter.info.isFallbackAdapter,'Native WebGPU required');
 device=await adapter.requestDevice();device.pushErrorScope('validation');scope=true;device.addEventListener('uncapturederror',e=>errors.push(e.error.message));
 diagnostics=new FrameDiagnostics({enabled:true});tracker=new GPUResourceTracker({debug:true,frameDiagnostics:diagnostics});tracker.instrumentDevice(device,createGPUResourceOwner('system','G08 panels'));
 canvas.width=width*dpr;canvas.height=height*dpr;canvas.style.width=width+'px';canvas.style.height=height+'px';
 function create(cache) {
  const world=new World(),root=new GuiRoot(),host={device,...(cache?{canvas}:{}),width:width*dpr,height:height*dpr,displayWidth:width,displayHeight:height,format:'rgba8unorm',reverseZ:false,msaaSamples:1,getDepthFormat:()=> 'depth24plus'};
  let binding=attachGuiLayout(root),frame=0,clicks=0,cancels=0,color,depth,view,region;
  const gui=new GuiSystem(host,{roots:new Set([root]),font:{chars:'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 .|x-',atlasSize:512}});
  const a=createGuiContainer('column',{id:'page-a',style:{padding:{left:12,top:12},rowGap:8}}),b=createGuiContainer('column',{id:'page-b',style:{padding:{left:12,top:12},rowGap:8}}),c=createGuiContainer('column',{id:'page-c'});
  a.setStyle({backgroundColor:'#172b4d',radius:0});b.setStyle({backgroundColor:'#1f5131',radius:0});c.setStyle({backgroundColor:'#493264',radius:0});
  const counter=a.add(new GuiButton({id:'count',text:'Count 0',width:120,height:32,onClick:()=>{counter.setText('Count '+(++clicks));},onPointerCancel:()=>cancels++}));
  const text=a.add(new GuiLabel({id:'a-text',text:'Original content',width:200,height:26}));b.add(new GuiLabel({text:'Second page',width:160,height:26}));c.add(new GuiLabel({text:'Third page',width:160,height:26}));
  const tabs=new GuiTabContainer({id:'tabs',focus:gui.focus,tabWidth:104,tabHeight:34,pages:[{id:'a',title:'First',content:a},{id:'b',title:'Second',content:b,closable:true},{id:'c',title:'Third',content:c}],activeId:'a'});
  const footer=new GuiElement({id:'footer',style:{backgroundColor:'#233044',radius:0}});footer.add(new GuiLabel({text:'Log',x:10,y:5,width:100,height:24}));
  const nested=new GuiSplitPanel({id:'vertical',axis:'vertical',ratio:.7,minimumFirst:80,minimumSecond:40,first:tabs.element,second:footer});
  const left=new GuiElement({id:'sidebar',style:{backgroundColor:'#38404c',radius:0}});left.add(new GuiLabel({text:'Sidebar',x:10,y:10,width:100,height:24}));
  const split=new GuiSplitPanel({id:'horizontal',axis:'horizontal',ratio:.25,minimumFirst:100,minimumSecond:160,first:left,second:nested.element});root.add(split.element);
  const themeListeners=new Set(),resource={version:1,resolve:()=>({}),subscribe(f){themeListeners.add(f);return()=>themeListeners.delete(f);}};root.setThemeResource(resource);
  world.addEntity(new Entity().addComponent(root));world.addSystem(gui);
  const pipeline=new RenderPipeline(host);
  function resize(w,h) {
   width=w;height=h;pipeline.clear();view?.destroy();color?.destroy();depth?.destroy();
   host.width=Math.round(w*dpr);host.height=Math.round(h*dpr);host.displayWidth=w;host.displayHeight=h;
   if(cache){canvas.width=host.width;canvas.height=host.height;canvas.style.width=w+'px';canvas.style.height=h+'px';}
   color=device.createTexture({size:[host.width,host.height],format:host.format,usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.COPY_SRC});
   depth=device.createTexture({size:[host.width,host.height],format:'depth24plus',usage:GPUTextureUsage.RENDER_ATTACHMENT});
   const descriptor=()=>({colorAttachments:[{view:color.createView(),loadOp:'clear',storeOp:'store',clearValue:{r:0,g:0,b:0,a:1}}],depthStencilAttachment:{view:depth.createView(),depthLoadOp:'clear',depthStoreOp:'store',depthClearValue:1}});
   const target={key:'G08-'+cache,width:host.width,height:host.height,displayWidth:w,displayHeight:h,format:host.format,getOutputView:()=>color.createView(),getRenderPassDescriptor:descriptor};host.getRenderPassDescriptor=descriptor;
   view=new RenderView({camera:new Entity(),target,sampleCount:1});region=view.createRegion({id:'panels',bounds:{x:0,y:0,width:w,height:h},updateMode:'demand',clearMode:'on-update',visible:true});pipeline.add(gui,{region});
   binding.setStyle(split.element,{width:w,height:h});
  }
  resize(width,height);
  const f={root,gui,world,split,nested,tabs,a,b,c,text,counter,resource,themeListeners,get binding(){return binding;},get clicks(){return clicks;},setClicks(value){clicks=value;counter.setText('Count '+value);},resize,
   state:()=>({ratio:split.ratio,verticalRatio:nested.ratio,activeId:tabs.activeId,pages:tabs.pages.map(p=>p.id),text:text.text,clicks,cancels,counterPressed:counter.pressed,focus:gui.focus.focused?.id??null,pressed:split.divider.pressed}),
   render(){diagnostics.beginFrame(++frame);const execution=pipeline.execute(world,frame*16,16,{view,regionCache:cache});return {submitted:execution.submitted,regions:pipeline.getDebugSnapshot().regions,metrics:diagnostics.snapshot().counters,counters:readGuiLayoutCounters(binding)};},
   async pixels(){const stride=Math.ceil(host.width*4/256)*256,read=device.createBuffer({size:stride*host.height,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ}),encoder=device.createCommandEncoder();encoder.copyTextureToBuffer({texture:color},{buffer:read,bytesPerRow:stride},[host.width,host.height]);device.queue.submit([encoder.finish()]);await read.mapAsync(GPUMapMode.READ);const bytes=new Uint8Array(read.getMappedRange()),packed=new Uint8Array(host.width*host.height*4);for(let y=0;y<host.height;y++)packed.set(bytes.subarray(y*stride,y*stride+host.width*4),y*host.width*4);read.unmap();read.destroy();return packed;},
   fresh(){binding.dispose();binding=attachGuiLayout(root);binding.setStyle(split.element,{width,height});root.root.markDirty(31);},
   async destroy(){pipeline.clear();world.destroy();view.destroy();split.dispose();nested.dispose();tabs.dispose();binding.dispose();color.destroy();depth.destroy();check(themeListeners.size===0,'Theme listener residue');await device.queue.onSubmittedWorkDone();}};
  live.push(f);return f;
 }
 const cached=create(true),reference=create(false),scene=[];
 const off=cached.gui.onUnhandledInput(event=>{if(event.type==='pointerdown'||event.type==='keydown')scene.push(event.type);});
 function mirror() {
  for(const id of reference.tabs.pages.map(p=>p.id))if(!cached.tabs.pages.some(p=>p.id===id))reference.tabs.remove(id);
  reference.tabs.restore(cached.tabs.serialize());reference.split.restore(cached.split.serialize());reference.nested.restore(cached.nested.serialize());reference.text.setText(cached.text.text);reference.setClicks(cached.clicks);
  reference.resource.resolve=cached.resource.resolve;reference.resource.version=cached.resource.version;for(const fn of reference.themeListeners)fn();
  const visit=node=>{const other=reference.root.findById(node.id);if(other){other.hovered=node.hovered;other.pressed=node.pressed;other.markDirty(2);}for(const child of node.children)visit(child);};visit(cached.root.root);
  reference.gui.focus.focus(cached.gui.focus.focused?reference.root.findById(cached.gui.focus.focused.id):null);reference.fresh();
 }
 cached.render();reference.render();cached.render();
 window.probe={
  state:()=>cached.state(),
  point(id){const element=cached.root.findById(id);check(element,'Missing GUI target '+id);const r=element.rect,b=canvas.getBoundingClientRect();return{x:b.x+(r.x+r.width/2)*b.width/width,y:b.y+(r.y+r.height/2)*b.height/height};},
  async check(id){const actual=cached.render();mirror();reference.render();const a=await cached.pixels(),b=await reference.pixels();let max=0,different=0;for(let i=0;i<a.length;i++){const delta=Math.abs(a[i]-b[i]);max=Math.max(max,delta);if(delta>2)different++;}check(!different,id+': retained/fresh pixels differ '+different);const data={id,actual,state:cached.state(),differentChannels:different,maxChannelDifference:max,comparedChannels:a.length};cases.push(data);return data;},
  mutateInactive(){cached.text.setText('Changed while hidden');},
  activate(id){cached.tabs.activate(id);},
  hide(id,visible){cached.tabs.setPageVisible(id,visible);},
  move(id,index){cached.tabs.move(id,index);},
  save(){return {split:cached.split.serialize(),tabs:cached.tabs.serialize()};},
  restore(data){cached.split.restore(data.split);cached.tabs.restore(data.tabs);},
  theme(){cached.resource.resolve=type=>type==='GuiSplitDivider'?{backgroundColor:'#d19b12',fontSize:18}:{};cached.resource.version++;for(const fn of cached.themeListeners)fn();},
  resize(w,h){cached.resize(w,h);reference.resize(w,h);},
  async finish(){off();check(!scene.length,'GUI events leaked to scene '+scene);for(const f of live)await f.destroy();live.length=0;await device.queue.onSubmittedWorkDone();for(let n=0;n<10;n++)await Promise.resolve();const error=await device.popErrorScope();scope=false;if(error)errors.push(error.message);check(!errors.length,errors.join(';'));const residue=tracker.getDebugSnapshot().byType;check((residue.buffer?.current??0)===0&&(residue.texture?.current??0)===0,'GPU resource residue '+JSON.stringify(residue));return{status:'passed',caseCount:cases.length,dpr,cases,errors,residue,sceneEvents:scene,adapter:{vendor:adapter.info.vendor,architecture:adapter.info.architecture,isFallbackAdapter:adapter.info.isFallbackAdapter},qualification:'Current source through planned gui-layout entry, native GPU, retained region vs independent fresh binding/direct rendering; trusted browser mouse/touch/keyboard. Physical touch/Native and formal package/performance owned by G13.'};}
 };
 canvas.dataset.ready='true';
} catch(error) {result.dataset.status='failed';result.textContent=JSON.stringify({status:'failed',error:String(error.stack??error),cases,errors});}
