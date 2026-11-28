import test from 'node:test';
import assert from 'node:assert/strict';
import {Entity,World} from '@haiyue/engine/ecs';
import {Transform2D,Camera2D} from '@haiyue/engine/components';
import {Geometry2D} from '@haiyue/engine/geometry';
import {parseAnimation} from '@haiyue/animation-spec';
import {importAnimationSource} from './helpers/private-animation-source.mjs';

const {CoreGeometrySnapshotCache} = await importAnimationSource('animation/production/CoreGeometrySnapshotCache.ts');
const {ProductionCoreCompositionVisual} = await importAnimationSource('animation/production/CoreCompositionVisual.ts');
const {ProductionCoreStateVisualRuntime} = await importAnimationSource('animation/production/ProductionCoreStateVisualRuntime.ts');
const {ProductionCompositionDrawAdapter} = await importAnimationSource('animation/production/CompositionDrawAdapter.ts');
const {ProductionDrawOwner} = await importAnimationSource('animation/layout/production/ProductionDrawOwner.ts');
const {ProductionCoreFrameStage} = await importAnimationSource('animation/production/ProductionCoreFrameStage.ts');
const {AnimationVisual2D} = await importAnimationSource('animation/AnimationVisual2D.ts');
const geometry = () => new Geometry2D(new Float32Array([0,0,10,0,0,10]),new Uint16Array([0,1,2]));

test('geometry cache compares mutable values exactly, retaining independent old snapshots',()=>{
  const cache=new CoreGeometrySnapshotCache(1024),source=geometry(),first=cache.geometry(source);
  assert.notEqual(first,source);assert.notEqual(first.positions,source.positions);assert.notEqual(first.indices,source.indices);
  assert.equal(cache.geometry(source),first);
  source.positions[0]=2;const moved=cache.geometry(source);assert.notEqual(moved,first);assert.equal(first.positions[0],0);
  source.positions=new Float32Array(source.positions);assert.equal(cache.geometry(source),moved);
  source.indices[1]=2;const indexed=cache.geometry(source);assert.notEqual(indexed,moved);assert.equal(moved.indices[1],1);
  source.indices=new Uint32Array(source.indices);const wide=cache.geometry(source);assert.notEqual(wide,indexed);assert.ok(wide.indices instanceof Uint32Array);
  source.topology='triangle-strip';const topology=cache.geometry(source);assert.notEqual(topology,wide);assert.equal(wide.topology,null);
  source.indices=null;assert.equal(cache.geometry(source).indices,null);
  source.positions[0]=-0;const negative=cache.geometry(source);source.positions[0]=0;assert.notEqual(cache.geometry(source),negative);
  cache.clear();assert.deepEqual(cache.stats,{entries:0,bytes:0});
});

test('UV changes retain the earlier immutable UV array and remain separate from geometry',()=>{
  const cache=new CoreGeometrySnapshotCache(1024),source=new Float32Array([0,0,1,0,0,1]);
  const first=cache.uvs(source);assert.equal(cache.uvs(source),first);assert.notEqual(first,source);
  source[0]=.25;const next=cache.uvs(source);assert.notEqual(next,first);assert.equal(first[0],0);assert.equal(next[0],.25);
  assert.equal(cache.stats.entries,1);cache.clear();
});

test('cache byte and entry ceilings evict metadata without changing a retained snapshot',()=>{
  const a=geometry(),b=geometry(),c=geometry(),cache=new CoreGeometrySnapshotCache(84,2);
  const retained=cache.geometry(a);cache.geometry(b);assert.equal(cache.stats.entries,2);cache.geometry(c);
  assert.equal(cache.stats.entries,2);assert.ok(cache.stats.bytes<=84);assert.notEqual(cache.geometry(a),retained);assert.equal(retained.positions[2],10);
  const small=new CoreGeometrySnapshotCache(4);const first=small.geometry(a);assert.notEqual(small.geometry(a),first);assert.deepEqual(small.stats,{entries:0,bytes:0});
  cache.clear();assert.deepEqual(cache.stats,{entries:0,bytes:0});
});

function environment(morph=false) {
  const count=32,nodes=Array.from({length:count},(_,i)=>({id:'n'+i,components:[{type:'shape2d',shape:'rect',size:[10,10],fill:[1,0,0,1]}]}));
  if(morph)nodes[0].components=[{type:'org.haiyue.vector-shape@1',commands:'MLLZ',values:[0,0,10,0,0,10],morph:{times:[0,1],values:[0,0,10,0,0,10,0,0,20,0,0,20],valueSize:6,interpolation:'linear'},fill:{kind:'solid',color:[1,0,0,1]}}];
  const document=parseAnimation({format:'haiyue-animation',version:'1.0',canvas:{width:128,height:128,coordinateSystem:'screen-y-down'},duration:1,nodes,tracks:[],...(morph?{extensionsUsed:['org.haiyue.vector-shape@1']}:{} )});
  const engine={width:128,height:128,displayWidth:128,displayHeight:128,msaaSamples:1,format:'rgba8unorm'},world=new World('snapshot test');
  const camera=new Entity('camera').addComponent(new Camera2D({width:128,height:128,designWidth:128,designHeight:128,viewportMode:'fixed'}));world.addEntity(camera);
  const anchor=new Entity('root').addComponent(new Transform2D());world.addEntity(anchor);
  const channel={id:'color',target:'n1',path:'components.0.paint.fill.color',family:'paint-path',valueKind:'color',valueSize:4,policy:'override'};
  const runtime=new ProductionCoreStateVisualRuntime(anchor,document,[channel]),core=new ProductionCoreCompositionVisual(runtime,world,camera,engine,{maxGeometryBytes:1024*1024},()=>{}),draw=new ProductionDrawOwner(engine),adapter=new ProductionCompositionDrawAdapter(draw,[{id:'core',kind:'core'}]);
  let copies=0;
  for(const entity of world.entities.values()) {const visual=entity.getComponent(AnimationVisual2D);if(!visual)continue;const source=visual.geometry.positions,copy=source.slice.bind(source);source.slice=(...args)=>{copies++;return copy(...args);};}
  const prepare=(sequence,time,color=[1,0,0,1])=>{const source=core.prepare(time,[{channel,value:color}],{sequence,deltaSeconds:0,viewport:[128,128],dpr:1});return adapter.prepare({sequence,time,layouts:{},cores:{core:{revision:source.revision}}},new Map([['core',source]]));};
  return {count,world,camera,engine,core,draw,runtime,prepare,get copies(){return copies;},close(){try{draw.dispose();}finally{try{core.dispose();}finally{runtime.destroy();world.destroy();}}}};
}
const commit=step=>{step.commit();step.finalize?.();};

