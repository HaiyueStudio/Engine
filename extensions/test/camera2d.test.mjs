import test from 'node:test';
import assert from 'node:assert/strict';
import {Entity,World} from '@haiyue/engine/ecs';
import {Camera2D,Transform2D,CartesianTransform3D} from '@haiyue/engine/components';
import {createCamera2DController} from '@haiyue/extensions/camera2d';
import {RenderSystem2DBase} from '@haiyue/extensions';
const close=(a,b,tolerance=1e-8)=>assert.ok(Math.abs(a-b)<=tolerance,`${a} != ${b}`);
const pair=(a,b)=>{close(a[0],b[0]);close(a[1],b[1]);};
function fixture(options={}){
 const world=new World('camera'),camera=new Camera2D({width:100,height:80,viewportMode:'fixed'}),transform=new Transform2D(),entity=new Entity('Camera').addComponent(camera).addComponent(transform);world.addEntity(entity);
 let target=[100,50],calls=0;const get=()=>{calls++;return target;};
 const control=createCamera2DController({camera:entity,target:get,...options});
 return{world,camera,transform,entity,control,setTarget(v){target=v;},calls:()=>calls,close(){control.dispose();world.destroy();}};
}
test('exponential follow matches the analytical solution across 30/60/120/144 Hz and irregular schedules',()=>{
 const schedules=[...[30,60,120,144].map(hz=>Array(hz).fill(1000/hz)),[3,197,11,389,400]];
 for(const sequence of schedules){const f=fixture();try{for(const dt of sequence)f.control.update(dt);pair(f.control.state.position,[100*(1-Math.exp(-8)),50*(1-Math.exp(-8))]);assert.equal(Object.isFrozen(f.control.state),true);assert.equal(Object.isFrozen(f.control.state.position),true);}finally{f.close();}}
});
test('zero delta performs no sampling, transform revision, shake progress or state change',()=>{
 const f=fixture();try{f.control.shake({amplitude:10,durationMs:1000});f.control.update(100);const state=f.control.state,revision=f.transform.localVersion,calls=f.calls();f.control.update(0);assert.equal(f.control.state,state);assert.equal(f.transform.localVersion,revision);assert.equal(f.calls(),calls);}finally{f.close();}
});
test('negative and nonfinite delta are rejected atomically',()=>{
 const f=fixture();try{for(const dt of [-1,NaN,Infinity,-Infinity]){assert.throws(()=>f.control.update(dt),e=>e.code==='E_GAMEPLAY_INVALID_INPUT');pair([f.transform.x,f.transform.y],[0,0]);assert.equal(f.calls(),0);}}finally{f.close();}
});
test('zero damping snaps to dead-zone edges and input configuration is value-owned',()=>{
 const zone={width:20,height:40},bounds={x:-1000,y:-1000,width:2000,height:2000},f=fixture({damping:0,deadZone:zone,bounds});try{f.setTarget([4,5]);f.control.update(1);pair(f.control.state.position,[0,0]);f.setTarget([30,-50]);zone.width=1000;bounds.width=0;f.control.update(1);pair(f.control.state.position,[20,-30]);f.setTarget([-40,60]);f.control.update(1);pair(f.control.state.position,[-30,40]);}finally{f.close();}
});
test('level bounds, zoom and the original resize policy constrain the whole visible viewport',()=>{
 const f=fixture({damping:0,bounds:{x:0,y:0,width:1000,height:600}});try{f.setTarget([-500,-500]);f.control.reset();pair(f.control.state.position,[50,40]);f.setTarget([5000,5000]);f.control.update(1);pair(f.control.state.position,[950,560]);f.camera.zoom=2;f.control.update(1);pair(f.control.state.position,[975,580]);f.camera.designWidth=200;f.camera.designHeight=100;f.camera.resize(1600,900);f.control.update(1);pair(f.control.state.position,[950,575]);assert.equal(f.camera.viewportMode,'fixed');}finally{f.close();}
});
test('a smaller-than-viewport level pins its center even during shake',()=>{
 const f=fixture({bounds:{x:20,y:30,width:10,height:20}});try{f.control.reset();pair(f.control.state.position,[25,40]);f.control.shake({amplitude:1000,durationMs:1000});f.control.update(100);pair([f.transform.x,f.transform.y],[25,40]);pair(f.control.state.offset,[0,0]);}finally{f.close();}
});
test('all existing viewport modes and projection matrices remain owned by the original Camera2D',()=>{
 for(const mode of ['expand','fit','fill','fixed']){const f=fixture();try{f.camera.viewportMode=mode;f.camera.resize(1600,900);const projection=[...f.camera.projectionMatrix],width=f.camera.width,height=f.camera.height;f.control.reset();for(let i=0;i<20;i++)f.control.update(16);assert.deepEqual([...f.camera.projectionMatrix],projection);assert.equal(f.camera.width,width);assert.equal(f.camera.height,height);assert.equal(f.camera.viewportMode,mode);}finally{f.close();}}
});
test('seeded shake depends on elapsed time, not frame partition, and resets without accumulating drift',()=>{
 const run=(parts,seed)=>{const f=fixture({damping:0});try{f.setTarget([12,20]);f.control.reset();f.control.shake({amplitude:10,durationMs:1000,...(seed===undefined?{}:{seed})});for(const dt of parts)f.control.update(dt);return{position:f.control.state.position,offset:f.control.state.offset};}finally{f.close();}};
 const a=run([100]),b=run([25,25,25,25],0),other=run([100],1);pair(a.position,b.position);pair(a.offset,b.offset);assert.notDeepEqual(a.offset,other.offset);assert(a.offset.every(v=>Math.abs(v)<=9));
 const f=fixture({damping:0});try{f.setTarget([12,20]);f.control.reset();for(let j=0;j<5;j++){f.control.shake({amplitude:10,durationMs:100});for(let i=0;i<10;i++)f.control.update(10);pair(f.control.state.position,[12,20]);pair(f.control.state.offset,[0,0]);pair([f.transform.x,f.transform.y],[12,20]);}f.control.shake({amplitude:10,durationMs:1000});f.control.update(10);f.setTarget([400,600]);f.control.reset();pair(f.control.state.position,[400,600]);pair(f.control.state.offset,[0,0]);}finally{f.close();}
});
test('interpolation borrows alpha once, never reads or writes a physics clock, and reset uses the current target',()=>{
 let reads=0;const previous=[0,2],current=[20,10],f=fixture({damping:0,interpolation:()=>{reads++;return{previous,current,alpha:.25};}});try{f.setTarget([200,400]);f.control.update(100);pair(f.control.state.position,[5,4]);assert.equal(reads,1);assert.equal(f.calls(),0);f.control.update(500);pair(f.control.state.position,[5,4]);assert.deepEqual(previous,[0,2]);assert.deepEqual(current,[20,10]);f.control.reset();pair(f.control.state.position,[200,400]);assert.equal(reads,2);assert.equal(f.calls(),1);}finally{f.close();}
});
test('target switching, long frames and explicit teleport reset never overshoot or retain shake',()=>{
 const f=fixture();try{f.control.update(20);f.setTarget([-500,200]);f.control.update(1e9);pair(f.control.state.position,[-500,200]);f.control.shake({amplitude:20,durationMs:500});f.control.update(20);f.setTarget([5000,-100]);f.control.reset();pair(f.control.state.position,[5000,-100]);pair(f.control.state.offset,[0,0]);f.control.update(1);pair(f.control.state.position,[5000,-100]);}finally{f.close();}
});
test('camera, entity, transform and world suspension do not sample; resume discards old presentation',()=>{
 for(const key of ['camera','entity','transform','world']){const f=fixture();try{f.control.shake({amplitude:10,durationMs:1000});f.control.update(10);const state=f.control.state,calls=f.calls();f[key].disabled=true;f.setTarget([300,400]);f.control.update(500);assert.equal(f.control.state,state);assert.equal(f.calls(),calls);f[key].disabled=false;f.control.update(10);pair(f.control.state.position,[300,400]);pair(f.control.state.offset,[0,0]);}finally{f.close();}}
});

