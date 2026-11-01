import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {capturePhysicsSequence} from './physics-clock-native.mjs';
import {Entity,World} from '../dist/ecs.js';
import {Physics2DBody,Physics2DSystem,Physics3DSystem} from '../dist/physics.js';
import {Transform2D} from '../dist/components.js';
import {createBox2DPhysics2DBackend} from '../dist/physics/backend.js';

test('real 2D/3D legacy 184-frame step/contact/pose/destroy sequence stays byte-equivalent',async()=>{
 const records=await capturePhysicsSequence();
 // Recorded from both unmodified production backends before G04 extraction.
 assert.equal(createHash('sha256').update(JSON.stringify(records)).digest('hex'),'9d6ec9ed7ffbd7a4391875752ad8393f3c4e1156bed02c8023c1b6a2d0930868');
 assert.ok(records.every(r=>r.frames.some(f=>f.events.length>0)));
});
test('both dimensions reject nonfinite/invalid step settings before allocating any world',()=>{
 for(const Type of [Physics2DSystem,Physics3DSystem])for(const options of [{fixedTimeStep:0},{fixedTimeStep:-1},{fixedTimeStep:NaN},{fixedTimeStep:Infinity},{maxSubSteps:0},{maxSubSteps:-1},{maxSubSteps:NaN},{maxSubSteps:Infinity},{maxSubSteps:1.5}]){
  let worlds=0;const backend={id:'validation',createWorld(){worlds++;throw Error('should not allocate');}};
  assert.throws(()=>new Type({...options,backend}),RangeError);assert.equal(worlds,0);
 }
});
test('fixed-step hooks surround each real step/contact drain and expose updated body positions',()=>{
 const base=createBox2DPhysics2DBackend(),order=[],backend={id:base.id,capabilities:base.capabilities,createWorld(o){const driver=base.createWorld(o);return new Proxy(driver,{get(t,k){const f=Reflect.get(t,k);return typeof f!=='function'?f:(...a)=>{if(k==='step')order.push('step');if(k==='drainContactEvents')order.push('contacts');return f.apply(t,a);};}});}};
 const world=new World(),p=new Physics2DSystem({gravity:[0,0],backend}),transform=new Transform2D(),body=new Physics2DBody({type:'kinematic'}),entity=new Entity().addComponent(transform).addComponent(body);world.addSystem(p);world.addEntity(entity);world.update(0,0);p.setLinearVelocity(body,1,0);
 const seen=[];const off=p.onFixedStep(event=>{assert.ok(Object.isFrozen(event));order.push(event.phase+event.tick);if(event.phase==='after')seen.push(transform.x);});
 try{world.update(34,34);assert.deepEqual(order,['before1','step','contacts','after1','before2','step','contacts','after2']);assert.ok(seen[1]>seen[0]&&seen[0]>0);off();off();assert.throws(()=>p.onFixedStep(null),e=>e.code==='E_GAMEPLAY_INVALID_INPUT');}finally{world.destroy();}
});
test('pause discards only the old fractional remainder and presentation does not rewind on resume',()=>{
 const world=new World(),p=new Physics2DSystem({gravity:[0,0]});world.addSystem(p);let ticks=0;const off=p.onFixedStep(e=>{if(e.phase==='before')ticks++;});
 try{world.update(10,10);assert.ok(p.interpolationAlpha>.59&&p.interpolationAlpha<.61);p.disabled=true;world.update(10000,9990);p.disabled=false;assert.equal(p.interpolationAlpha,1);world.update(10010,10);assert.equal(ticks,0);assert.equal(p.interpolationAlpha,1);world.update(10020,10);assert.equal(ticks,1);assert.ok(p.interpolationAlpha<1);world.update(20020,10000);assert.equal(ticks,6);assert.equal(p.interpolationAlpha,0);off();}finally{world.destroy();}
});
test('invalid frame deltas and mutated step settings leave existing body poses unchanged',()=>{
 const world=new World(),p=new Physics2DSystem(),t=new Transform2D({y:100});world.addSystem(p);world.addEntity(new Entity().addComponent(t).addComponent(new Physics2DBody()));world.update(0,0);
 try{for(const delta of [NaN,Infinity,-Infinity]){assert.throws(()=>world.update(1,delta),RangeError);assert.equal(t.y,100);}p.maxSubSteps=1.5;assert.throws(()=>world.update(2,16),RangeError);assert.equal(t.y,100);}finally{world.destroy();}
});
test('inactive World and engine-recovery time gaps reset the old fractional tail without replay',()=>{
 const world=new World(),p=new Physics2DSystem({gravity:[0,0]});world.addSystem(p);let ticks=0;p.onFixedStep(e=>{if(e.phase==='after')ticks++;});
 try{world.update(10,10);world.disabled=true;world.update(10000,10);world.disabled=false;world.update(10010,10);assert.equal(ticks,0);assert.equal(p.interpolationAlpha,1);world.update(10020,10);assert.equal(ticks,1);world.update(20000,10);assert.equal(ticks,1);assert.equal(p.interpolationAlpha,1);}finally{world.destroy();}
});
