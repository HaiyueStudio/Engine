import test from 'node:test';
import assert from 'node:assert/strict';
import {importEngineSource} from './helpers/internal-source.mjs';
import {createAuditGpuDevice,getAuditGpuDeviceState} from '../../scripts/benchmark/real-renderer-audit-device.mjs';
const {GuiRoot}=await importEngineSource('gui/components/GuiRoot.ts'),{GuiElement}=await importEngineSource('gui/components/GuiElement.ts'),{GuiLabel}=await importEngineSource('gui/components/GuiLabel.ts'),{GuiProgress}=await importEngineSource('gui/components/GuiProgress.ts'),{GuiButton}=await importEngineSource('gui/components/GuiButton.ts'),{GuiRenderer}=await importEngineSource('gui/rendering/GuiRenderer.ts'),{GuiDirtyFlags}=await importEngineSource('gui/GuiTypes.ts'),{GuiGlyphCoverage}=await importEngineSource('gui/GuiGlyphCoverage.ts');
function fixture(){
 const device=createAuditGpuDevice(),audit=getAuditGpuDeviceState(device),engine={device,format:'rgba8unorm',displayWidth:320,displayHeight:200,msaaSamples:1,reverseZ:false,getDepthFormat:()=> 'depth24plus'},root=new GuiRoot();
 const parent=root.add(new GuiElement({width:300,height:180,style:{color:'#abcdef'}})),a=parent.add(new GuiLabel({text:'A1',width:90,height:20})),b=parent.add(new GuiLabel({text:'A1',y:24,width:90,height:20})),bar=parent.add(new GuiProgress({y:50,value:25})),button=parent.add(new GuiButton({y:80,text:'A1',width:100,hoverTransition:false}));
 const renderer=new GuiRenderer({chars:'AB0123456789%?',atlasSize:128,canvasFactory(width,height){return{width,height,getContext:()=>({measureText:t=>({width:t.length*6,actualBoundingBoxAscent:8,actualBoundingBoxDescent:2}),clearRect(){},fillText(){}})};}});
 const draw=(full=false)=>{root.layout(320,200);if(full)renderer.markDirty();const encoder=device.createCommandEncoder(),pass=encoder.beginRenderPass({colorAttachments:[]});renderer.render(pass,[root],engine);pass.end();device.queue.submit([encoder.finish()]);root.clearDirty();return renderer.rootCaches.get(root);};
 const snapshot=cache=>({shapes:structuredClone(cache.batch.commands),text:structuredClone(cache.textBatch.commands),shapeRanges:structuredClone(cache.batch.commandRanges),textRanges:structuredClone(cache.textBatch.commandRanges),shapeVertices:cache.batch.vertexData.slice(0,cache.batch.vertexCount*15),textVertices:cache.textBatch.vertexData.slice(0,cache.textBatch.vertexCount*12)});
 const parity=()=>{const cache=draw(),local=snapshot(cache);draw(true);assert.deepEqual(snapshot(cache),local);return cache;};
 const close=()=>{renderer.destroy();root.destroy();assert.equal(audit.snapshot().resources.buffer.live,0);assert.equal(audit.snapshot().resources.texture.live,0);};
 return{root,parent,a,b,bar,button,renderer,draw,snapshot,parity,close};
}
test('sparse stock edits retain clean commands and invoke only changed leaf painters',()=>{
 const f=fixture();try{const cache=f.draw(),clean=cache.textBatch.commands[1],paint=f.renderer.paintElementShapes;let visits=[];f.renderer.paintElementShapes=function(e,...args){visits.push(e);return paint.call(this,e,...args);};f.a.setText('A2');f.bar.setValue(35);f.draw();assert.ok(cache.paint);assert.deepEqual(visits,[f.a,f.bar]);assert.equal(cache.textBatch.commands[1],clean);const before=f.snapshot(cache);f.draw(true);assert.deepEqual(f.snapshot(cache),before);}finally{f.close();}
});
test('unmarked public text, rectangle, style and button state changes remain observable beside a notified sibling',()=>{
 const f=fixture();try{f.draw();for(const mutate of [()=>f.b.text='B2',()=>f.b.rect.x+=3,()=>f.b.style.color='#123456',()=>delete f.b.style.color,()=>f.button.hovered=true,()=>f.button.pressed=true,()=>f.bar.max=200]){mutate();f.a.setText(f.a.text==='A1'?'A2':'A1');f.parity();}}finally{f.close();}
});
test('command-count changes rebase the complete retained spans without disturbing order',()=>{
 const f=fixture();try{f.draw();for(const mutate of [()=>f.bar.setValue(0),()=>f.bar.setValue(20),()=>f.a.style.borderColor='#ffffff',()=>delete f.a.style.borderColor,()=>f.button.variant='outline',()=>f.button.variant='default',()=>f.a.setText(''),()=>f.a.setText('B')]){mutate();f.b.setText(f.b.text==='A1'?'A2':'A1');f.parity();}}finally{f.close();}
});
test('hidden descendants never paint in isolation and unhide performs a complete rebuild',()=>{
 const f=fixture();try{f.parent.setVisible(false);f.draw();f.a.setText('B');f.parity();assert.equal(f.draw().textBatch.commands.length,0);f.parent.setVisible(true);f.parity();f.a.setVisible(false);f.parity();f.a.setText('A2');f.parity();f.a.setVisible(true);f.parity();}finally{f.close();}
});
test('reparent, direct child reorder and layout changes refresh span topology',()=>{
 const f=fixture();try{f.draw();f.parent.children.reverse();f.a.setText('B');f.parity();f.root.add(f.a);f.parity();f.a.x=15;f.a.y=20;f.a.markDirty(GuiDirtyFlags.Layout);f.parity();f.root.remove(f.a);f.parity();}finally{f.close();}
});
test('theme edits, complex styles and custom painters keep the complete collector',()=>{
 const f=fixture();try{f.draw();f.root.theme.colors.text='#456789';f.a.setText('B');f.parity();f.b.style.fontSize=22;f.b.markDirty();assert.equal(f.parity().paint,null);delete f.b.style.fontSize;f.b.markDirty();f.draw();let visits=0;f.renderer.registerElementRenderer(GuiLabel,()=>{visits++;});f.a.setText('A2');const cache=f.draw();assert.equal(cache.paint,null);assert.equal(visits,2);}finally{f.close();}
});
test('font coverage counts shared Unicode clusters and excludes CRLF exactly',()=>{
 const root=new GuiRoot(),a=root.add(new GuiLabel({text:'你👩‍👩‍👧‍👦\r\nA'})),b=root.add(new GuiLabel({text:'你A'}));try{const coverage=GuiGlyphCoverage.capture(root.root);assert.deepEqual([...coverage.glyphs].sort(),['你','👩‍👩‍👧‍👦','A'].sort());a.text='B';assert.equal(coverage.update(),true);assert.ok(coverage.glyphs.has('你'));assert.ok(!coverage.glyphs.has('👩‍👩‍👧‍👦'));b.text='';assert.equal(coverage.update(),true);assert.deepEqual([...coverage.glyphs],['B']);b.style.fontFamily='serif';assert.equal(coverage.update(),false);}finally{root.destroy();}
});
test('incremental glyph census observes an unmarked new character and replaces its atlas safely',()=>{
 const f=fixture();try{const before=f.draw().font;f.b.text='新';f.a.setText('A2');const cache=f.parity();assert.notEqual(cache.font,before);assert.ok(f.renderer.fontOwner.roots.get(f.root).families.get('sans-serif').has('新'));f.b.text='A';f.a.setText('A1');f.parity();assert.ok(!f.renderer.fontOwner.roots.get(f.root).families.get('sans-serif').has('新'));}finally{f.close();}
});
test('a failed sparse painter discards retention and restores collector context for recovery',()=>{
 const f=fixture();try{f.draw();const paint=f.renderer.paintElementShapes;let fail=true;f.renderer.paintElementShapes=function(e,...args){paint.call(this,e,...args);if(e===f.a&&fail)throw Error('sparse paint failure');};f.a.setText('A2');assert.throws(()=>f.draw(),/sparse paint failure/);assert.equal(f.renderer.rootCaches.get(f.root).paint,null);assert.equal(f.renderer.currentCache,null);assert.equal(f.renderer.currentClip,undefined);assert.equal(f.root.dirty,true);fail=false;f.parity();}finally{f.close();}
});
test('sparse clears preserve synchronous invalidations, direct clear, detach and reattach',()=>{
 const f=fixture();try{f.draw();const events=[];f.root.onInvalidation(e=>events.push(e));f.a.setText('A2');assert.equal(events.length,1);assert.equal(f.root.dirty,true);f.a.clearDirty();assert.equal(f.root.dirty,false);f.b.setText('B');f.root.clearDirty();assert.equal(f.root.dirty,false);f.a.setText('B');f.parent.remove(f.a);f.root.clearDirty();assert.equal(f.a.dirty,true);f.parent.add(f.a);f.root.clearDirty();assert.equal(f.a.dirty,false);}finally{f.close();}
});
test('custom dirty getters and clear overrides retain their live behavior',()=>{
 class Custom extends GuiElement{reads=0;clears=0;get dirty(){this.reads++;return this.live||super.dirty;}clearDirty(){this.clears++;super.clearDirty();}}
 const root=new GuiRoot(),custom=root.add(new Custom());try{root.layout(100,100);root.clearDirty();custom.live=true;assert.equal(root.dirty,true);root.clearDirty();assert.equal(custom.clears,2);assert.ok(custom.reads>0);}finally{root.destroy();}
});
test('direct public child insertion remains visible to coordinate layout and clearing',()=>{
 const root=new GuiRoot();try{root.layout(100,100);root.clearDirty();const child=new GuiLabel({text:'A',width:20,height:20});root.root.children.push(child);child.parent=root.root;assert.equal(root.dirty,true);root.layout(100,100);assert.equal(child.rect.width,20);root.clearDirty();assert.equal(child.getDirtyFlags(),GuiDirtyFlags.None);}finally{root.destroy();}
});
test('dense changes use the linear collector and sparse changes establish retention again',()=>{
 const f=fixture();try{f.draw();f.a.setText('B');f.b.setText('B');f.bar.setValue(60);f.button.setText('B');const dense=f.draw();assert.ok(dense.paint===null);const snapshot=f.snapshot(dense);f.draw(true);assert.deepEqual(f.snapshot(dense),snapshot);f.a.setText('A1');const rebuilt=f.draw();assert.ok(rebuilt.paint);const clean=rebuilt.textBatch.commands[1];f.a.setText('A2');f.draw();assert.equal(rebuilt.textBatch.commands[1],clean);}finally{f.close();}
});
test('a newly overridden live dirty getter falls back before sparse clearing',()=>{
 const f=fixture();try{f.draw();let clears=0;const clear=f.b.clearDirty;f.b.clearDirty=function(){clears++;clear.call(this);};Object.defineProperty(f.b,'dirty',{get:()=>true,configurable:true});f.a.setText('A2');f.root.clearDirty();assert.equal(clears,1);assert.equal(f.root.dirty,true);}finally{f.close();}
});
test('paint-only edits still validate mutable font geometry in retained text commands',()=>{
 const f=fixture();try{const cache=f.draw();cache.font.chars.get(65).xadvance+=3;f.bar.setValue(30);f.parity();cache.font.kernings.set(65*65536+49,2);f.bar.setValue(35);f.parity();}finally{f.close();}
});
test('a throwing layout disposer cannot retain the new dirty owner',async()=>{
 const {guiDirtyState}=await importEngineSource('gui/GuiDirtyState.ts'),root=new GuiRoot();root.installLayoutDelegate({measure:()=>({width:1,height:1}),arrange(){},dispose(){throw Error('dispose failure');}});assert.ok(guiDirtyState(root.root));assert.throws(()=>root.destroy(),/dispose failure/);assert.equal(guiDirtyState(root.root),undefined);
});
