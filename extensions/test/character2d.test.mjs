import test from 'node:test';
import assert from 'node:assert/strict';
import {Entity,World} from '@haiyue/engine/ecs';
import {Transform2D} from '@haiyue/engine/components';
import {Physics2DBody,Physics2DSystem} from '@haiyue/engine/physics';
import {createCharacter2D} from '@haiyue/extensions/character2d';
import {createBox2DPhysics2DBackend} from '@haiyue/engine/physics/backend';

function fixture(shape='box',position=[0,150]){
 const world=new World('character'),physics=new Physics2DSystem({gravity:[0,0]});world.addSystem(physics);
 const entity=new Entity('character').addComponent(new Transform2D({x:position[0],y:position[1]})).addComponent(new Physics2DBody({type:'kinematic',shape,width:40,height:40,radius:20}));world.addEntity(entity);
 const add=(x,y,width,height,rotation=0,type='static')=>{const e=new Entity('obstacle').addComponent(new Transform2D({x,y,rotation})).addComponent(new Physics2DBody({type,width,height}));world.addEntity(e);return e;};
 let time=0;const tick=(delta=1000/60)=>{time+=delta;world.update(time,delta);};
 return{world,physics,entity,add,tick,close(){world.destroy();}};
}
test('both verified character shapes fall, ground, slide along a floor and detach on an explicit jump',()=>{
 for(const shape of ['box','circle']){const f=fixture(shape),floor=f.add(0,0,2000,20),c=createCharacter2D({physics:f.physics,entity:f.entity});try{c.setVelocity([120,-120]);for(let i=0;i<120;i++)f.tick();assert.equal(c.state.grounded,true);assert.equal(c.state.stuck,false);assert.ok(Math.abs(c.state.position[0]-240)<1e-6);assert.ok(c.state.position[1]>30&&c.state.position[1]<36);assert.equal(c.state.platformEntityId,null);assert.ok(c.state.floorNormal[1]>.99);assert.equal(f.physics.resourceSnapshot().bodies,2);c.setVelocity([0,120]);f.tick();assert.equal(c.state.grounded,false);assert.ok(c.state.velocity[1]>100);c.dispose();c.dispose();assert.equal(f.physics.hasBody(f.entity.getComponent(Physics2DBody)),true);assert.equal(f.world.entities.get(floor.id),floor);}finally{c.dispose();f.close();assert.equal(f.physics.resourceSnapshot().bodies,0);}}
});
test('real high-speed thin-wall collision cannot tunnel and a low wall does not become a floor',()=>{
 for(const shape of ['box','circle']){const f=fixture(shape,[0,100]);f.add(100,100,1,1000);const c=createCharacter2D({physics:f.physics,entity:f.entity});try{c.setVelocity([100000,0]);f.tick();assert.ok(c.state.position[0]<80);assert.ok(c.state.position[0]>70);assert.equal(c.state.onWall,true);assert.equal(c.state.grounded,false);assert.equal(c.state.stuck,false);f.tick();assert.equal(c.state.stuck,false);}finally{c.dispose();f.close();}}
});
test('initial penetration is explicit and never teleports the character out automatically',()=>{
 const f=fixture('box',[0,0]);f.add(0,0,100,100);const c=createCharacter2D({physics:f.physics,entity:f.entity});try{c.setVelocity([100,100]);f.tick();assert.equal(c.state.stuck,true);assert.deepEqual(c.state.position,[0,0]);assert.deepEqual(c.state.velocity,[0,0]);c.teleport([200,200]);assert.deepEqual(c.state.previousPosition,[200,200]);f.tick();assert.equal(c.state.stuck,false);}finally{c.dispose();f.close();}
});
test('invalid options and duplicate/foreign/dynamic ownership fail before changing the borrowed body',()=>{
 const f=fixture();try{
  for(const patch of [{up:[0,0]},{up:[NaN,1]},{maxSlides:0},{maxSlides:17},{floorSnap:-1},{safeMargin:NaN},{maxSlopeAngle:Infinity}])assert.throws(()=>createCharacter2D({physics:f.physics,entity:f.entity,...patch}),e=>e.code==='E_GAMEPLAY_INVALID_INPUT');
  const body=f.entity.getComponent(Physics2DBody);body.type='dynamic';assert.throws(()=>createCharacter2D({physics:f.physics,entity:f.entity}),e=>e.code==='E_CHARACTER_BODY_OWNERSHIP');assert.equal(body.type,'dynamic');body.type='kinematic';
  const c=createCharacter2D({physics:f.physics,entity:f.entity});assert.throws(()=>createCharacter2D({physics:f.physics,entity:f.entity}),e=>e.code==='E_CHARACTER_BODY_OWNERSHIP');c.dispose();const next=createCharacter2D({physics:f.physics,entity:f.entity});next.dispose();
 }finally{f.close();}
});
test('zero custom margin is safe, state is immutable, and no game gravity is added',()=>{
 const f=fixture('box',[0,100]);f.add(100,100,1,1000);const c=createCharacter2D({physics:f.physics,entity:f.entity,safeMargin:0});try{for(let i=0;i<3;i++)f.tick();assert.deepEqual(c.state.position,[0,100]);assert.equal(Object.isFrozen(c.state),true);assert.equal(Object.isFrozen(c.state.position),true);c.setVelocity([10000,0]);for(let i=0;i<4;i++)f.tick();assert.equal(c.state.stuck,false);assert.equal(c.state.onWall,true);}finally{c.dispose();f.close();}
});
test('physics trajectory is identical at 30,60,120,144 Hz when compared at the same real tick',()=>{
 const outcomes=[];
 for(const hz of [30,60,120,144]){const f=fixture(),c=createCharacter2D({physics:f.physics,entity:f.entity});f.add(0,0,2000,20);let result;const off=f.physics.onFixedStep(e=>{if(e.phase==='after'&&e.tick===120)result=c.state;});try{c.setVelocity([120,-120]);for(let i=0;i<1000&&!result;i++)f.tick(1000/hz);assert.ok(result);outcomes.push({position:result.position,velocity:result.velocity,grounded:result.grounded,stuck:result.stuck});}finally{off();c.dispose();f.close();}}
 for(const o of outcomes.slice(1))assert.deepEqual(o,outcomes[0]);
});
test('constant translating platform carries once per tick and ownership/velocity remain borrowed',()=>{
 for(const platformVelocity of [[.3,0],[0,.3],[.3,.2]]){const f=fixture('box',[0,40]),platform=f.add(0,0,400,20,0,'kinematic');f.tick(0);const body=platform.getComponent(Physics2DBody);f.physics.setLinearVelocity(body,...platformVelocity);const c=createCharacter2D({physics:f.physics,entity:f.entity});try{c.setVelocity([0,-30]);for(let i=0;i<30;i++)f.tick();assert.equal(c.state.grounded,true);assert.equal(c.state.platformEntityId,platform.id);const before=c.state.position,platformBefore=[platform.getComponent(Transform2D).x,platform.getComponent(Transform2D).y];c.setVelocity([0,0]);for(let i=0;i<60;i++)f.tick();assert.equal(c.state.stuck,false);assert.equal(c.state.platformEntityId,platform.id);const pt=platform.getComponent(Transform2D);assert.ok(Math.abs(c.state.position[0]-before[0]-(pt.x-platformBefore[0]))<.05);assert.ok(Math.abs(c.state.position[1]-before[1]-(pt.y-platformBefore[1]))<.05);}finally{c.dispose();f.close();}}
});
test('slopes at 30/45 degrees are walkable while 60 degrees cannot generate an uphill climb',()=>{
 for(const degrees of [30,45,60]){const f=fixture('circle',[-80,150]);f.add(0,0,600,20,degrees*Math.PI/180);const c=createCharacter2D({physics:f.physics,entity:f.entity});try{c.setVelocity([0,-200]);for(let i=0;i<90;i++)f.tick();assert.equal(c.state.stuck,false);if(degrees<60){assert.equal(c.state.grounded,true);const before=c.state.position;c.setVelocity([120,-30]);for(let i=0;i<20;i++)f.tick();assert.equal(c.state.grounded,true);assert.ok(c.state.position[0]>before[0]);assert.ok(c.state.position[1]>before[1]);}else{assert.equal(c.state.grounded,false);assert.equal(c.state.onWall,true);}}finally{c.dispose();f.close();}}
});
test('box characters support the same 30/45/60 degree slope policy',()=>{
 for(const degrees of [30,45,60]){const f=fixture('box',[0,150]);f.add(0,0,2000,20,degrees*Math.PI/180);const c=createCharacter2D({physics:f.physics,entity:f.entity});try{c.setVelocity([0,-200]);for(let i=0;i<90;i++)f.tick();assert.equal(c.state.stuck,false);assert.equal(c.state.grounded,degrees<=45);if(degrees===60)assert.equal(c.state.onWall,true);else{const before=c.state.position;c.setVelocity([120,-30]);for(let i=0;i<20;i++)f.tick();assert.ok(c.state.position[0]>before[0]);assert.ok(c.state.position[1]>before[1]);}}finally{c.dispose();f.close();}}
});
test('floor edges and adjacent moving platforms hand ownership over without double carrying',()=>{
 const f=fixture('box',[-60,80]),left=f.add(-100,0,200,20,0,'kinematic'),right=f.add(100,0,200,20,0,'kinematic');f.tick(0);f.physics.setLinearVelocity(left.getComponent(Physics2DBody),.1,0);f.physics.setLinearVelocity(right.getComponent(Physics2DBody),.1,0);const c=createCharacter2D({physics:f.physics,entity:f.entity});
 try{c.setVelocity([0,-120]);for(let i=0;i<40;i++)f.tick();assert.equal(c.state.platformEntityId,left.id);c.setVelocity([120,0]);for(let i=0;i<80;i++)f.tick();assert.equal(c.state.platformEntityId,right.id);assert.equal(c.state.grounded,true);assert.equal(c.state.stuck,false);for(let i=0;i<80;i++)f.tick();assert.equal(c.state.grounded,false);assert.equal(c.state.platformEntityId,null);}finally{c.dispose();f.close();}
});
test('platform carry can be disabled; jump still detaches and a stationary actor can be pushed by an incoming platform',()=>{
 const f=fixture('circle',[0,60]),platform=f.add(0,0,400,20,0,'kinematic');f.tick(0);f.physics.setLinearVelocity(platform.getComponent(Physics2DBody),.3,0);const c=createCharacter2D({physics:f.physics,entity:f.entity,carryPlatformVelocity:false});
 try{c.setVelocity([0,-120]);for(let i=0;i<40;i++)f.tick();const x=c.state.position[0];c.setVelocity([0,0]);for(let i=0;i<30;i++)f.tick();assert.ok(Math.abs(c.state.position[0]-x)<1e-8);c.setVelocity([0,180]);f.tick();assert.equal(c.state.platformEntityId,null);assert.equal(c.state.grounded,false);}finally{c.dispose();f.close();}
 const g=fixture('box',[0,100]);const incoming=g.add(0,0,200,20,0,'kinematic');g.tick(0);g.physics.setLinearVelocity(incoming.getComponent(Physics2DBody),0,1);const held=createCharacter2D({physics:g.physics,entity:g.entity});try{for(let i=0;i<90;i++)g.tick();assert.equal(held.state.stuck,false);assert.ok(held.state.position[1]>180);assert.equal(held.state.platformEntityId,incoming.id);}finally{held.dispose();g.close();}
});
test('pause, long frame and teleport keep readonly interpolation from crossing an old location',()=>{
 const f=fixture(),c=createCharacter2D({physics:f.physics,entity:f.entity});try{c.setVelocity([60,0]);f.tick();f.tick();const last=c.state.position;f.physics.disabled=true;assert.deepEqual(c.state.previousPosition,last);f.tick(10000);f.physics.disabled=false;f.tick(5);assert.deepEqual(c.state.previousPosition,c.state.position);c.teleport([500,300]);assert.deepEqual(c.state.previousPosition,[500,300]);assert.deepEqual(c.state.position,[500,300]);f.tick(10000);assert.ok(c.state.position[0]<=505.001);assert.ok(c.state.previousPosition[0]>=500);const t=f.entity.getComponent(Transform2D);t.x=1000;f.tick(0);assert.deepEqual(c.state.position,[1000,t.y]);assert.deepEqual(c.state.previousPosition,c.state.position);}finally{c.dispose();f.close();}
});
test('removal, replacement, disable and destruction release the controller listener while preserving borrowed owners',()=>{
 for(const operation of ['remove','replace','disable','destroy']){const f=fixture();let listeners=0;const original=f.physics.onFixedStep.bind(f.physics);f.physics.onFixedStep=listener=>{listeners++;const off=original(listener);return()=>{listeners--;off();};};const c=createCharacter2D({physics:f.physics,entity:f.entity});try{f.tick();if(operation==='remove')f.world.remove(f.entity);else if(operation==='replace')f.entity.addComponent(new Physics2DBody({type:'kinematic'}));else if(operation==='disable')f.entity.disabled=true;else f.entity.destroy();f.tick();assert.equal(listeners,0);assert.throws(()=>c.setVelocity([1,0]),e=>e.code==='E_CHARACTER_BODY_OWNERSHIP');c.dispose();assert.equal(listeners,0);}finally{c.dispose();f.close();}}
});
test('disposing restores the original borrowed velocity without overwriting a newer external owner value',()=>{
 for(const external of [false,true]){const f=fixture();f.tick(0);const body=f.entity.getComponent(Physics2DBody);f.physics.setLinearVelocity(body,1.5,.25);const c=createCharacter2D({physics:f.physics,entity:f.entity});try{f.tick();const v={x:0,y:0};f.physics.getLinearVelocity(body,v);assert.deepEqual(v,{x:0,y:0});if(external)f.physics.setLinearVelocity(body,2,3);c.dispose();f.physics.getLinearVelocity(body,v);assert.deepEqual(v,external?{x:2,y:3}:{x:1.5,y:.25});}finally{c.dispose();f.close();}}
});
test('query overflow rejects before committing a partial character move',()=>{
 const f=fixture('box',[0,100]);for(let i=0;i<257;i++)f.add(0,100,100,100);const c=createCharacter2D({physics:f.physics,entity:f.entity});try{c.setVelocity([100,0]);assert.throws(()=>f.tick(),e=>e.code==='E_PHYSICS_QUERY_LIMIT');assert.deepEqual(c.state.position,[0,100]);assert.deepEqual(c.state.previousPosition,[0,100]);assert.equal(f.entity.getComponent(Transform2D).x,0);}finally{c.dispose();f.close();}
});
test('32 characters and 128 obstacles share exactly one real backend world with stable counts after settling',()=>{
 const base=createBox2DPhysics2DBackend();let created=0,destroyed=0;const backend={id:base.id,capabilities:base.capabilities,createWorld(o){created++;const driver=base.createWorld(o),destroy=driver.destroy.bind(driver);driver.destroy=()=>{destroyed++;destroy();};return driver;}};
 const w=new World(),p=new Physics2DSystem({gravity:[0,0],backend}),characters=[];w.addSystem(p);
 for(let i=0;i<128;i++)w.addEntity(new Entity().addComponent(new Transform2D({x:i*200,y:-100})).addComponent(new Physics2DBody({type:'static',width:180,height:20})));
 for(let i=0;i<32;i++){const e=new Entity().addComponent(new Transform2D({x:i*200,y:0})).addComponent(new Physics2DBody({type:'kinematic',width:40,height:40}));w.addEntity(e);const c=createCharacter2D({physics:p,entity:e});c.setVelocity([0,-120]);characters.push(c);}
 try{for(let i=0;i<90;i++)w.update(i*1000/60,1000/60);assert.ok(characters.every(c=>c.state.grounded&&!c.state.stuck));for(const c of characters)c.setVelocity([0,0]);const settled=p.resourceSnapshot();for(let i=90;i<600;i++)w.update(i*1000/60,1000/60);assert.deepEqual(p.resourceSnapshot(),settled);assert.equal(created,1);assert.equal(settled.bodies,160);for(const c of characters)c.dispose();assert.equal(p.resourceSnapshot().bodies,160);}finally{for(const c of characters)c.dispose();w.destroy();assert.equal(destroyed,1);assert.equal(p.resourceSnapshot().bodies,0);}
});
test('zero floor snap preserves contact without attracting an airborne character',()=>{
 const f=fixture('box',[0,60]);f.add(0,0,1000,20);const c=createCharacter2D({physics:f.physics,entity:f.entity,floorSnap:0});try{f.tick();assert.equal(c.state.grounded,false);c.setVelocity([0,-120]);for(let i=0;i<60;i++)f.tick();assert.equal(c.state.grounded,true);const position=c.state.position;c.setVelocity([0,0]);for(let i=0;i<60;i++)f.tick();assert.equal(c.state.grounded,true);assert.deepEqual(c.state.position,position);}finally{c.dispose();f.close();}
});
test('a normalized custom up direction uses the same physical query and detachment rules',()=>{
 const f=fixture('circle',[150,0]);f.add(0,0,20,2000);const c=createCharacter2D({physics:f.physics,entity:f.entity,up:[2,0]});try{c.setVelocity([-120,0]);for(let i=0;i<120;i++)f.tick();assert.equal(c.state.grounded,true);assert.ok(c.state.floorNormal[0]>.99);assert.equal(c.state.stuck,false);c.setVelocity([120,0]);f.tick();assert.equal(c.state.grounded,false);}finally{c.dispose();f.close();}
});
test('foreign worlds and unsupported backends are rejected without creating a controller owner',()=>{
 const f=fixture(),other=new Physics2DSystem({gravity:[0,0]}),world=new World();world.addSystem(other);try{assert.throws(()=>createCharacter2D({physics:other,entity:f.entity}),e=>e.code==='E_CHARACTER_BODY_OWNERSHIP');const unsupported=new Physics2DSystem({backend:{id:'legacy',capabilities:{},createWorld(){return{capabilities:{},backendId:'legacy',destroy(){}};}}});try{assert.throws(()=>createCharacter2D({physics:unsupported,entity:f.entity}),e=>e.code==='E_PHYSICS_SHAPE_CAST_UNSUPPORTED');}finally{unsupported.destroy();}const valid=createCharacter2D({physics:f.physics,entity:f.entity});valid.dispose();}finally{world.destroy();f.close();}
});
