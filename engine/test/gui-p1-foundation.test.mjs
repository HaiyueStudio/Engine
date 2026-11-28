import test from 'node:test';
import assert from 'node:assert/strict';
import {importEngineSource} from './helpers/internal-source.mjs';
import {createAuditGpuDevice,getAuditGpuDeviceState} from '../../scripts/benchmark/real-renderer-audit-device.mjs';
const load=p=>importEngineSource('gui/'+p+'.ts');
const {GuiRoot}=await load('components/GuiRoot'),{GuiElement}=await load('components/GuiElement'),{GuiThemeResource}=await load('GuiThemeResource');
const {GuiSlider}=await load('components/GuiSlider'),{GuiProgress}=await load('components/GuiProgress'),{GuiImage}=await load('components/GuiImage'),{GuiSelect}=await load('components/GuiSelect'),{GuiTooltip}=await load('components/GuiTooltip');
const {advanceGuiActivity,guiHasActivity}=await load('GuiActivity'),{guiVisualDamage}=await load('GuiVisualBounds');
const {serializeGuiRoot,deserializeGuiRoot}=await load('GuiSerialization');
const action=(node,name,source='keyboard')=>{const event={action:name,source,consumed:false,consume(){this.consumed=true;}};node.handleAction(event);return event;};
const pointer=(node,x,y)=>({type:'pointerdown',target:node,currentTarget:node,x,y,localX:x-node.rect.x,localY:y-node.rect.y,button:0,buttons:1,pointerId:1,nativeEvent:{preventDefault(){}},stopped:false,defaultPrevented:false,stopPropagation(){this.stopped=true;},preventDefault(){this.defaultPrevented=true;}});

test('extension default skins stay below resources, parts and explicit styles across hot theme updates',()=>{
  const root=new GuiRoot(),owner=root.add(new GuiElement({width:200,height:100})),node=owner.add(new GuiElement({width:80,height:32,themeControlType:'Custom'}));
  const old=node.setDefaultSkin(theme=>({backgroundColor:theme.colors.surface,color:'#111111'}));node.setDefaultSkin(theme=>({backgroundColor:theme.colors.primary,color:'#222222'}));old();
  root.setThemeResource(new GuiThemeResource({controls:{Custom:{normal:{backgroundColor:'#333333'}}}}));owner.bindPart('content',node);owner.setStyle({parts:{content:{color:'#444444'}}});node.setStyle({color:'#555555'});root.layout(400,200);
  assert.equal(node.getResolvedStyle().backgroundColor,'#333333');assert.equal(node.getResolvedStyle().color,'#555555');root.theme=GuiThemeResource.createTheme('light');root.layout(400,200);assert.equal(node.getTheme().colors.surface,root.theme.colors.surface);assert(Object.isFrozen(node.getTheme().colors));root.destroy();
});
test('non-motion activities still expire under reduced motion and pause when hidden or clipped',()=>{
  const root=new GuiRoot(),parent=root.add(new GuiElement({width:100,height:100,style:{clipRadius:4}})),timer=parent.add(new GuiElement({width:10,height:10}));root.layout(200,200);root.theme.motionScale=0;let time=0;
  timer.setActivity(delta=>{time+=delta;if(time>=150)return false;},{motion:false});assert(guiHasActivity(timer));advanceGuiActivity(timer,100);assert.equal(time,100);parent.setVisible(false);advanceGuiActivity(timer,100);assert.equal(time,100);parent.setVisible(true);timer.rect.x=150;advanceGuiActivity(timer,100);assert.equal(time,100);timer.rect.x=0;advanceGuiActivity(timer,50);assert.equal(time,150);assert(!guiHasActivity(timer));root.destroy();
});
test('root disposal uses the existing observer table and completes all observers even after one throws',()=>{
  const root=new GuiRoot(),calls=[];root.onDispose(()=>{calls.push(1);throw new Error('application observer');});root.onDispose(()=>calls.push(2));assert.throws(()=>root.destroy(),/cleanup failed/);assert.deepEqual(calls,[1,2]);assert(root.destroyed);root.destroy();root.onDispose(()=>calls.push(3));assert.deepEqual(calls,[1,2,3]);
});

test('natural label width roundtrips without wrapping the transparent atlas padding onto another line',async()=>{
 const {createBitmapFontData}=await importEngineSource('font/BitmapFontData.ts'),{measureGuiTextBlock}=await load('rendering/GuiTextBatch');
 const font=createBitmapFontData({face:'Padded',size:16,bold:false,italic:false,lineHeight:16,base:12,scaleW:32,scaleH:32,pages:[],chars:new Map([[65,{id:65,x:0,y:0,width:12,height:16,xoffset:-2,yoffset:0,xadvance:8,page:0}]]),kernings:new Map()});
 const natural=measureGuiTextBlock('AAA',font,16,Infinity,true);assert.equal(natural.width,24);assert.deepEqual(measureGuiTextBlock('AAA',font,16,natural.width,true),natural);assert.equal(measureGuiTextBlock('AAA',font,16,16,true).height,32);
});

