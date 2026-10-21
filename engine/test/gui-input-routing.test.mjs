import assert from 'node:assert/strict';
import test from 'node:test';
import {GuiRoot,GuiElement,GuiButton,GuiModal,GuiSlider,GuiSystem} from '../dist/gui.js';
import {InputMap} from '../dist/input.js';
import {RenderView} from '../dist/core.js';
import {Entity,World} from '../dist/ecs.js';

class LifecycleTarget extends EventTarget {
 listeners=new Map();
 addEventListener(n,f,o){if(!this.listeners.has(n))this.listeners.set(n,new Set());this.listeners.get(n).add(f);super.addEventListener(n,f,o);}
 removeEventListener(n,f,o){this.listeners.get(n)?.delete(f);super.removeEventListener(n,f,o);}
 count(n){return this.listeners.get(n)?.size??0;}
}
class Surface extends EventTarget {
 tabIndex=0;captured=new Set();listeners=new Map();css={left:10,top:20,width:200,height:100};
 ownerDocument=Object.assign(new LifecycleTarget(),{hidden:false,defaultView:new LifecycleTarget()});
 getBoundingClientRect(){return this.css;}focus(){}
 addEventListener(n,f,o){if(!this.listeners.has(n))this.listeners.set(n,new Set());this.listeners.get(n).add(f);super.addEventListener(n,f,o);}
 removeEventListener(n,f,o){this.listeners.get(n)?.delete(f);super.removeEventListener(n,f,o);}
 setPointerCapture(id){this.captured.add(id);}hasPointerCapture(id){return this.captured.has(id);}
 releasePointerCapture(id){if(this.captured.delete(id)){const e=new Event('lostpointercapture');Object.assign(e,{pointerId:id});this.dispatchEvent(e);}}
}
function setup(options={}) {
 const canvas=new Surface(),engine={canvas,displayWidth:200,displayHeight:100,width:400,height:200};
 const a=new GuiSystem(engine),b=new GuiSystem(engine,options),ra=new GuiRoot(),rb=new GuiRoot();
 for(const [s,r] of [[a,ra],[b,rb]]){s.roots.add(r);s.renderer.prepare=()=>{};}
 const ready=()=>{ra.layout(200,100);rb.layout(200,100);a.inputDomain.refresh();};
 const pointer=(type,id,x,y,extra={})=>{const e=new Event(type,{cancelable:true});Object.assign(e,{pointerId:id,pointerType:'touch',button:0,buttons:type==='pointerup'?0:1,clientX:x,clientY:y,...extra});canvas.dispatchEvent(e);return e;};
 return {canvas,engine,a,b,ra,rb,ready,pointer,close(){a.destroy();b.destroy();ra.destroy();rb.destroy();}};
}

test('window blur and document hiding cancel captured input, consume late release, and remove lifecycle listeners on final destroy',()=>{
 const s=setup();let cancels=0,clicks=0;const button=s.rb.add(new GuiButton({width:80,height:40,onClick:()=>clicks++,onPointerCancel:()=>cancels++}));s.ready();
 assert.equal(s.canvas.ownerDocument.count('visibilitychange'),1);assert.equal(s.canvas.ownerDocument.defaultView.count('blur'),1);
 s.pointer('pointerdown',7,30,35);s.canvas.ownerDocument.defaultView.dispatchEvent(new Event('blur'));assert.equal(cancels,1);assert.equal(button.pressed,false);assert.equal(s.canvas.captured.size,0);assert.equal(InputMap.isEventConsumed(s.pointer('pointerup',7,30,35)),true);assert.equal(clicks,0);
 s.pointer('pointerdown',8,30,35);s.canvas.ownerDocument.hidden=true;s.canvas.ownerDocument.dispatchEvent(new Event('visibilitychange'));assert.equal(cancels,2);assert.equal(s.canvas.captured.size,0);s.pointer('pointerup',8,30,35);assert.equal(clicks,0);
 s.close();assert.equal(s.canvas.ownerDocument.count('visibilitychange'),0);assert.equal(s.canvas.ownerDocument.defaultView.count('blur'),0);s.canvas.ownerDocument.defaultView.dispatchEvent(new Event('blur'));s.canvas.ownerDocument.dispatchEvent(new Event('visibilitychange'));assert.equal(cancels,2);
});

