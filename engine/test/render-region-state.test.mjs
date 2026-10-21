import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
// Isolated TypeScript compilation tests private scheduling modules without adding public exports.
const root=fileURLToPath(new URL('../..',import.meta.url));
execFileSync(process.execPath,[fileURLToPath(new URL('../../node_modules/typescript/bin/tsc',import.meta.url)),'--target','ESNext','--module','ESNext','--moduleResolution','bundler','--strict','--noUncheckedIndexedAccess','--exactOptionalPropertyTypes','--skipLibCheck','--types','@webgpu/types','--rootDir','engine/src','--outDir','artifacts/engine-0.2.2/g04/compiled','engine/src/core/RenderRegionState.ts','engine/src/renderer/regions/RegionBounds.ts','engine/src/renderer/regions/RegionCacheBudget.ts'],{cwd:root,stdio:'pipe'});
const {RenderRegionCollection}=await import('../../artifacts/engine-0.2.2/g04/compiled/core/RenderRegionState.js');
const {physicalRegionBounds}=await import('../../artifacts/engine-0.2.2/g04/compiled/renderer/regions/RegionBounds.js');
const {RegionCacheBudget,REGION_CACHE_LIMITS}=await import('../../artifacts/engine-0.2.2/g04/compiled/renderer/regions/RegionCacheBudget.js');
const options=(extra={})=>({id:'tools',bounds:{x:0,y:0,width:320,height:720},updateMode:'demand',clearMode:'on-update',visible:true,...extra});
const setup=extra=>{const collection=new RenderRegionCollection(),handle=collection.create(options(extra)),state=collection.states()[0];return{collection,handle,state}};

test('demand state stays dirty until submission; static reads do not consume an update',()=>{
 const {handle,state}=setup();const first=state.prepare('device1:320x720:1'),again=state.prepare('device1:320x720:1');
 assert.equal(first.clear,true);assert.equal(first.update,true);assert.equal(state.snapshot().contentGeneration,0);assert.equal(state.snapshot().dirty,true);
 assert.equal(state.submitted(first),true);assert.equal(state.submitted(first),false);assert.equal(state.prepare(first.resourceKey),null);assert.equal(state.snapshot().contentGeneration,1);
 handle.invalidate('text');assert.equal(state.snapshot().dirty,true);assert.equal(state.submitted(again),true);assert.equal(state.snapshot().dirty,true);
 const update=state.prepare(first.resourceKey);assert.equal(update.clear,true);state.submitted(update);assert.equal(state.snapshot().dirty,false);
});
test('once waits for visibility and a successful submission; new pulses and invalidations survive old work',()=>{
 const {handle,state}=setup({updateMode:'once',visible:false});assert.equal(state.prepare('d1'),null);assert.equal(state.snapshot().pendingOnce,true);
 handle.setVisible(true);const cancelled=state.prepare('d1');handle.setVisible(false);assert.equal(state.submitted(cancelled),false);
 handle.setVisible(true);const first=state.prepare('d1');handle.requestOnce();state.submitted(first);assert.equal(state.snapshot().pendingOnce,true);
 const next=state.prepare('d1');handle.invalidate('resource ready');state.submitted(next);assert.equal(state.snapshot().pendingOnce,true);
 state.submitted(state.prepare('d1'));assert.equal(state.snapshot().pendingOnce,false);assert.equal(state.prepare('d1'),null);
 handle.setMode('once');assert.equal(state.prepare('d1').update,true);
});
test('resource generations reconstruct valid once content; stale device callbacks cannot validate replacement targets',()=>{
 const {state}=setup({updateMode:'once'});const old=state.prepare('d1');const current=state.prepare('d2');assert.equal(state.submitted(old),false);assert.equal(state.snapshot().pendingOnce,true);
 state.submitted(current);assert.equal(state.prepare('d2'),null);const replacement=state.prepare('d3');assert.equal(replacement.clear,true);assert.equal(replacement.update,true);
 state.submitted(replacement);assert.equal(state.snapshot().initialized,true);assert.equal(state.prepare('d3'),null);
});
test('clear-once and never-after-initialization are independent from continuous production',()=>{
 for(const clearMode of ['once','never-after-initialization']){
  const {state,handle}=setup({updateMode:'continuous',clearMode});const first=state.prepare('d');assert.equal(first.clear,true);state.submitted(first);
  const second=state.prepare('d');assert.equal(second.update,true);assert.equal(second.clear,false);state.submitted(second);
  handle.setVisible(false);assert.equal(state.prepare('d'),null);handle.invalidate('hidden change');handle.setVisible(true);assert.equal(state.prepare('d').clear,false);
 }
});
test('disabled preserves requests, initializes transparent storage without producer work, then wakes on demand',()=>{
 const {state,handle}=setup({updateMode:'disabled'});handle.requestOnce();const init=state.prepare('d');assert.equal(init.update,false);assert.equal(init.clear,true);state.submitted(init);
 assert.equal(state.snapshot().dirty,true);assert.equal(state.snapshot().pendingOnce,true);assert.equal(state.prepare('d'),null);
 handle.setMode('demand');const next=state.prepare('d');assert.equal(next.update,true);state.submitted(next);assert.equal(state.prepare('d'),null);
});
test('view-owned regions capture inputs, reject invalid changes atomically and release handles idempotently',()=>{
 const collection=new RenderRegionCollection(),input=options(),handle=collection.create(input),state=collection.states()[0];input.id='mutated';input.bounds.width=1;
 assert.equal(state.snapshot().bounds.width,320);assert.throws(()=>collection.create(options()),/unique/);
 const old=state.snapshot();assert.throws(()=>handle.setBounds({x:0,y:0,width:-1,height:10}));assert.deepEqual(state.snapshot(),old);
 assert.throws(()=>handle.setMode('sometimes'));assert.throws(()=>handle.setVisible(1));assert.throws(()=>handle.invalidate(''));
 handle.setBounds({x:1,y:2,width:0,height:10});assert.equal(state.prepare('d'),null);
 handle.dispose();handle.dispose();assert.equal(collection.size,0);assert.throws(()=>handle.requestOnce(),/disposed/);
 const next=collection.create(options());collection.dispose();collection.dispose();assert.equal(collection.size,0);assert.throws(()=>next.invalidate('x'),/disposed/);assert.throws(()=>collection.create(options()),/disposed/);
});
test('DPR bounds floor starts, ceil ends, clip once and never change logical input geometry',()=>{
 const logical=Object.freeze({x:1.1,y:2.2,width:10.1,height:20.1});assert.deepEqual(physicalRegionBounds(logical,1.5,100,100),{x:1,y:3,width:16,height:31});
 assert.deepEqual(physicalRegionBounds({x:-2.5,y:9.5,width:10,height:10},2,12,24),{x:0,y:19,width:12,height:5});
 assert.deepEqual(physicalRegionBounds({x:20,y:0,width:10,height:0},2,12,24),{x:12,y:0,width:0,height:0});
 assert.equal(logical.x,1.1);assert.throws(()=>physicalRegionBounds(logical,0,100,100));assert.throws(()=>physicalRegionBounds({...logical,width:Infinity},1,100,100));
});

