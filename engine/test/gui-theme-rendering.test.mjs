import test from 'node:test';
import assert from 'node:assert/strict';
import {importEngineSource} from './helpers/internal-source.mjs';
import {createAuditGpuDevice,getAuditGpuDeviceState} from '../../scripts/benchmark/real-renderer-audit-device.mjs';
const {GuiRenderer}=await importEngineSource('gui/rendering/GuiRenderer.ts');
const {GuiRoot}=await importEngineSource('gui/components/GuiRoot.ts');
const {GuiLabel}=await importEngineSource('gui/components/GuiLabel.ts');
const {GuiButton}=await importEngineSource('gui/components/GuiButton.ts');
const {GuiModal}=await importEngineSource('gui/components/GuiModal.ts');
const {GuiElement}=await importEngineSource('gui/components/GuiElement.ts');
const {GuiThemeResource}=await importEngineSource('gui/GuiThemeResource.ts');
const {bindGuiMeasureOwner}=await importEngineSource('gui/GuiMeasure.ts');
const {GuiImageBatch}=await importEngineSource('gui/rendering/GuiImageBatch.ts');
const tick=async()=>{for(let i=0;i<16;i++)await Promise.resolve();};

function fixture(resource){
 const device=createAuditGpuDevice(),audit=getAuditGpuDeviceState(device);
 const engine={device,format:'rgba8unorm',displayWidth:300,displayHeight:200,msaaSamples:1,reverseZ:false,getDepthFormat:()=> 'depth24plus'};
 const renderer=new GuiRenderer({chars:'AB? i',fontSize:10,atlasSize:128,readAtlasPixels:canvas=>new Uint8Array(canvas.width*canvas.height*4),canvasFactory(width,height){
  const context={font:'',measureText:text=>({width:text.length*(context.font.includes('Wide')?10:5),actualBoundingBoxAscent:8,actualBoundingBoxDescent:2}),clearRect(){},fillText(){}};
  return {width,height,getContext:()=>context};
 }});
 const root=new GuiRoot({theme:{fontFamily:'Narrow',fontSize:10},themeResource:resource});
 const prepare=()=>{renderer.prepare(engine);bindGuiMeasureOwner(root,renderer);root.layout(300,200);};
 const draw=()=>{prepare();const encoder=device.createCommandEncoder(),pass=encoder.beginRenderPass({colorAttachments:[]});renderer.render(pass,[root],engine);pass.end();device.queue.submit([encoder.finish()]);root.clearDirty();};
 const measure=element=>root.measureElement(element,{mode:'unbounded'},{mode:'unbounded'});
 return {device,audit,engine,renderer,root,prepare,draw,measure,close(){root.destroy();renderer.destroy();}};
}

test('two font families in one root use matching intrinsic metrics and actual retained draw atlases',async()=>{
 const resource=new GuiThemeResource({normal:{fontFamily:'Narrow',fontSize:10}}),f=fixture(resource);
 const narrow=f.root.add(new GuiLabel({text:'AB'})),wide=f.root.add(new GuiLabel({text:'AB',y:30,style:{fontFamily:'Wide',fontSize:20}}));
 f.prepare();assert.equal(f.measure(narrow).width,12);assert.equal(f.measure(wide).width,44);f.draw();
 const cache=f.renderer.rootCaches.get(f.root);assert.equal(cache.extraFonts.size,1);
 const text=cache.plan.layer(0).filter(draw=>draw.kind==='text');assert.equal(text.length,2);assert.notEqual(text[0].font.id,text[1].font.id);
 const extra=[...cache.extraFonts.values()][0];assert.equal(extra.textBatch.commands[0].fontSize,20);
 const live=f.audit.snapshot().resources.texture.live;wide.setStyle({fontFamily:undefined,fontSize:undefined});f.draw();await tick();
 assert.equal(cache.extraFonts.size,0);assert.equal(f.audit.snapshot().resources.texture.live,live-1);
 f.close();await tick();assert.equal(f.audit.snapshot().resources.texture.live,0);assert.equal(f.audit.snapshot().resources.buffer.live,0);
});

test('nine-slice skin draws below semantic content and exposes a focus ring without a default opaque fill',async()=>{
 const source={width:30,height:30},resource=new GuiThemeResource({controls:{GuiButton:{normal:{nineSlice:{source,sourceWidth:30,sourceHeight:30,cuts:[4,4,4,4]}}}}}),f=fixture(resource);
 const button=f.root.add(new GuiButton({text:'AB',x:10,y:10,width:100,height:40}));f.draw();
 const cache=f.renderer.rootCaches.get(f.root);assert.deepEqual(cache.plan.layer(0).map(draw=>draw.kind),['image','text']);
 assert.equal(cache.imageBatch.commands.length,9);assert.equal(cache.imageBatch.commands[4].width,92);
 button.handleFocus();f.draw();assert.deepEqual(cache.plan.layer(0).map(draw=>draw.kind),['image','shape','text']);
 const uploads=f.audit.snapshot().uploads.calls;for(let i=0;i<20;i++)f.draw();assert.equal(f.audit.snapshot().uploads.calls,uploads,'static theme frames add no uploads');
 resource.update({controls:{GuiButton:{normal:{color:'red'}}}});f.draw();await tick();
 assert.equal(f.renderer.imageRenderer.sourceUsers.size,0,'removing the final themed image synchronizes even an empty draw plan');
 f.close();await tick();assert.equal(f.audit.snapshot().resources.texture.live,0);assert.equal(f.audit.snapshot().resources.buffer.live,0);
});

test('image runs preserve A/B/A painter order and keep exact command ranges for ordered GUI drawing',()=>{
 const a={width:2,height:2},b={width:2,height:2},batch=new GuiImageBatch();
 for(const source of [a,b,a])batch.addImage({source,x:0,y:0,width:5,height:5,uv:[0,0,1,1],color:[1,1,1,.5]});
 batch.rebuild();assert.deepEqual(batch.groups.map(group=>group.source),[a,b,a]);
 assert.equal(batch.commandRanges.length,3);assert.deepEqual(batch.commandRanges.map(r=>[r.first,r.count]),[[0,6],[0,6],[0,6]]);
 batch.clear();assert.equal(batch.commandRanges.length,0);
});

test('content insets shrink proportionally and only resize child coordinates when they own content padding',()=>{
 const root=new GuiRoot(),panel=root.add(new GuiElement({width:10,height:6,style:{contentInsets:{left:8,right:12,top:4,bottom:8}}})),child=panel.add(new GuiElement({width:'100%',height:'100%'}));
 root.layout(100,100);assert.deepEqual(child.rect,{x:4,y:2,width:0,height:0});root.destroy();
});

test('a custom modal renderer keeps its existing ownership of backdrop painting',async()=>{
 const f=fixture();f.renderer.registerElementRenderer(GuiModal,()=>{});f.root.add(new GuiModal({visible:true,title:'',message:'',showCloseButton:false,showConfirmButton:false,showCancelButton:false}));f.draw();
 assert.equal(f.renderer.rootCaches.get(f.root).modalBatch.commands.length,0,'framework does not add a backdrop to an explicitly replaced renderer');f.close();await tick();assert.equal(f.audit.snapshot().resources.texture.live,0);
});
