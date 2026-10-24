import test from 'node:test';
import assert from 'node:assert/strict';
import {Entity,World,Transform2D} from '@haiyue/engine';
import {parseAnimation} from '@haiyue/animation-spec';
import {Animation2DRenderSystem,Animation2DComponent,Animation2DSystem} from '../dist/animation.js';
import {createAuditGpuDevice,getAuditGpuDeviceState} from '../../scripts/benchmark/real-renderer-audit-device.mjs';
globalThis.GPUTextureUsage??={TEXTURE_BINDING:4,RENDER_ATTACHMENT:16};
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
function fixture(){const fences=[];const device=createAuditGpuDevice({behaviors:{'queue.onSubmittedWorkDone':()=>{const value=deferred();fences.push(value);return value.promise;}}});
 const renderer=new Animation2DRenderSystem({device,width:64,height:32,format:'rgba8unorm',msaaSamples:1},new Entity('mask camera'));
 const context=()=>{const submits=[],cancels=[];return {device,afterSubmit:cb=>submits.push(cb),afterCancel:cb=>cancels.push(cb),submit(){for(const cb of submits)cb(device.queue);},cancel(){for(const cb of cancels)cb();}};};
 return {device,renderer,fences,context,live:()=>getAuditGpuDeviceState(device).snapshot().resources.texture?.live??0};}
const settle=async()=>{await Promise.resolve();await Promise.resolve();};

test('cancelled unused mask recordings retire immediately and exactly once',async()=>{
 const f=fixture(),context=f.context(),target=f.renderer.getMaskTarget('a',context,1);f.renderer.destroyMaskTarget(target);assert.equal(f.live(),1);context.cancel();context.cancel();context.submit();await settle();assert.equal(f.live(),0);assert.equal(f.fences.length,0);
});
test('submitted masks retain ownership through their actual queue fence',async()=>{
 const f=fixture(),context=f.context(),target=f.renderer.getMaskTarget('a',context,1);context.submit();f.renderer.destroyMaskTarget(target);assert.equal(f.live(),1);assert.equal(f.fences.length,1);f.fences[0].resolve();await settle();assert.equal(f.live(),0);context.cancel();assert.equal(f.live(),0);
});
test('one cancelled encoder cannot release another unsubmitted encoder using the same target',async()=>{
 const f=fixture(),a=f.context(),b=f.context(),target=f.renderer.getMaskTarget('a',a,1);assert.equal(f.renderer.getMaskTarget('a',b,2),target);f.renderer.destroyMaskTarget(target);a.cancel();assert.equal(f.live(),1);assert.equal(f.fences.length,0);b.submit();assert.equal(f.live(),1);f.fences[0].resolve();await settle();assert.equal(f.live(),0);
});
test('resize cancellation releases the old generation after its earlier submitted work',async()=>{
 const f=fixture(),a=f.context(),old=f.renderer.getMaskTarget('a',a,1);a.submit();f.renderer.engine.width=96;const b=f.context(),next=f.renderer.getMaskTarget('a',b,2);assert.notEqual(old,next);assert.equal(f.live(),2);b.cancel();assert.equal(f.live(),2);f.fences[0].resolve();await settle();assert.equal(f.live(),1);f.renderer.destroyMaskTarget(next);assert.equal(f.live(),0);
});
test('retired target batches clean up even when the device queue rejects completion',async()=>{
 const f=fixture(),context=f.context(),a=f.renderer.getMaskTarget('a',context,1),b=f.renderer.getMaskTarget('b',context,1);f.renderer.destroyMaskTarget(a);f.renderer.destroyMaskTarget(b);context.submit();assert.equal(f.fences.length,1);f.fences[0].reject(Error('device lost'));await settle();assert.equal(f.live(),0);
});
test('repeated uses in one recording do not add leases, and closed contexts cannot be recorded again',async()=>{
 const f=fixture(),context=f.context(),target=f.renderer.getMaskTarget('a',context,1);for(let i=0;i<10;i++)f.renderer.getMaskTarget('a',context,1);context.cancel();assert.throws(()=>f.renderer.getMaskTarget('a',context,1),/after submission or cancellation/u);f.renderer.destroyMaskTarget(target);assert.equal(f.live(),0);
});
test('legacy direct recording keeps its submitted queue-fence retirement contract',async()=>{
 const f=fixture(),target=f.renderer.getMaskTarget('a',{device:f.device},1);f.renderer.destroyMaskTarget(target);assert.equal(f.live(),1);f.fences[0].resolve();await settle();assert.equal(f.live(),0);
});

const maskDocument=()=>parseAnimation({format:'haiyue-animation',version:'1.0',canvas:{width:32,height:32,coordinateSystem:'screen-y-down'},duration:1,nodes:[
 {id:'mask',start:.5,duration:.1,components:[{type:'shape2d',shape:'rect',size:[20,20],fill:[1,1,1,1]}]},
 {id:'content',components:[{type:'shape2d',shape:'rect',size:[20,20],fill:[1,0,0,1]}],composite:{kind:'mask',source:'mask',mode:'alpha'}}]});
const catalogues=world=>[...world.entities.values()].map(entity=>entity.getComponent(Symbol.for('AnimationMaskSources'))).filter(Boolean);
test('declared source identity exists before deferred geometry and survives later visibility changes',()=>{
 const world=new World(),system=new Animation2DSystem(),player=new Animation2DComponent(maskDocument(),{autoplay:false});world.addSystem(system);world.addEntity(new Entity().addComponent(new Transform2D()).addComponent(player));
 world.update(0,0);const before=catalogues(world);assert.equal(before.length,1);assert.ok(before[0].keys[0].endsWith(':mask'));
 player.seek(.55);world.update(1,0);assert.equal(catalogues(world)[0],before[0]);player.seek(.9);world.update(2,0);assert.equal(catalogues(world)[0],before[0]);world.destroy();assert.equal(catalogues(world).length,0);
});
test('peer players with equal authored source IDs keep separate catalogues and release independently',()=>{
 const world=new World();world.addSystem(new Animation2DSystem());const a=new Entity().addComponent(new Transform2D()).addComponent(new Animation2DComponent(maskDocument(),{autoplay:false})),b=new Entity().addComponent(new Transform2D()).addComponent(new Animation2DComponent(maskDocument(),{autoplay:false}));world.addEntity(a);world.addEntity(b);world.update(0,0);const values=catalogues(world);assert.equal(values.length,2);assert.notEqual(values[0].keys[0],values[1].keys[0]);world.removeEntity(a);assert.equal(catalogues(world).length,1);world.destroy();assert.equal(catalogues(world).length,0);
});
test('source catalogue clones preserve immutable data without retaining their original owner',()=>{
 const world=new World();world.addSystem(new Animation2DSystem());world.addEntity(new Entity().addComponent(new Transform2D()).addComponent(new Animation2DComponent(maskDocument(),{autoplay:false})));world.update(0,0);
 const original=catalogues(world)[0],copy=original.clone();assert.notEqual(copy,original);assert.notEqual(copy.keys,original.keys);assert.deepEqual(copy.keys,original.keys);assert.ok(Object.isFrozen(copy.keys));assert.equal(copy.usedBy.length,0);world.destroy();assert.equal(copy.destroyed,false);copy.destroy();
});