test('sparse paint changes make no new position copies while each draw generation retains its color',()=>{
  const env=environment();try {
    commit(env.prepare(1,0));const first=env.draw.current.plan,before=env.copies;
    commit(env.prepare(2,0,[0,1,0,1]));assert.equal(env.copies,before);
    const next=env.draw.current.plan;assert.equal(next.visuals[1].geometry,first.visuals[1].geometry);assert.deepEqual(first.visuals[1].color,[1,0,0,1]);assert.deepEqual(next.visuals[1].color,[0,1,0,1]);
    const cache=env.core.geometrySnapshots;env.core.dispose();assert.deepEqual(cache.stats,{entries:0,bytes:0});
  }finally{env.close();}
});

test('a real authored morph copies changed geometry and cannot mutate a pending or rolled-back plan',()=>{
  const env=environment(true);try {
    commit(env.prepare(1,0));const first=env.draw.current.plan,original=[...first.visuals[0].geometry.positions];
    const pending=env.prepare(2,.5);const candidate=env.draw.pending.plan,atHalf=[...candidate.visuals[0].geometry.positions];assert.notDeepEqual(atHalf,original);assert.deepEqual([...first.visuals[0].geometry.positions],original);
    // The core can prepare another CPU pose while a draw generation is still held by its transaction.
    env.runtime.applyAuthoredMixedChannels([],1);env.core.geometrySnapshots.geometry([...env.world.entities.values()].map(e=>e.getComponent(AnimationVisual2D)).find(v=>v?.nodeId==='n0').geometry);
    assert.deepEqual([...candidate.visuals[0].geometry.positions],atHalf);pending.rollback();
    commit(env.prepare(3,0));assert.deepEqual([...env.draw.current.plan.visuals[0].geometry.positions],original);assert.deepEqual([...first.visuals[0].geometry.positions],original);
  }finally{env.close();}
});

test('composition reuse preserves topology changes instead of restoring the old geometry',()=>{
  const env=environment();try{
    commit(env.prepare(1,0));const first=env.draw.current.plan,source=[...env.world.entities.values()].map(e=>e.getComponent(AnimationVisual2D)).find(v=>v?.nodeId==='n0');
    source.geometry.topology='line-list';source.geometry.markDirty();commit(env.prepare(2,0));
    const next=env.draw.current.plan;assert.equal(next.visuals[0].geometry.topology,'line-list');assert.equal(first.visuals[0].geometry.topology,null);assert.notEqual(next.visuals[0].geometry,first.visuals[0].geometry);
  }finally{env.close();}
});

test('compiled UV snapshots cannot be changed by later edits or a rolled-back generation',()=>{
  const env=environment();try{
    const source=[...env.world.entities.values()].map(e=>e.getComponent(AnimationVisual2D)).find(v=>v?.nodeId==='n0');
    source.uvs=new Float32Array(source.geometry.positions.length);commit(env.prepare(1,0));const first=env.draw.current.plan;
    source.uvs[0]=.25;source.revision++;const pending=env.prepare(2,0),candidate=env.draw.pending.plan;assert.equal(candidate.visuals[0].uvs[0],.25);assert.equal(first.visuals[0].uvs[0],0);
    source.uvs[0]=.5;env.core.geometrySnapshots.uvs(source.uvs);assert.equal(candidate.visuals[0].uvs[0],.25);pending.rollback();
    source.revision++;commit(env.prepare(3,0));assert.equal(env.draw.current.plan.visuals[0].uvs[0],.5);assert.equal(first.visuals[0].uvs[0],0);
  }finally{env.close();}
});

test('standalone core frame stage clears its own cache on disposal',()=>{
  const env=environment(),stage=new ProductionCoreFrameStage('core',env.runtime,env.world,env.camera,env.engine,env.draw,{maxGeometryBytes:1024*1024,stateStages:[],time:()=>0});
  try{
    commit(stage.prepare({request:{sequence:1,deltaSeconds:0,viewport:[128,128],dpr:1},values:new Map()}));assert.ok(stage.geometrySnapshots.stats.entries>0);stage.dispose();assert.deepEqual(stage.geometrySnapshots.stats,{entries:0,bytes:0});
  }finally{stage.dispose();env.close();}
});
