import test from 'node:test';
import assert from 'node:assert/strict';
import {importEngineSource} from './helpers/internal-source.mjs';
const {GuiSystem}=await importEngineSource('gui/systems/GuiSystem.ts');
const {GuiRoot}=await importEngineSource('gui/components/GuiRoot.ts');
const {GuiElement}=await importEngineSource('gui/components/GuiElement.ts');
const {GuiButton}=await importEngineSource('gui/components/GuiButton.ts');
const {GuiModal}=await importEngineSource('gui/components/GuiModal.ts');
const {GuiScrollView}=await importEngineSource('gui/components/GuiScrollView.ts');
const {GuiSlider}=await importEngineSource('gui/components/GuiSlider.ts');
const {GuiInput}=await importEngineSource('gui/components/GuiInput.ts');
const {RenderView}=await importEngineSource('core/RenderView.ts');
const {Entity}=await importEngineSource('ecs/Entity.ts');

class Surface extends EventTarget {
 tabIndex=0;captured=new Set();listeners=new Map();scale=1;
 getBoundingClientRect(){return {left:10,top:20,width:400*this.scale,height:200*this.scale};}
 addEventListener(name,fn,...rest){if(!this.listeners.has(name))this.listeners.set(name,new Set());this.listeners.get(name).add(fn);super.addEventListener(name,fn,...rest);}
 removeEventListener(name,fn,...rest){this.listeners.get(name)?.delete(fn);super.removeEventListener(name,fn,...rest);}
 setPointerCapture(id){this.captured.add(id);}hasPointerCapture(id){return this.captured.has(id);}
 releasePointerCapture(id){if(this.captured.delete(id)){const event=new Event('lostpointercapture');Object.assign(event,{pointerId:id});this.dispatchEvent(event);}}
 focus(){}
}
function setup({preview=true,scale=1,sourceOptions={}}={}) {
 const canvas=new Surface();canvas.scale=scale;
 const engine={canvas,displayWidth:400,displayHeight:200},system=new GuiSystem(engine),root=new GuiRoot();
 // Input-only tests never create or simulate GPU resources.
 system.renderer.prepare=()=>{};system.roots.add(root);
 const counts={get:0,preview:0,dispose:0,drop:0,click:0,cancel:0,end:[],hover:[]},payload={business:{id:7}};payload.circular=payload;
 const source=root.add(new GuiButton({id:'source',width:80,height:40,onClick:()=>counts.click++,onPointerCancel:()=>counts.cancel++}));
 const target=root.add(new GuiElement({id:'target',x:160,y:0,width:100,height:80}));
 const protocol={getData(){counts.get++;return payload;},...(preview?{createPreview(){counts.preview++;return new GuiElement({width:40,height:20,pointerFilter:'stop'});},disposePreview(){counts.dispose++;}}:{}),onEnd(value){counts.end.push(value);},...sourceOptions};source.setDragSource(protocol);
 let rule=true;
 const drop={canDrop:()=>rule,drop(data,position){counts.drop++;assert.equal(data,payload);counts.position={...position};},onHoverChange(...values){counts.hover.push(values);}};target.setDropTarget(drop);
 const scene=[],off=system.onUnhandledInput(event=>scene.push(event.type));
 const ready=()=>{root.layout(400,200);root.clearDirty();system.inputDomain.refresh();};ready();
 const send=(type,x,y,{id=1,pointerType='mouse'}={})=>{const event={type,pointerId:id,pointerType,button:0,buttons:type==='pointerup'||type==='pointercancel'?0:1,clientX:10+x*scale,clientY:20+y*scale,isTrusted:true,defaultPrevented:false,preventDefault(){this.defaultPrevented=true;}};system.inputDomain.onPointer(event);return event;};
 const begin=()=>{send('pointerdown',20,20);send('pointermove',40,20);};
 const close=()=>{off();system.destroy();root.destroy();assert.equal(canvas.captured.size,0);for(const entries of canvas.listeners.values())assert.equal(entries.size,0);};
 return {canvas,engine,system,root,source,target,counts,payload,protocol,drop,scene,send,begin,ready,close,rule(value){rule=value;},get previewRoot(){return system.dragPreview.root;}};
}

