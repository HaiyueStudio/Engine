import test from 'node:test';
import assert from 'node:assert/strict';
import {loadResponsiveLayoutModules} from './responsive-layout-fixture.mjs';
const modules = await loadResponsiveLayoutModules();
const {ProductionResourceStage, ProductionResourcePending, ProductionFrameTransaction} = modules.frameProduction;
const {LayoutAssetOwner} = modules.runtime;
import {createHash} from 'node:crypto';
const select = id => [{slot: 'hero', id}];
const request = sequence => ({sequence, deltaSeconds: 0, viewport: [64, 64], dpr: 1});
function pending(fn) {try {fn();assert.fail('expected pending resource');} catch (error) {assert.ok(error instanceof ProductionResourcePending, String(error));return error.ready;}}
const port = releases => ({async acquire(_kind,id) {return {value:id,release(){releases.push(id)}};}});
const slots = [{slot:'hero',kind:'image'}];

test('candidate readiness invalidates, stays private until preparation and retires only on publication',async()=>{
 const released=[];let invalidations=0;const owner=new ProductionResourceStage(slots,port(released),()=>invalidations++);
 try {
  await pending(()=>owner.prepare(select('old')));assert.equal(owner.selection('hero'),undefined);assert.equal(invalidations,1);
  const initial=owner.prepare(select('old'));assert.equal(owner.selection('hero'),'old');initial.commit();initial.publish();
  await pending(()=>owner.prepare(select('new')));assert.equal(owner.selection('hero'),'old');
  const candidate=owner.prepare(select('new'));assert.equal(owner.selection('hero'),'new');candidate.rollback();assert.equal(owner.selection('hero'),'old');assert.deepEqual(released,[]);
  const committed=owner.prepare(select('new'));committed.commit();assert.equal(owner.selection('hero'),'new');assert.deepEqual(released,[]);committed.publish();committed.publish();assert.deepEqual(released,['old']);
  const stable=owner.prepare(select('new'));stable.commit();stable.publish();assert.equal(owner.stats.generation,2);
 } finally {owner.dispose();}assert.deepEqual(released,['old','new']);assert.equal(owner.stats.handles,0);
});

test('existing whole-frame transaction rolls resource identities back after later layout failure',async()=>{
 const released=[],owner=new ProductionResourceStage(slots,port(released),()=>{});let fail=false,publications=0;
 const frame=new ProductionFrameTransaction([{id:'resources',phase:'state-timeline',prepare(){return owner.prepare(select(fail?'new':'old'))},dispose(){owner.dispose()}},{id:'layout',phase:'text-layout',prepare(){assert.equal(owner.selection('hero'),fail?'new':'old');if(fail)throw Error('layout failed');return{commit(){},rollback(){},publish(){publications++}}}}]);
 try {
  await pending(()=>frame.advance(request(1)));frame.advance(request(1));assert.equal(publications,1);
  fail=true;await pending(()=>frame.advance(request(2)));assert.throws(()=>frame.advance(request(2)),/layout failed/);assert.equal(owner.selection('hero'),'old');assert.equal(publications,1);assert.deepEqual(released,[]);
  fail=false;frame.advance(request(3));assert.equal(owner.selection('hero'),'old');assert.deepEqual(released,['new']);
 }finally{frame.dispose();}assert.deepEqual(released,['new','old']);
});

test('superseded async slots abort and release a late handle without invalidating the newer selection',async()=>{
 const waits=new Map(),released=[];let invalidations=0;const owner=new ProductionResourceStage(slots,{acquire(_kind,id,signal){return new Promise(resolve=>waits.set(id,{resolve,signal}))}},()=>invalidations++);
 const first=pending(()=>owner.prepare(select('first'))),second=pending(()=>owner.prepare(select('second')));
 assert.equal(waits.get('first').signal.aborted,true);waits.get('first').resolve({get value(){throw Error('late opaque value read')},release(){released.push('first')}});
 await assert.rejects(first);assert.equal(invalidations,0);waits.get('second').resolve({value:'second',release(){released.push('second')}});await second;assert.equal(invalidations,1);
 const step=owner.prepare(select('second'));step.commit();step.publish();assert.equal(owner.selection('hero'),'second');owner.dispose();assert.deepEqual(released,['first','second']);
});

test('dispose cancels jobs and prevents a prepared step from resurrecting slot identities',async()=>{
 const released=[],owner=new ProductionResourceStage(slots,port(released),()=>{});await pending(()=>owner.prepare(select('image')));const step=owner.prepare(select('image'));owner.dispose();step.commit();step.rollback();step.publish();assert.equal(owner.stats.handles,0);assert.equal(owner.stats.disposed,true);assert.throws(()=>owner.selection('hero'),e=>e.code==='E_HYA_RUNTIME_DISPOSED');assert.deepEqual(released,['image']);
});

