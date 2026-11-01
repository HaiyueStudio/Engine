import test from 'node:test';
import assert from 'node:assert/strict';
import { AssetManager, AssetOwnerScope } from '@haiyue/engine/assets';
import { createMockGpuDevice } from './helpers.mjs';
import { setImmediate as tick } from 'node:timers/promises';
const deferred=()=>{let resolve;return{promise:new Promise(r=>resolve=r),resolve:value=>resolve(value)};};

test('last-owner abort evicts immediately; a same-key retry cannot inherit or be deleted by the retired record',async()=>{
 const manager=new AssetManager(createMockGpuDevice()),job=deferred(),controller=new AbortController(),disposed=[];let abortReason;
 try{
  const old=manager.load('repeat',signal=>{signal.addEventListener('abort',()=>abortReason=signal.reason,{once:true});return job.promise;},v=>disposed.push(v),{signal:controller.signal});old.catch(()=>{});controller.abort();await assert.rejects(old);assert.equal(manager.size,0);assert.equal(abortReason,'owner-released');
  const current=await manager.load('repeat',async()=>2,v=>disposed.push(v));assert.equal(current.value,2);assert.equal(manager.getRefCount('repeat'),1);
  job.resolve(1);await tick();assert.deepEqual(disposed,[1]);assert.equal(current.value,2);assert.equal(manager.getRefCount('repeat'),1);current.release();assert.equal(manager.size,0);assert.deepEqual(disposed,[1,2]);
 }finally{manager.dispose();}
});

test('a pre-aborted owner cannot create an asset job or invoke a loader',async()=>{
 const manager=new AssetManager(createMockGpuDevice()),owner=new AssetOwnerScope('closed');let loads=0;owner.abort();
 try{await assert.rejects(manager.load('closed',async()=>{loads++;return 1;},()=>{},{owner}));assert.equal(loads,0);assert.equal(manager.size,0);}finally{manager.dispose();}
});

test('abort after request-listener cleanup but before handle delivery releases only that request',async()=>{
 const manager=new AssetManager(createMockGpuDevice()),job=deferred(),firstOwner=new AbortController();
 try{
  // Inject a genuine abort exactly at the DOM listener-cleanup boundary. An
  // already-resolved wait must still not hand a cancelled request a live handle.
  const remove=firstOwner.signal.removeEventListener.bind(firstOwner.signal);
  firstOwner.signal.removeEventListener=(...args)=>{remove(...args);if(args[0]==='abort')firstOwner.abort('delivery-boundary');};
  const second=manager.load('shared',()=>job.promise,()=>{});
  const first=manager.load('shared',()=>job.promise,()=>{},{signal:firstOwner.signal});first.catch(()=>{});
  job.resolve(1);await assert.rejects(first);const retained=await second;assert.equal(retained.value,1);assert.equal(manager.getRefCount('shared'),1);retained.release();assert.equal(manager.size,0);
 }finally{manager.dispose();}
});

test('a handle from a deleted record cannot delete a later same-key record',async()=>{
 const manager=new AssetManager(createMockGpuDevice());
 try{const old=await manager.load('replace',async()=>1,()=>{});manager.deleteAsset('replace');const next=await manager.load('replace',async()=>2,()=>{});old.release();assert.equal(manager.hasAsset('replace'),true);assert.equal(next.value,2);next.release();assert.equal(manager.size,0);}finally{manager.dispose();}
});