test('stock progress text retains sparse collection while custom presentation getters fall back without speculative reads',async()=>{
 const {GuiPrimitiveTree}=await load('GuiPrimitiveTree'),{GuiGlyphCoverage}=await load('GuiGlyphCoverage'),root=new GuiRoot(),progress=root.add(new GuiProgress({value:75,showText:true}));
 assert(GuiPrimitiveTree.capture(root.root));const coverage=GuiGlyphCoverage.capture(root.root);assert(coverage.glyphs.has('%'));progress.setValue(50);assert(coverage.update());assert(coverage.glyphs.has('0'));let reads=0;Object.defineProperty(progress,'displayText',{get(){reads++;return 'custom';},configurable:true});assert.equal(GuiPrimitiveTree.capture(root.root),null);assert.equal(reads,0);root.destroy();
});
test('one slider owner handles offset steps, range clamping, vertical keys, and two-thumb Tab traversal',()=>{
  const changes=[],commits=[],slider=new GuiSlider({min:5,max:25,step:3,value:5,onChange:v=>changes.push(v),onCommit:v=>commits.push(v)});slider.setValue(9,true);assert.equal(slider.value,8);assert.deepEqual(changes,[8]);slider.setRange([8,23]);slider.setValue(30);assert.equal(slider.value,23);slider.setRange([8,23]);
  assert(action(slider,'next').consumed);assert.equal(slider.activeThumb,1);action(slider,'left','gamepad');assert.deepEqual(slider.range,[8,20]);assert(!action(slider,'next').consumed);action(slider,'previous');assert.equal(slider.activeThumb,0);assert(!action(slider,'previous').consumed);action(slider,'confirm');assert.equal(commits.length,1);
  slider.orientation='vertical';action(slider,'up');assert.equal(slider.value,11);slider.setDisabled(true);action(slider,'up');assert.equal(slider.value,11);assert.throws(()=>slider.setRange([22,10]));assert.throws(()=>slider.setValue(NaN));
});
test('pointer picking chooses the nearest range thumb and commits only a real press',()=>{
  const slider=new GuiSlider({range:[20,80]}),root=new GuiRoot();root.add(slider);root.layout(400,200);let commits=0;slider.onRangeCommit=()=>commits++;
  const point=pointer(slider,slider.rect.x+slider.rect.width-8,slider.rect.y+12);slider.handlePointerDown(point);slider.handlePointerUp({...point,type:'pointerup'});assert.equal(slider.activeThumb,1);assert.deepEqual(slider.range,[20,100]);assert.equal(commits,1);slider.handlePointerUp({...point,type:'pointerup'});assert.equal(commits,1);root.destroy();
});
test('new image/progress/slider presentation fields roundtrip and reject malformed serialized variants',()=>{
  const root=new GuiRoot();root.add(new GuiImage({fit:'cover'}));root.add(new GuiProgress({variant:'circle',status:'success',strokeWidth:5,showText:true}));root.add(new GuiSlider({range:[10,70],orientation:'vertical',marks:[{value:10,label:'低'}],tooltip:'always'}));
  const data=serializeGuiRoot(root),restored=deserializeGuiRoot(data);assert.equal(restored.root.children[0].fit,'cover');assert.equal(restored.root.children[1].variant,'circle');assert.deepEqual(restored.root.children[2].range,[10,70]);assert.equal(restored.root.children[2].marks[0].label,'低');
  for(const [index,key,value]of [[0,'fit','stretch'],[1,'variant','ring-ish'],[1,'strokeWidth',0],[2,'range',[80,20]],[2,'marks',[{value:4,label:'a'},{value:4,label:'b'}]]]){const bad=structuredClone(data);bad.root.children[index].props[key]=value;assert.throws(()=>deserializeGuiRoot(bad));}restored.destroy();root.destroy();
});
test('popup geometry accepts planned anchor positions without mutating live layout, and blur cancels a select',()=>{
  const root=new GuiRoot(),select=root.add(new GuiSelect({width:90,height:32,options:[{label:'A',value:'a'}]}));root.layout(240,160);const before={...select.rect},rect=select.getPopupRect({width:120,height:60},{viewport:root.viewport,anchor:{x:200,y:140,width:30,height:20},placement:'bottom'});assert(rect.y<140);assert.deepEqual(select.rect,before);select.setOpen(true);select.handleBlur();assert(!select.open);
  const tooltip=new GuiTooltip({target:select,content:'Help'});select.hovered=true;assert(tooltip.active);root.root.setVisible(false);assert(!tooltip.active);root.destroy();
});
test('slider popup movement and dismissal include previous and next visual damage',()=>{
  const root=new GuiRoot(),slider=root.add(new GuiSlider({x:100,y:100,tooltip:'hover'}));root.layout(400,250);slider.handlePointerEnter({...pointer(slider,100,100),type:'pointerenter'});const before=guiVisualDamage(slider).after;assert(before.y<slider.rect.y);const changes=[];root.onInvalidation(change=>changes.push(change));slider.setValue(80);assert(changes.some(change=>change.previousBounds.x===before.x&&change.nextBounds.x>before.x));changes.length=0;slider.handlePointerLeave({...pointer(slider,100,100),type:'pointerleave'});assert(changes.some(change=>change.previousBounds.y<slider.rect.y&&(!change.nextBounds||change.nextBounds.y===slider.rect.y)));root.destroy();
});

