import {Entity,World} from '../dist/ecs.js';
import {Transform2D,CartesianTransform3D} from '../dist/components.js';
import {Physics2DBody,Physics2DSystem,Physics3DBody,Physics3DSystem} from '../dist/physics.js';
import {createBox2DPhysics2DBackend,createRapierPhysics3DBackend} from '../dist/physics/backend.js';

export async function capturePhysicsSequence(){
const records=[];
for(const dimension of [2,3]){
 const log=[],base=dimension===2?createBox2DPhysics2DBackend():await createRapierPhysics3DBackend();
 const backend={...base,id:base.id,capabilities:base.capabilities,createWorld(options){const driver=base.createWorld(options);return new Proxy(driver,{get(target,key){const value=Reflect.get(target,key);if(typeof value!=='function')return value;return(...args)=>{if(key==='step')log.push(['step',...args]);if(key==='drainContactEvents')log.push(['contacts']);return value.apply(target,args);};}});}};
 const world=new World('legacy'),physics=dimension===2?new Physics2DSystem({backend}):new Physics3DSystem({backend});world.addSystem(physics);
 const T=dimension===2?Transform2D:CartesianTransform3D,B=dimension===2?Physics2DBody:Physics3DBody;
 const floor=new Entity('floor').addComponent(new T(dimension===2?{x:0,y:-10}:{position:[0,-.1,0]})).addComponent(new B({type:'static',width:dimension===2?1000:10,height:dimension===2?20:.2,depth:10}));
 const transform=new T(dimension===2?{x:0,y:60}:{position:[0,.6,0]});const actor=new Entity('actor').addComponent(transform).addComponent(new B({type:'dynamic',width:dimension===2?50:.5,height:dimension===2?50:.5,depth:.5,restitution:0}));world.addEntity(floor);world.addEntity(actor);
 const frames=[],deltas=[0,8,8,2,-5,17,500,0,16.666666666666668,...Array(80).fill(1000/60),1,1,1];let time=0;
 for(const delta of deltas){const start=log.length;time+=Math.max(0,delta);world.update(time,delta);frames.push({delta,trace:log.slice(start),position:dimension===2?[transform.x,transform.y]:Array.from(transform.position),events:physics.events().map(e=>({tick:e.tick,phase:e.phase,kind:e.kind,entityA:e.entityA.name,entityB:e.entityB.name}))});}
 world.destroy();records.push({dimension,frames,afterDestroy:physics.resourceSnapshot()});
}
return records;
}