test('one canvas dispatcher picks only the top GUI and consumed sequences never reach scene defaults',()=>{
 const s=setup();let a=0,b=0;const left=s.ra.add(new GuiButton({width:80,height:40,onClick:()=>a++})),right=s.rb.add(new GuiButton({width:80,height:40,onClick:()=>b++}));s.ready();const scene=[],off=s.a.onUnhandledInput(e=>scene.push(e.type));
 const down=s.pointer('pointerdown',1,30,35);assert.equal(left.pressed,false);assert.equal(right.pressed,true);assert.equal(InputMap.isEventConsumed(down),true);
 const up=s.pointer('pointerup',1,30,35);assert.deepEqual([a,b],[0,1]);assert.deepEqual(scene,[]);assert.equal(InputMap.isEventConsumed(up),true);assert.equal(s.canvas.captured.size,0);assert.equal(s.canvas.listeners.get('pointerdown').size,1);
 off();s.close();assert.equal(s.canvas.listeners.get('pointerdown').size,0);
});

test('a scene-owned pointer cannot become a GUI click after moving over the control',()=>{
 const s=setup();let clicks=0;s.rb.add(new GuiButton({width:80,height:40,onClick:()=>clicks++}));s.ready();const scene=[],off=s.a.onUnhandledInput(e=>scene.push(e.type));
 s.pointer('pointerdown',1,190,100);s.pointer('pointermove',1,30,35);s.pointer('pointerup',1,30,35);assert.equal(clicks,0);assert.deepEqual(scene,['pointerdown','pointermove','pointerup']);off();s.close();
});

test('GUI capture keeps its original owner across layers and outside the canvas',()=>{
 const s=setup();let clicks=0,cancels=0;const button=s.rb.add(new GuiButton({width:80,height:40,onClick:()=>clicks++,onPointerCancel:()=>cancels++}));s.ra.add(new GuiButton({x:100,width:80,height:40,onClick:()=>clicks+=10}));s.ready();const scene=[],off=s.a.onUnhandledInput(e=>scene.push(e.type));
 s.pointer('pointerdown',1,30,35);s.pointer('pointermove',1,130,35);s.pointer('pointerup',1,600,300);assert.equal(clicks,0);assert.equal(cancels,0,'normal release is not followed by a second lost-capture cancellation');assert.equal(button.pressed,false);assert.deepEqual(scene,[]);off();s.close();
});

test('removing a captured node cancels once and keeps its eventual release consumed',()=>{
 const s=setup();let cancels=0,clicks=0;const button=s.rb.add(new GuiButton({width:80,height:40,onPointerCancel:()=>cancels++,onClick:()=>clicks++}));s.ready();const scene=[],off=s.a.onUnhandledInput(e=>scene.push(e.type));
 s.pointer('pointerdown',1,30,35);s.rb.remove(button);const up=s.pointer('pointerup',1,30,35);assert.equal(cancels,1);assert.equal(clicks,0);assert.equal(InputMap.isEventConsumed(up),true);assert.deepEqual(scene,[]);assert.equal(s.canvas.captured.size,0);off();s.close();
});

test('unmapped modal keys and pointer gaps are blocked independently of DOM default behavior',()=>{
 const s=setup({preventDefault:false}),modal=s.rb.add(new GuiModal());s.ready();modal.show();const scene=[],off=s.a.onUnhandledInput(e=>scene.push(e.type));
 const key=new Event('keydown',{cancelable:true});Object.assign(key,{code:'KeyQ',key:'q'});s.canvas.dispatchEvent(key);assert.equal(InputMap.isEventConsumed(key),true);assert.equal(key.defaultPrevented,false);
 s.pointer('pointerdown',1,195,110);s.pointer('pointerup',1,195,110);assert.deepEqual(scene,[]);off();s.close();
});