test('zero-delta suspension is observed without sampling or advancing and resets on the first positive resume',()=>{
 const f=fixture();try{
  f.control.shake({amplitude:10,durationMs:1000});f.control.update(10);
  const state=f.control.state,revision=f.transform.localVersion,calls=f.calls();
  f.camera.disabled=true;f.setTarget([300,400]);f.control.update(0);
  assert.equal(f.control.state,state);assert.equal(f.transform.localVersion,revision);assert.equal(f.calls(),calls);
  f.camera.disabled=false;f.control.update(0);
  assert.equal(f.control.state,state);assert.equal(f.calls(),calls);
  f.control.update(10);pair(f.control.state.position,[300,400]);pair(f.control.state.offset,[0,0]);
 }finally{f.close();}
});

test('bounds copy only the declared numeric geometry and never read unrelated object fields',()=>{
 const bounds={x:-1000,y:-1000,width:2000,height:2000};
 Object.defineProperty(bounds,'unrelatedLevelOwner',{enumerable:true,get(){throw Error('unrelated borrowed owner must not be read or retained');}});
 const f=fixture({bounds,damping:0});try{f.control.reset();pair(f.control.state.position,[100,50]);}finally{f.close();}
});
test('a planar parent uses the original hierarchy matrices and preserves world-space follow',()=>{
 const f=fixture({damping:0});try{const parent=new Entity('parent').addComponent(new Transform2D({x:70,y:-30,rotation:.4,scaleX:2,scaleY:1.5}));f.world.addEntity(parent);f.entity.parent=parent;f.setTarget([240,160]);f.control.reset();f.world.frameData.transforms.flushDirtyWorldVersions();let matrix=f.world.frameData.getWorldMatrix2D(f.entity);close(matrix[12],240,1e-4);close(matrix[13],160,1e-4);parent.getComponent(Transform2D).x+=100;f.setTarget([300,200]);f.control.update(20);f.world.frameData.transforms.flushDirtyWorldVersions();matrix=f.world.frameData.getWorldMatrix2D(f.entity);close(matrix[12],300,1e-4);close(matrix[13],200,1e-4);pair(f.control.state.position,[300,200]);}finally{f.close();}
});
test('rotated and scaled viewport footprints stay within bounds without changing transform orientation',()=>{
 const f=fixture({damping:0,bounds:{x:0,y:0,width:200,height:200}});try{f.camera.height=50;f.transform.rotation=Math.PI/2;f.setTarget([1000,1000]);f.control.reset();pair(f.control.state.position,[175,150]);assert.equal(f.transform.rotation,Math.PI/2);f.transform.scaleX=2;f.control.update(1);pair(f.control.state.position,[175,100]);f.control.shake({amplitude:100,durationMs:1000});f.control.update(10);assert(f.transform.x>=25&&f.transform.x<=175);close(f.transform.y,100);}finally{f.close();}
});
test('dispose restores only the presentation offset, leaves borrowed components/world alive and releases its claim',()=>{
 const f=fixture({damping:0});try{f.control.reset();f.control.shake({amplitude:10,durationMs:1000});f.control.update(10);const base=f.control.state.position,calls=f.calls();f.control.dispose();f.control.dispose();pair([f.transform.x,f.transform.y],base);assert.equal(f.entity.destroyed,false);assert.equal(f.world.destroyed,false);assert.equal(f.entity.getComponent(Camera2D),f.camera);f.control.update(20);assert.equal(f.calls(),calls);const next=createCamera2DController({camera:f.entity,target:()=>[0,0],damping:0});next.update(10);next.dispose();pair([f.transform.x,f.transform.y],[0,0]);}finally{f.close();}
});
test('new external camera values, replacement components and destruction are never overwritten by an old owner',()=>{
 const f=fixture({damping:0});try{f.control.shake({amplitude:10,durationMs:1000});f.control.update(10);f.transform.x=900;f.transform.y=800;f.control.dispose();pair([f.transform.x,f.transform.y],[900,800]);const next=createCamera2DController({camera:f.entity,target:()=>[0,0]});const replacement=new Transform2D({x:123,y:456});f.entity.addComponent(replacement);next.update(10);pair([replacement.x,replacement.y],[123,456]);next.dispose();f.entity.destroy();next.update(10);assert.equal(f.world.entities.size,0);}finally{f.close();}
});
test('invalid construction, target, interpolation, zoom and shake values fail without partial writes',()=>{
 const f=fixture();try{assert.throws(()=>createCamera2DController({camera:f.entity,target:()=>[0,0]}),e=>e.code==='E_GAMEPLAY_INVALID_INPUT');f.control.dispose();for(const patch of [{damping:-1},{damping:NaN},{target:null},{deadZone:{width:-1,height:0}},{bounds:{x:0,y:0,width:-1,height:2}},{interpolation:5}])assert.throws(()=>createCamera2DController({camera:f.entity,target:()=>[0,0],...patch}),e=>e.code==='E_GAMEPLAY_INVALID_INPUT');
 const c=createCamera2DController({camera:f.entity,target:()=>[NaN,0]});assert.throws(()=>c.update(10),e=>e.code==='E_GAMEPLAY_INVALID_INPUT');pair([f.transform.x,f.transform.y],[0,0]);for(const value of [{amplitude:-1,durationMs:1},{amplitude:1,durationMs:Infinity},{amplitude:1,durationMs:1,seed:.2}])assert.throws(()=>c.shake(value),e=>e.code==='E_GAMEPLAY_INVALID_INPUT');c.dispose();
 const d=createCamera2DController({camera:f.entity,target:()=>[0,0],interpolation:()=>({previous:[0,0],current:[1,2],alpha:2})});assert.throws(()=>d.update(10),e=>e.code==='E_GAMEPLAY_INVALID_INPUT');f.camera.zoom=0;assert.throws(()=>d.update(10),e=>e.code==='E_GAMEPLAY_INVALID_INPUT');pair([f.transform.x,f.transform.y],[0,0]);d.dispose();f.camera.zoom=1;
 f.entity.addComponent(new CartesianTransform3D());assert.throws(()=>createCamera2DController({camera:f.entity,target:()=>[0,0]}),e=>e.code==='E_GAMEPLAY_INVALID_INPUT');
 }finally{f.close();}
});
test('the existing extension camera projection matches core FrameData for original 2D and legacy 3D transforms',()=>{
 class Probe extends RenderSystem2DBase{constructor(engine,entity){super({},engine,entity);}read(camera){return this.computeCameraViewProjection(camera);}}
 for(const mode of ['none','2d','3d','parent']){const world=new World('projection'),entity=new Entity().addComponent(new Camera2D({width:100,height:80}));world.addEntity(entity);if(mode==='2d'||mode==='parent')entity.addComponent(new Transform2D({x:120,y:-70,rotation:.2}));if(mode==='3d')entity.addComponent(new CartesianTransform3D({position:[120,-70,0]}));if(mode==='parent'){const parent=new Entity().addComponent(new Transform2D({x:90,rotation:.3}));world.addEntity(parent);entity.parent=parent;}const camera=entity.getComponent(Camera2D),probe=new Probe({displayWidth:960,displayHeight:640},entity);try{const actual=probe.read(camera),expected=world.frameData.getCamera2D(entity,camera,960,640).viewProjectionMatrix;assert.equal(actual.length,expected.length);for(let i=0;i<actual.length;i++)assert.ok(actual[i]===expected[i],mode+': matrix element '+i);}finally{world.destroy();}}
});
