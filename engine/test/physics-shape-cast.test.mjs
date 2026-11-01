import test from 'node:test';
import assert from 'node:assert/strict';
import {createBox2DPhysics2DBackend} from '../dist/physics/backend.js';
import {Entity,World} from '../dist/ecs.js';
import {Transform2D} from '../dist/components.js';
import {Physics2DBody,Physics2DSystem} from '../dist/physics.js';
const desc={shape:'box',origin:{x:0,y:0},translation:{x:10,y:0},width:1,height:1};
const collider={shape:'box',width:.2,height:10,radius:.5,density:1,friction:.2,restitution:0,isSensor:false,categoryBits:1,maskBits:65535,groupIndex:0};
const create=(w,x=5,y=0,extra={})=>{const h=w.createBody({type:'static',positionX:x,positionY:y,angle:0,fixedRotation:false,linearDamping:0,angularDamping:0,bullet:false,allowSleep:true,...extra});w.setBodyCollider(h,collider);return h;};
const fresh=()=>createBox2DPhysics2DBackend().createWorld({gravityX:0,gravityY:0});
test('real shape casts cover box/circle pairings, true normal and reconstructed nonzero witness',()=>{
 for(const target of ['box','circle'])for(const mover of ['box','circle']){const w=fresh();try{const h=create(w);w.setBodyCollider(h,{...collider,shape:target,radius:1});const hit=w.castShape({...desc,shape:mover,radius:.5});assert.equal(hit.kind,'impact');assert.equal(hit.body,h);assert.ok(Math.abs(hit.fraction-(5-(target==='box'?.1:1)-.5)/10)<.004);assert.ok(hit.normal.x<-.99);assert.ok(hit.point.x>3);assert.equal(Object.isFrozen(hit),true);}finally{w.destroy();}}
});
test('shape cast handles translated coordinates, high speed thin walls and rotation',()=>{
 const w=fresh();try{const h=create(w,105,50);const hit=w.castShape({...desc,origin:{x:100,y:50},translation:{x:1000,y:0}});assert.ok(hit.fraction<.005);assert.ok(hit.point.x>104&&hit.point.x<105);assert.equal(hit.distance,1000*hit.fraction);w.destroyBody(h);const slope=create(w,0,3,{angle:Math.PI/6});w.setBodyCollider(slope,{...collider,width:10,height:.2});const s=w.castShape({...desc,shape:'circle',radius:.5,translation:{x:0,y:6}});assert.equal(s.kind,'impact');assert.ok(Math.abs(s.normal.x-.5)<.02);assert.ok(Math.abs(s.normal.y+Math.sqrt(3)/2)<.02);}finally{w.destroy();}
});
test('initial penetration has no fake point/normal; touching tangent and away do not block',()=>{
 for(const shape of ['box','circle']){const w=fresh();try{const h=create(w,0,0);w.setBodyCollider(h,{...collider,width:10,height:.2});const overlap=w.castShape({...desc,shape,radius:.5,origin:{x:0,y:0}});assert.deepEqual({kind:overlap.kind,fraction:overlap.fraction,distance:overlap.distance,point:overlap.point,normal:overlap.normal},{kind:'overlap',fraction:0,distance:0,point:null,normal:null});const y=.1+.5+.016+(shape==='box'?.016:0)-1e-8;for(const translation of [{x:1,y:0},{x:0,y:1},{x:0,y:0}])assert.equal(w.castShape({...desc,shape,radius:.5,origin:{x:0,y},translation}),null);const hit=w.castShape({...desc,shape,radius:.5,origin:{x:0,y},translation:{x:0,y:-1}});assert.equal(hit.kind,'impact');assert.equal(hit.fraction,0);assert.ok(hit.normal.y>.99);}finally{w.destroy();}}
});
test('sensor/mask/exclusion filtering precedes candidate limit and ties use stable handles',()=>{
 const w=fresh();try{const first=create(w),second=create(w);assert.equal(w.castShape(desc).body,first);assert.equal(w.castShape({...desc,exclude:[first]}).body,second);assert.throws(()=>w.castShape({...desc,maxCandidates:1}),e=>e.code==='E_PHYSICS_QUERY_LIMIT');w.setBodyCollider(first,{...collider,isSensor:true});assert.equal(w.castShape({...desc,maxCandidates:1}).body,second);assert.throws(()=>w.castShape({...desc,maxCandidates:1,includeSensors:true}),e=>e.code==='E_PHYSICS_QUERY_LIMIT');w.setBodyCollider(second,{...collider,categoryBits:2,maskBits:2});assert.equal(w.castShape({...desc,categoryBits:1,maskBits:1}),null);assert.equal(w.castShape({...desc,categoryBits:2,maskBits:2}).body,second);}finally{w.destroy();}
});
test('kinematic relative sweep includes targets entering from outside the original actor bounds',()=>{
 const w=fresh();try{const platform=create(w,10,0,{type:'kinematic'});w.setBodyLinearVelocity(platform,{x:-20,y:0});assert.equal(w.castShape({...desc,translation:{x:0,y:0},durationSeconds:0}),null);const hit=w.castShape({...desc,translation:{x:0,y:0},durationSeconds:.5});assert.equal(hit.body,platform);assert.equal(hit.distance,0);assert.ok(hit.fraction>.9&&hit.fraction<1);assert.ok(hit.normal.x<-.99);assert.ok(Math.abs(hit.point.x-.5)<.04);assert.equal(w.getBodyTransform(platform,{}),true);}finally{w.destroy();}
});
test('invalid shape descriptors reject explicitly, including overflow requests',()=>{
 const w=fresh();try{for(const extra of [{width:0},{height:NaN},{shape:'capsule'},{translation:{x:Infinity,y:0}},{durationSeconds:-1},{maxCandidates:0},{maxCandidates:257},{categoryBits:1.5}])assert.throws(()=>w.castShape({...desc,...extra}),e=>e.code==='E_GAMEPLAY_INVALID_INPUT');}finally{w.destroy();}
});
test('short 45 degree sweep catches the native sigma band before it becomes deep penetration',()=>{
 const w=fresh();try{const h=create(w,0,0,{angle:Math.PI/4});w.setBodyCollider(h,{...collider,width:6,height:.2});const hit=w.castShape({shape:'circle',origin:{x:-.8,y:-1/3},translation:{x:0,y:-1/30},radius:.2});assert.equal(hit.kind,'impact');assert.ok(hit.fraction>=0&&hit.fraction<=1);assert.ok(hit.normal.y>.7);assert.ok(hit.normal.x<-.7);}finally{w.destroy();}
});
test('public system uses render units once and resolves hits/exclusions to original ECS bodies',()=>{
 const world=new World(),p=new Physics2DSystem({gravity:[0,0]}),entity=new Entity().addComponent(new Transform2D({x:500})).addComponent(new Physics2DBody({type:'static',width:20,height:1000}));world.addSystem(p);world.addEntity(entity);world.update(0,0);try{const hit=p.castShape({shape:'box',origin:[0,0],translation:[1000,0],width:100,height:100});assert.equal(hit.entity,entity);assert.equal(hit.body,entity.getComponent(Physics2DBody));assert.ok(hit.distance>430&&hit.distance<450);assert.ok(hit.point[0]>480);assert.equal(p.castShape({shape:'box',origin:[0,0],translation:[1000,0],width:100,height:100,exclude:[hit.body]}),null);}finally{world.destroy();assert.equal(p.resourceSnapshot().bodies,0);}
});
test('legacy custom backends remain optional and do not get a ray or AABB fallback',()=>{
 let calls=0;const p=new Physics2DSystem({backend:{id:'legacy',capabilities:{},createWorld(){return{backendId:'legacy',capabilities:{},castRay(){calls++;},queryAabb(){calls++;},destroy(){}};}}});try{assert.throws(()=>p.castShape({shape:'circle',origin:[0,0],translation:[1,0],radius:1}),e=>e.code==='E_PHYSICS_SHAPE_CAST_UNSUPPORTED');assert.equal(calls,0);}finally{p.destroy();}
});
test('a capability flag alone cannot advertise a missing optional driver implementation',()=>{
 const p=new Physics2DSystem({backend:{id:'incomplete',capabilities:{shapeCast:true},createWorld(){return{backendId:'incomplete',capabilities:{shapeCast:true},destroy(){}};}}});try{assert.equal(p.capabilities.shapeCast,false);assert.throws(()=>p.castShape({...desc,origin:[0,0],translation:[1,0]}),e=>e.code==='E_PHYSICS_SHAPE_CAST_UNSUPPORTED');}finally{p.destroy();}
});