test('subthreshold motion keeps the ordinary click; no payload, preview or drag end callback runs',()=>{
 const f=setup();f.send('pointerdown',20,20);f.send('pointermove',25,20);assert.equal(f.system.dragSession,null);f.send('pointerup',25,20);
 assert.equal(f.counts.click,1);assert.equal(f.counts.get,0);assert.deepEqual(f.counts.end,[]);assert.equal(f.canvas.captured.size,0);f.close();
});
test('exact six CSS pixels starts once across scale, retains payload identity and commits only once',()=>{
 const f=setup({scale:2});f.send('pointerdown',20,20);f.send('pointermove',22.9,20);assert.equal(f.counts.get,0);f.send('pointermove',23,20);assert.equal(f.counts.get,1);
 assert.equal(f.counts.cancel,1);assert.equal(f.source.pressed,false);assert.ok(f.previewRoot);const handle=f.system.dragSession;assert.equal(handle.sourceId,'source');assert.equal(handle.pointerId,1);
 f.send('pointermove',180,30);assert.equal(handle.targetId,'target');f.send('pointerup',180,30);f.send('pointerup',180,30);
 assert.equal(f.counts.drop,1);assert.deepEqual(f.counts.position,{x:20,y:30});assert.equal(f.counts.click,0);assert.deepEqual(f.counts.end,[true]);assert.equal(f.counts.preview,1);assert.equal(f.counts.dispose,1);assert.equal(f.previewRoot,null);assert.equal(f.system.dragSession,null);assert.equal(f.canvas.captured.size,0);handle.cancel();assert.deepEqual(f.counts.end,[true]);f.close();
});
test('release rechecks a changed acceptance rule and clears semantic hover without submitting',()=>{
 const f=setup();f.begin();f.send('pointermove',180,30);assert.deepEqual(f.counts.hover,[[true,true]]);f.rule(false);f.send('pointerup',180,30);
 assert.equal(f.counts.drop,0);assert.deepEqual(f.counts.end,[false]);assert.deepEqual(f.counts.hover.at(-1),[false,false]);assert.equal(f.counts.dispose,1);assert.equal(f.canvas.captured.size,0);f.close();
});
test('release uses the current hit rather than the last hovered target',()=>{
 const f=setup();let second=0;f.root.add(new GuiElement({x:280,y:0,width:80,height:80,dropTarget:{canDrop:()=>true,drop:data=>{assert.equal(data,f.payload);second++;}}}));f.ready();
 f.begin();f.send('pointermove',180,30);f.send('pointerup',300,30);assert.equal(second,1);assert.equal(f.counts.drop,0);assert.deepEqual(f.counts.end,[true]);f.close();
});
test('rejected, occluded and clipped targets never receive a drop',()=>{
 for(const kind of ['rejected','occluded','clipped']) {
  const f=setup();if(kind==='rejected')f.rule(false);
  if(kind==='occluded')f.root.add(new GuiElement({x:160,width:100,height:80}));
  if(kind==='clipped'){const parent=f.root.add(new GuiElement({x:160,width:20,height:80}));parent.add(f.target);f.target.x=0;}
  f.ready();f.begin();f.send('pointermove',200,30);f.send('pointerup',200,30);assert.equal(f.counts.drop,0,kind);assert.deepEqual(f.counts.end,[false]);f.close();
 }
});
test('deleting or hiding source/target, or replacing an attached protocol cancels before release',()=>{
 for(const change of ['source-remove','source-hide','target-remove','target-disable','source-replace','target-replace']) {
  const f=setup();f.begin();f.send('pointermove',180,30);
  if(change==='source-remove')f.root.remove(f.source);if(change==='source-hide')f.source.setVisible(false);
  if(change==='target-remove')f.root.remove(f.target);if(change==='target-disable')f.target.setDisabled(true);
  if(change==='source-replace')f.source.setDragSource({getData:()=>({})});if(change==='target-replace')f.target.setDropTarget({canDrop:()=>true,drop:()=>assert.fail('Replacement must not inherit old gesture')});
  f.system.inputDomain.refresh();assert.equal(f.system.dragSession,null,change);assert.equal(f.previewRoot,null);assert.equal(f.canvas.captured.size,0);f.send('pointerup',180,30);assert.equal(f.counts.drop,0);assert.deepEqual(f.counts.end,[false]);f.close();
 }
});
test('modal changes, blur, pointercancel, lost capture and host pause finish exactly once',()=>{
 for(const kind of ['modal','blur','pointercancel','lostcapture','pause','disabled']) {
  const f=setup();f.begin();f.send('pointermove',180,30);
  if(kind==='modal'){const modal=f.root.add(new GuiModal());modal.show();f.system.inputDomain.refresh();}
  if(kind==='blur')f.canvas.dispatchEvent(new Event('blur'));
  if(kind==='pointercancel')f.send('pointercancel',180,30);
  if(kind==='lostcapture')f.canvas.releasePointerCapture(1);
  if(kind==='pause')f.system.stopAnimations();if(kind==='disabled')f.system.disabled=true;
  assert.equal(f.system.dragSession,null,kind);assert.equal(f.previewRoot,null);assert.equal(f.canvas.captured.size,0);f.send('pointerup',180,30);assert.equal(f.counts.drop,0);assert.deepEqual(f.counts.end,[false]);f.close();
 }
});
test('another pointer cannot move, commit or cancel the semantic session',()=>{
 const f=setup();f.begin();const handle=f.system.dragSession;f.send('pointermove',180,30,{id:2});f.send('pointerup',180,30,{id:2});assert.equal(f.system.dragSession,handle);assert.equal(handle.targetId,null);
 f.send('pointermove',180,30);f.send('pointerup',180,30);assert.equal(f.counts.drop,1);assert.deepEqual(f.counts.end,[true]);f.close();
});
test('touch auto keeps vertical list scrolling; a dedicated drag handle owns the same gesture',()=>{
 for(const mode of ['auto','drag']) {
  const f=setup({sourceOptions:{touchGesture:mode}}),scroll=f.root.add(new GuiScrollView({width:120,height:80,contentHeight:400,scrollY:60}));scroll.add(f.source);f.source.y=70;f.ready();
  f.send('pointerdown',20,20,{pointerType:'touch'});f.send('pointermove',20,50,{pointerType:'touch'});
  if(mode==='auto'){assert.equal(f.counts.get,0);assert.equal(scroll.scrollY,30);}else {assert.equal(f.counts.get,1);assert.equal(scroll.scrollY,60);}
  f.send('pointerup',20,50,{pointerType:'touch'});assert.equal(f.counts.drop,0);assert.equal(f.counts.click,0);f.close();
 }
});
test('horizontal touch dragging inside a vertical scroller does not also scroll',()=>{
 const f=setup(),scroll=f.root.add(new GuiScrollView({width:120,height:80,contentHeight:400,scrollY:60}));scroll.add(f.source);f.source.y=70;f.ready();
 f.send('pointerdown',20,20,{pointerType:'touch'});f.send('pointermove',50,22,{pointerType:'touch'});assert.equal(f.counts.get,1);assert.equal(scroll.scrollY,60);f.send('pointermove',180,30,{pointerType:'touch'});f.send('pointerup',180,30,{pointerType:'touch'});assert.equal(f.counts.drop,1);f.close();
});
test('text editing and value controls do not inherit a container drag gesture',()=>{
 for(const kind of ['input','slider']) {
  const f=setup(),parent=f.root.add(new GuiElement({width:120,height:60,dragSource:f.protocol}));
  const control=parent.add(kind==='input'?new GuiInput({width:100,height:30,value:'text'}):new GuiSlider({width:100,height:30,value:5}));f.root.remove(f.source);f.system.updateInputCaretFromPointer=()=>{};f.ready();
  f.send('pointerdown',20,20);f.send('pointermove',70,20);f.send('pointerup',70,20);assert.equal(f.counts.get,0);if(kind==='slider')assert.equal(control.value,70);f.close();
 }
});
test('keyboard pickup, ordered and directional target selection, placement and cancellation use the same payload',()=>{
 const f=setup();let other=0;const second=f.root.add(new GuiElement({id:'second',x:280,width:80,height:80,dropTarget:{canDrop:()=>true,drop:()=>other++}}));f.ready();f.system.focus.focus(f.source);
 assert.equal(f.system.dispatchAction('confirm'),true);assert.equal(f.counts.get,1);assert.equal(f.system.dragSession.pointerId,undefined);assert.equal(f.counts.click,0);
 f.system.dispatchAction('next');assert.equal(f.system.dragSession.targetId,'target');f.system.dispatchAction('right');assert.equal(f.system.dragSession.targetId,'second');f.system.dispatchAction('previous');assert.equal(f.system.dragSession.targetId,'target');
 f.system.dispatchAction('confirm');assert.equal(f.counts.drop,1);assert.equal(other,0);assert.equal(f.system.focus.focused,f.source);assert.deepEqual(f.counts.end,[true]);
 f.system.dispatchAction('confirm');f.system.dispatchAction('next');f.system.dispatchAction('cancel');assert.equal(f.system.dragSession,null);assert.deepEqual(f.counts.end,[true,false]);assert.equal(f.counts.drop,1);assert.equal(second.focusOptions.mode,'none');f.close();
});
test('keyboard navigation reveals a clipped scrolling target before confirming its local position',()=>{
 const f=setup(),scroll=f.root.add(new GuiScrollView({x:160,width:110,height:70,contentHeight:400}));scroll.add(f.target);f.target.x=0;f.target.y=200;f.ready();f.system.focus.focus(f.source);
 f.system.dispatchAction('confirm');f.system.dispatchAction('next');assert.ok(scroll.scrollY>0);assert.equal(f.system.dragSession.targetId,'target');f.system.dispatchAction('confirm');assert.equal(f.counts.drop,1);assert.ok(f.counts.position.y>=0&&f.counts.position.y<=80);f.close();
});
test('a target that stops accepting after keyboard selection cannot commit',()=>{
 const f=setup();f.system.focus.focus(f.source);f.system.dispatchAction('confirm');f.system.dispatchAction('next');f.rule(false);f.system.dispatchAction('confirm');assert.equal(f.counts.drop,0);assert.deepEqual(f.counts.end,[false]);f.close();
});
test('preview children are excluded from hit testing and borrowed theme subscriptions are removed',()=>{
 const f=setup(),listeners=new Set(),resource={version:1,resolve:()=>({color:'#fff'}),subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);}};
 let preview;f.source.setDragSource({...f.protocol,createPreview(){f.counts.preview++;preview=new GuiElement({width:80,height:40,themeResource:resource});preview.add(new GuiButton({width:60,height:30}));return preview;}});
 f.begin();assert.equal(listeners.size,1);f.send('pointermove',160,10);f.previewRoot.layout(400,200);assert.equal(f.system.inputParticipant.pickHost({x:180,y:30}),f.target);assert.equal(f.system.inputRoots().includes(f.previewRoot),false);
 f.send('pointerup',180,30);assert.equal(preview.parent,null);assert.equal(listeners.size,0);assert.equal(f.counts.dispose,1);f.close();
});
test('callbacks can cancel during payload/preview creation without leaks or duplicate end',()=>{
 for(const phase of ['data','preview']) {
  const f=setup();f.source.setDragSource({...f.protocol,getData(){f.counts.get++;if(phase==='data')f.system.dragSession.cancel();return f.payload;},createPreview(){f.counts.preview++;const preview=new GuiElement({width:20,height:20});if(phase==='preview')f.system.dragSession.cancel();return preview;}});
  f.begin();assert.equal(f.system.dragSession,null);assert.equal(f.previewRoot,null);assert.equal(f.canvas.captured.size,0);assert.deepEqual(f.counts.end,[false]);assert.equal(f.counts.dispose,phase==='preview'?1:0);f.send('pointerup',180,30);assert.equal(f.counts.drop,0);f.close();
 }
});
test('throwing data, preview, canDrop, drop and cleanup callbacks leave no live session or capture',()=>{
 for(const phase of ['data','preview','canDrop','drop','hover','dispose','end']) {
  const f=setup();const broken=()=>{throw new TypeError('business callback failure');};
  f.source.setDragSource({...f.protocol,...(phase==='data'?{getData:broken}:{}),...(phase==='preview'?{createPreview:broken}:{}),...(phase==='dispose'?{disposePreview:broken}:{}),...(phase==='end'?{onEnd:broken}:{})});
  if(phase==='canDrop')f.target.setDropTarget({...f.drop,canDrop:broken});if(phase==='drop')f.target.setDropTarget({...f.drop,drop:broken});if(phase==='hover')f.target.setDropTarget({...f.drop,onHoverChange:broken});
  assert.throws(()=>{f.begin();f.send('pointermove',180,30);f.send('pointerup',180,30);});assert.equal(f.system.dragSession,null,phase);assert.equal(f.previewRoot,null,phase);assert.equal(f.canvas.captured.size,0,phase);f.close();
 }
});
test('target mutation inside canDrop is revalidated before a drop callback can run',()=>{
 const f=setup();let mutate=false;f.target.setDropTarget({...f.drop,canDrop(){if(mutate)f.root.remove(f.target);return true;}});f.begin();f.send('pointermove',180,30);mutate=true;f.send('pointerup',180,30);assert.equal(f.counts.drop,0);assert.deepEqual(f.counts.end,[false]);assert.equal(f.previewRoot,null);f.close();
});
test('reentrant UI confirmation cannot invoke drop twice',()=>{
 const f=setup();f.target.setDropTarget({...f.drop,canDrop(){f.system.dispatchAction('confirm');return true;},drop(){f.counts.drop++;f.system.dispatchAction('confirm');}});
 f.begin();f.send('pointermove',180,30);f.send('pointerup',180,30);assert.equal(f.counts.drop,1);assert.deepEqual(f.counts.end,[true]);f.close();
});
test('source pass-through sends one scene cancellation on drag takeover, while simple clicks preserve the original policy',()=>{
 const f=setup();f.source.pointerFilter='pass';f.send('pointerdown',20,20);f.send('pointermove',23,20);assert.deepEqual(f.scene,['pointerdown','pointermove']);f.send('pointermove',40,20);f.send('pointermove',180,30);f.send('pointerup',180,30);
 assert.deepEqual(f.scene,['pointerdown','pointermove','pointercancel']);assert.equal(f.counts.drop,1);f.close();
});
test('destroy with a throwing end callback still unregisters listeners and releases its preview',()=>{
 const f=setup();f.source.setDragSource({...f.protocol,onEnd(){throw new TypeError('end failure');}});f.begin();assert.throws(()=>f.system.destroy());assert.equal(f.previewRoot,null);assert.equal(f.canvas.captured.size,0);assert.equal(f.system.inputDomain.dragSession,null);f.close();
});
test('cross-viewport drag uses one domain, a global preview and target-local logical coordinates at CSS scale/DPR',()=>{
 const canvas=new Surface();canvas.scale=1.5;const engine={canvas,displayWidth:400,displayHeight:200,width:800,height:400};
 const systems=[new GuiSystem(engine),new GuiSystem(engine),new GuiSystem(engine)],roots=systems.map(()=>new GuiRoot());
 systems.forEach((system,i)=>{system.renderer.prepare=()=>{};system.roots.add(roots[i]);});
 const target={width:800,height:400};systems[0].inputView={target,displayWidth:180,displayHeight:200,viewport:{x:0,y:0,width:360,height:400}};systems[1].inputView={target,displayWidth:180,displayHeight:200,viewport:{x:440,y:0,width:360,height:400}};
 roots[0].layout(180,200);roots[1].layout(180,200);roots[2].layout(400,200);const data={id:3},ends=[];let received;
 roots[0].add(new GuiButton({x:10,y:10,width:80,height:40,dragSource:{getData:()=>data,createPreview:()=>new GuiElement({width:40,height:20}),onEnd:value=>ends.push(value)}}));
 const drop=roots[1].add(new GuiElement({x:20,y:20,width:90,height:60,dropTarget:{canDrop:()=>true,drop:(value,position)=>{assert.equal(value,data);received={...position};}}}));roots[0].layout(180,200);roots[1].layout(180,200);
 const send=(type,x,y)=>systems[0].inputDomain.onPointer({type,clientX:10+x*1.5,clientY:20+y*1.5,pointerId:4,pointerType:'mouse',button:0,buttons:type==='pointerup'?0:1,isTrusted:true,preventDefault(){}});
 send('pointerdown',30,30);send('pointermove',50,30);assert.equal(systems[0].dragPreview.root,null);assert.equal(systems[1].dragPreview.root,null);const preview=systems[2].dragPreview.root;assert.ok(preview);
 send('pointermove',270,50);preview.layout(400,200);assert.equal(preview.root.children[0].rect.x,282);assert.equal(systems[1].inputParticipant.pickHost({x:270,y:50}),drop);
 send('pointerup',270,50);assert.deepEqual(received,{x:30,y:30});assert.deepEqual(ends,[true]);assert.equal(systems[2].dragPreview.root,null);assert.equal(canvas.captured.size,0);
 systems.forEach(s=>s.destroy());roots.forEach(r=>r.destroy());
});
test('a clipped preview host fails clearly, and using the source root as preview cannot reparent business UI',()=>{
 for(const mode of ['clipped','ancestor']) {
  const f=setup();if(mode==='clipped')f.system.inputView={target:{width:400,height:200},displayWidth:400,displayHeight:200,scissor:{x:0,y:0,width:300,height:200}};
  else f.source.setDragSource({...f.protocol,createPreview:()=>f.root.root});
  assert.throws(()=>f.begin());assert.equal(f.system.dragSession,null);assert.equal(f.root.root.parent,null);assert.equal(f.source.parent,f.root.root);assert.equal(f.canvas.captured.size,0);f.close();
 }
});
test('ordinary controls allocate no dormant drag slots; malformed bindings are rejected without changing state',()=>{
 const element=new GuiElement();assert.equal(element.dragSource,null);assert.equal(element.dropTarget,null);assert.equal(Object.hasOwn(element,'dragConfiguration'),false);assert.equal(Object.hasOwn(element,'dropConfiguration'),false);
 for(const binding of [undefined,0,false,'source',{}, {getData:1}, {getData(){},touchGesture:'invalid'}, {getData(){},onEnd:3}])assert.throws(()=>element.setDragSource(binding),TypeError);
 for(const binding of [undefined,0,{}, {canDrop(){},drop:1}, {canDrop(){},drop(){},onHoverChange:'invalid'}])assert.throws(()=>element.setDropTarget(binding),TypeError);
 const source={getData:()=>null};element.setDragSource(source);assert.equal(element.dragSource,source);assert.throws(()=>element.setDragSource({getData:1}));assert.equal(element.dragSource,source);element.setDragSource(null);assert.equal(element.dragSource,null);
});
test('disposed and zero-sized regions become ineligible without reading a disposed snapshot',()=>{
 for(const change of ['dispose','empty']) {
  const f=setup(),view=new RenderView({camera:new Entity(),target:{width:400,height:200,displayWidth:400,displayHeight:200,format:'rgba8unorm'}});
  const region=view.createRegion({id:'live',bounds:{x:0,y:0,width:400,height:200},visible:true,updateMode:'demand',clearMode:'on-update'});f.system.region=region;
  f.begin();f.send('pointermove',180,30);if(change==='dispose')region.dispose();else region.setBounds({x:0,y:0,width:0,height:200});
  assert.doesNotThrow(()=>f.system.inputDomain.refresh());assert.equal(f.system.dragSession,null);assert.equal(f.canvas.captured.size,0);assert.deepEqual(f.counts.end,[false]);f.send('pointerup',180,30);assert.equal(f.counts.drop,0);f.close();view.destroy();
 }
});
test('data-only dragging needs no preview overlay and old handles cannot affect a later session',()=>{
 const f=setup({preview:false});f.system.inputView={target:{width:400,height:200},displayWidth:400,displayHeight:200,scissor:{x:0,y:0,width:300,height:200}};
 f.begin();const old=f.system.dragSession;f.send('pointermove',180,30);f.send('pointerup',180,30);assert.equal(f.counts.drop,1);assert.equal(f.counts.preview,0);assert.equal(old.targetId,null);
 f.begin();const current=f.system.dragSession;old.cancel();assert.equal(f.system.dragSession,current);current.cancel();assert.equal(f.system.dragSession,null);assert.deepEqual(f.counts.end,[true,false]);f.close();
});
test('outside terminal delivery removes cancelled pointer tombstones and all shared native listeners are released',()=>{
 class AuditTarget extends EventTarget {listeners=new Map();addEventListener(type,fn,...rest){if(!this.listeners.has(type))this.listeners.set(type,new Set());this.listeners.get(type).add(fn);super.addEventListener(type,fn,...rest);}removeEventListener(type,fn,...rest){this.listeners.get(type)?.delete(fn);super.removeEventListener(type,fn,...rest);}}
 const window=new AuditTarget(),document=new AuditTarget(),f=setup();document.defaultView=window;
 // Rebind an input-only surface with its document before registering the GUI.
 f.close();const canvas=new Surface();canvas.ownerDocument=document;
 const system=new GuiSystem({canvas,displayWidth:400,displayHeight:200}),root=new GuiRoot();system.renderer.prepare=()=>{};system.roots.add(root);root.add(new GuiButton({width:80,height:40,dragSource:{getData:()=>null}}));root.layout(400,200);
 const send=(type,x)=>system.inputDomain.onPointer({type,pointerId:15,pointerType:'mouse',button:0,clientX:10+x,clientY:40,isTrusted:true,preventDefault(){}});
 send('pointerdown',20);send('pointermove',40);system.dragSession.cancel();assert.equal(canvas.captured.size,0);assert.equal(system.inputDomain.pointers.size,1);
 const outside=new Event('pointerup');Object.assign(outside,{pointerId:15});window.dispatchEvent(outside);assert.equal(system.inputDomain.pointers.size,0);system.destroy();root.destroy();
 for(const target of [canvas,window,document])for(const listeners of target.listeners.values())assert.equal(listeners.size,0);
});