test('failed acquisition keeps old identity, explicitly retries and never leaks rejected ready state',async()=>{
 const released=[],fault=Error('download failed');let fail=false,calls=0;const owner=new ProductionResourceStage(slots,{async acquire(_kind,id){calls++;if(fail)throw fault;return{value:id,release(){released.push(id)}}}},()=>{});
 try{await pending(()=>owner.prepare(select('old')));let step=owner.prepare(select('old'));step.commit();step.publish();fail=true;await assert.rejects(pending(()=>owner.prepare(select('new'))),e=>e===fault);assert.equal(owner.selection('hero'),'old');assert.equal(owner.stats.failed,1);assert.throws(()=>owner.prepare(select('new')),e=>e===fault);assert.equal(calls,2);fail=false;owner.retryFailed();await pending(()=>owner.prepare(select('new')));step=owner.prepare(select('new'));step.commit();step.publish();assert.equal(owner.selection('hero'),'new');assert.equal(calls,3);}finally{owner.dispose()}assert.deepEqual(released,['old','new']);
});

test('separate slots never alias when their IDs contain path separators',async()=>{
 const released=[],owner=new ProductionResourceStage([{slot:'a/b',kind:'image'},{slot:'a',kind:'font'}],port(released),()=>{}),values=[{slot:'a/b',id:'one'},{slot:'a',id:'two'}];
 await pending(()=>owner.prepare(values));const step=owner.prepare(values);step.commit();step.publish();assert.equal(owner.selection('a/b'),'one');assert.equal(owner.selection('a'),'two');assert.throws(()=>owner.prepare([{slot:'a',id:'one'},{slot:'a',id:'two'}]),e=>e.code==='E_HYA_RUNTIME_REFERENCE');assert.deepEqual(released,[]);owner.dispose();assert.deepEqual(released.sort(),['one','two']);
});

test('original SHA loader verifies candidate bytes before the resource frame can prepare',async()=>{
 const bytes=Uint8Array.from([1,2,3]),integrity='sha256-'+createHash('sha256').update(bytes).digest('base64');let tamper=false,loads=0;
 const assets=new LayoutAssetOwner({assets:[{id:'old',kind:'image',width:1,height:1,source:{kind:'embedded',data:bytes,integrity}},{id:'new',kind:'image',width:2,height:2,source:{kind:'referenced',uri:'/new.png',integrity}}]}, {policy:{mode:'same-origin',baseUrl:'https://fixture.test/'},resolver:{async resolve(){loads++;return tamper?Uint8Array.from([9,9,9]):bytes}}});
 const owner=new ProductionResourceStage(slots,{async acquire(_kind,id,signal){const handle=await assets.load(id,{signal});return{value:handle.bytes,release:handle.release}}},()=>{});
 try{await pending(()=>owner.prepare(select('old')));let step=owner.prepare(select('old'));step.commit();step.publish();
 // Distinct integrity avoids a legitimate content-addressed cache hit for this candidate.
 assets.replace('new',{kind:'referenced',uri:'/new.png',integrity:'sha256-'+createHash('sha256').update(Uint8Array.from([4,5,6])).digest('base64')});tamper=true;
 await assert.rejects(pending(()=>owner.prepare(select('new'))),e=>e.code==='E_LAYOUT_ASSET_INTEGRITY');assert.equal(loads,1);assert.equal(owner.selection('hero'),'old');assert.equal(assets.stats.references,1);assert.equal(owner.stats.failed,1);
 }finally{owner.dispose();assets.dispose()}assert.equal(assets.stats.references,0);assert.equal(assets.stats.totalBytes,0);
});

test('release errors are post-commit publication errors and do not cause a frame replay',async()=>{
 const released=[],fault=Error('old release failed'),owner=new ProductionResourceStage(slots,{async acquire(_kind,id){return {value:id,release(){released.push(id);if(id==='old')throw fault}}}},()=>{});let id='old',notifications=0;const errors=[];
 const frame=new ProductionFrameTransaction([{id:'resources',phase:'state-timeline',prepare(){return owner.prepare(select(id))}},{id:'later',phase:'geometry-draw',prepare(){return{commit(){},rollback(){},publish(){notifications++}}}}],e=>errors.push(e));
 try{await pending(()=>frame.advance(request(1)));frame.advance(request(1));id='new';await pending(()=>frame.advance(request(2)));const committed=frame.advance(request(2));assert.equal(owner.selection('hero'),'new');assert.equal(errors.length,1);assert.equal(errors[0].errors[0],fault);assert.equal(frame.advance(request(2)),committed);assert.equal(notifications,2);assert.deepEqual(released,['old']);}finally{frame.dispose();owner.dispose()}assert.deepEqual(released,['old','new']);
});

test('failed candidate cleanup cannot leave an unresolvable replacement promise',async()=>{
 const fault=Error('candidate release failed'),released=[],owner=new ProductionResourceStage(slots,{async acquire(_kind,id){return{value:id,release(){released.push(id);if(id==='first')throw fault}}}},()=>{});
 await pending(()=>owner.prepare(select('first')));assert.throws(()=>owner.prepare(select('second')),e=>e===fault);assert.equal(owner.stats.failed,1);assert.equal(owner.stats.pending,0);
 owner.retryFailed();await pending(()=>owner.prepare(select('second')));const step=owner.prepare(select('second'));step.commit();step.publish();owner.dispose();assert.deepEqual(released,['first','second']);
});