test('independently rounded backing axes retain their actual pixel scale',()=>{
 const dx=1001/801,dy=677/541,logical={x:-1.25,y:2.5,width:322.25,height:200.75};
 const rect=physicalRegionBounds(logical,dx,1001,677,dy);
 assert.deepEqual(rect,{x:0,y:3,width:Math.ceil(321*dx),height:Math.ceil(203.25*dy)-3});
 assert.throws(()=>physicalRegionBounds(logical,dx,1001,677,NaN));
});
test('color cache limits include replacement overlap and cannot evict visible content to pass a budget',()=>{
 assert.deepEqual(REGION_CACHE_LIMITS,{maxRegions:8,maxRetainedColorBytes:67108864});const budget=new RegionCacheBudget();
 const old=budget.reserve('tools',40*1024*1024);assert.equal(old.accepted,true);assert.equal(budget.reserve('tools',30*1024*1024).reason,'color-bytes');
 assert.equal(budget.snapshot().retainedBytes,40*1024*1024);old.reservation.release();old.reservation.release();
 const entries=Array.from({length:8},(_,i)=>budget.reserve('r'+i,1024));assert.equal(budget.reserve('ninth',1).reason,'region-count');
 const overlap=budget.reserve('r0',1024);assert.equal(overlap.accepted,true);assert.equal(budget.snapshot().retainedRegions,8);assert.equal(budget.snapshot().retainedBytes,9*1024);
 for(const e of entries)e.reservation.release();assert.equal(budget.snapshot().retainedRegions,1);overlap.reservation.release();assert.deepEqual(budget.snapshot(),{retainedBytes:0,retainedRegions:0});
});