test('custom tooltip shadows enter old and new damage bounds without losing their styled offsets',()=>{
 const root=new GuiRoot(),slider=root.add(new GuiSlider({x:100,y:100,value:50,tooltip:'always',style:{parts:{tooltip:{shadow:{color:'#0008',blur:40,spread:5,x:20,y:-12}}}}}));root.layout(400,250);const tip=slider.tooltipRects[0],before=guiVisualDamage(slider).after;assert(before.x<=tip.x-25);assert(before.y<=tip.y-57);assert(before.x+before.width>=tip.x+tip.width+65);const changes=[];root.onInvalidation(change=>changes.push(change));slider.setStyle({parts:{tooltip:{shadow:{color:'#0008',blur:8}}}});assert(changes.some(change=>change.previousBounds.y<=before.y&&change.nextBounds?.y>before.y));root.destroy();
});
test('circular progress and image fit use the existing batches, unchanged uploads and resource retirement',async()=>{
  const {GuiRenderer}=await load('rendering/GuiRenderer'),{GuiLabel}=await load('components/GuiLabel'),device=createAuditGpuDevice(),audit=getAuditGpuDeviceState(device),engine={device,width:320,height:240,format:'rgba8unorm',displayWidth:320,displayHeight:240,msaaSamples:1,reverseZ:false,getDepthFormat:()=> 'depth24plus'};
  const renderer=new GuiRenderer({chars:'AB?0123456789%',fontSize:14,atlasSize:256,readAtlasPixels:canvas=>new Uint8Array(canvas.width*canvas.height*4),canvasFactory(width,height){const context={font:'',measureText:text=>({width:text.length*7,actualBoundingBoxAscent:11,actualBoundingBoxDescent:3}),clearRect(){},fillText(){}};return{width,height,getContext:()=>context};}}),root=new GuiRoot();
  const texture=device.createTexture({size:[200,100],format:'rgba8unorm',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST}),image=root.add(new GuiImage({source:texture,width:100,height:100,fit:'contain'}));root.add(new GuiProgress({x:120,width:64,height:64,variant:'circle',value:75,showText:true}));
  root.add(new GuiLabel({y:140,width:100,height:24,text:'AB',style:{fontSize:12}}));
  const draw=()=>{renderer.prepare(engine);root.layout(320,240);const encoder=device.createCommandEncoder(),pass=encoder.beginRenderPass({colorAttachments:[]});renderer.render(pass,[root],engine);pass.end();device.queue.submit([encoder.finish()]);root.clearDirty();};
  try{draw();const cache=renderer.rootCaches.get(root),command=cache.imageBatch.commands.find(c=>c.source===texture);assert.equal(command.width,100);assert.equal(command.height,50);assert.equal(command.y,25);assert(cache.batch.commands.some(c=>c.appearance?.arc));assert.equal(cache.textBatch.commands.find(c=>c.text==='AB').fontSize,12);const uploads=audit.snapshot().uploads;draw();assert.deepEqual(audit.snapshot().uploads,uploads);image.setFit('cover');draw();const covered=renderer.rootCaches.get(root).imageBatch.commands.find(c=>c.source===texture);assert.equal(covered.uv[2],.5);assert.equal(covered.uv[0],.25);}
  finally{root.destroy();renderer.destroy();texture.destroy();for(let i=0;i<20;i++)await Promise.resolve();}assert.equal(audit.snapshot().resources.buffer.live,0);assert.equal(audit.snapshot().resources.texture.live,0);
});