test('modal opened by a click cannot receive the same pointer sequence a second time',()=>{
 const s=setup();let confirms=0;const modal=s.rb.add(new GuiModal({onConfirm:()=>confirms++}));s.ra.add(new GuiButton({width:80,height:40,onClick:()=>modal.show()}));s.ready();
 s.pointer('pointerdown',1,30,35);s.pointer('pointerup',1,30,35);assert.equal(modal.visible,true);assert.equal(confirms,0);assert.equal(s.a.focus.modal,modal);s.close();
});

test('blocking modal cancels an active scene drag and suppresses its later release',()=>{
 const s=setup(),modal=s.rb.add(new GuiModal());s.ready();const scene=[],off=s.a.onUnhandledInput(e=>scene.push(e.type));
 s.pointer('pointerdown',1,195,110);modal.show();s.a.inputDomain.refresh();s.pointer('pointerup',1,195,110);assert.deepEqual(scene,['pointerdown','pointercancel']);off();s.close();
});

test('a pass-through gesture that GUI later consumes cancels the already-started scene sequence once',()=>{
 const s=setup();let clicks=0;s.rb.add(new GuiButton({width:80,height:40,pointerFilter:'pass',onClick:e=>{clicks++;e.stopPropagation();}}));s.ready();const scene=[],off=s.a.onUnhandledInput(e=>scene.push(e.type));
 s.pointer('pointerdown',1,30,35);const up=s.pointer('pointerup',1,30,35);assert.equal(clicks,1);assert.equal(InputMap.isEventConsumed(up),true);assert.deepEqual(scene,['pointerdown','pointercancel']);off();s.close();
});

test('releasing a region/pause cancels capture and prevents fresh hits until a new render association',()=>{
 const s=setup();let clicks=0,cancels=0;s.rb.add(new GuiButton({width:80,height:40,onClick:()=>clicks++,onPointerCancel:()=>cancels++}));s.ready();const scene=[],off=s.a.onUnhandledInput(e=>scene.push(e.type));
 s.pointer('pointerdown',1,30,35);s.b.releaseFrame();assert.equal(cancels,1);s.pointer('pointerup',1,30,35);assert.equal(clicks,0);
 s.pointer('pointerdown',2,30,35);s.pointer('pointerup',2,30,35);assert.equal(clicks,0);assert.deepEqual(scene,['pointerdown','pointerup']);
 s.b.prepareRoots=()=>{};s.b.advanceMotion=()=>{};s.b.dispatchPendingEvents=()=>{};s.b.render=()=>{};
 const world=new World('ResumeGuiInput');s.b.record(world,{frameData:world.frameData});
 s.pointer('pointerdown',3,30,35);s.pointer('pointerup',3,30,35);assert.equal(clicks,1);off();s.close();
});

test('untrusted replay events keep logical ownership without requesting a nonexistent native pointer capture',()=>{
 const s=setup();let captures=0,clicks=0;s.canvas.setPointerCapture=()=>captures++;s.rb.add(new GuiButton({width:80,height:40,onClick:()=>clicks++}));s.ready();
 s.pointer('pointerdown',1,30,35);s.pointer('pointerup',1,30,35);assert.equal(clicks,1);assert.equal(captures,0);s.close();
});

test('pass bubbles to a stopping ancestor, ignore skips itself and can expose a lower GUI',()=>{
 const s=setup();let root=0,parent=0,clicks=0;const p=s.rb.add(new GuiElement({width:100,height:50,pointerFilter:'stop'}));p.add(new GuiButton({width:80,height:40,pointerFilter:'pass',onClick:()=>clicks++}));p.on('click',()=>parent++);s.rb.root.on('click',()=>root++);s.ready();
 s.pointer('pointerdown',1,30,35);s.pointer('pointerup',1,30,35);assert.deepEqual([root,parent,clicks],[0,1,1]);
 s.rb.root.remove(p);s.rb.add(new GuiButton({width:80,height:40,pointerFilter:'ignore',onClick:()=>clicks+=100}));s.ra.add(new GuiButton({width:80,height:40,onClick:()=>clicks+=10}));s.ready();
 s.pointer('pointerdown',2,30,35);s.pointer('pointerup',2,30,35);assert.equal(clicks,11);s.close();
});

test('CSS scaling and fractional viewports use the unsnapped inverse and physical clipping',()=>{
 const s=setup();s.canvas.css={left:10,top:20,width:100,height:50};
 const point=s.b.inputPoint({clientX:35,clientY:30});assert.deepEqual(point,{x:50,y:20,inside:true});
 const view={target:{width:400,height:200},viewport:{x:50.5,y:20.25,width:200,height:100},scissor:{x:70,y:20,width:100,height:100},displayWidth:200,displayHeight:100};s.b.inputView=view;
 const inside=s.b.inputPoint({clientX:35,clientY:35});assert.equal(inside.x,49.5);assert.equal(inside.y,39.75);assert.equal(inside.inside,true);
 assert.equal(s.b.inputPoint({clientX:24,clientY:26}).inside,false);assert.equal(s.b.inputPoint({clientX:60,clientY:35}).inside,false);s.close();
});

test('owned fractional regions map without pixel snapping, including clipped negative origins',()=>{
 const s=setup();s.canvas.css={left:10,top:20,width:100,height:50};
 const view=new RenderView({camera:new Entity(),target:{key:'test',width:400,height:200,displayWidth:200,displayHeight:100,format:'rgba8unorm'}});
 const region=view.createRegion({id:'fractional',bounds:{x:20.25,y:5.5,width:80.5,height:40.25},updateMode:'demand',clearMode:'on-update',visible:true});s.b.region=region;
 assert.deepEqual(s.b.inputPoint({clientX:35,clientY:30}),{x:29.75,y:14.5,inside:true});
 region.setBounds({x:-10.25,y:5.5,width:80.5,height:40.25});assert.deepEqual(s.b.inputPoint({clientX:10,clientY:30}),{x:10.25,y:14.5,inside:true});
 assert.equal(s.b.inputPoint({clientX:9.9,clientY:30}).inside,false);s.close();view.destroy();
});

test('scene subscription may outlive a GUI system without retaining its capture or focus',()=>{
 const s=setup();s.rb.add(new GuiSlider({width:80,height:40}));s.ready();const scene=[],off=s.a.onUnhandledInput(e=>scene.push(e.type));
 s.pointer('pointerdown',1,30,35);s.a.destroy();s.b.destroy();assert.equal(s.canvas.captured.size,0);s.pointer('pointerup',1,30,35);assert.deepEqual(scene,[]);
 off();assert.equal(s.canvas.listeners.get('pointerdown').size,0);s.close();
});

test('redrawing a lower cached region cannot raise its input above an unchanged overlay',()=>{
 const s=setup();let lower=0,upper=0;s.ra.add(new GuiButton({width:80,height:40,onClick:()=>lower++}));s.rb.add(new GuiButton({width:80,height:40,onClick:()=>upper++}));s.ready();
 const view=new RenderView({camera:new Entity(),target:{key:'test-order',width:400,height:200,displayWidth:200,displayHeight:100,format:'rgba8unorm'}});
 s.a.region=view.createRegion({id:'lower',bounds:{x:0,y:0,width:200,height:100},updateMode:'demand',clearMode:'on-update',visible:true});
 s.b.region=view.createRegion({id:'upper',bounds:{x:0,y:0,width:200,height:100},updateMode:'demand',clearMode:'on-update',visible:true});
 s.a.inputDomain.touch(s.a.inputParticipant);s.b.inputDomain.touch(s.b.inputParticipant);
 // Isolate the record/preflight ordering from GPU allocation; native pixels are a separate gate.
 s.a.prepareRoots=()=>{};s.a.advanceMotion=()=>{};s.a.dispatchPendingEvents=()=>{};s.a.render=()=>{};
 const world=new World('CachedInputOrder');s.a.record(world,{frameData:world.frameData});
 s.pointer('pointerdown',1,30,35);s.pointer('pointerup',1,30,35);assert.deepEqual([lower,upper],[0,1]);s.close();view.destroy();
});
