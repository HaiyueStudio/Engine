import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {loadResponsiveLayoutModules,responsiveLayoutFixture} from './responsive-layout-fixture.mjs';
const {runtime:{LayoutAssetOwner},spec}=await loadResponsiveLayoutModules();
const document=()=>spec.parseResponsiveLayoutDocument(responsiveLayoutFixture());
const embedded=data=>({kind:'embedded',data,integrity:'sha256-'+createHash('sha256').update(Uint8Array.from(data)).digest('base64')});
const pending=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const host=()=>{const values=[];return {values,async materialize(asset,bytes,device){const value={id:asset.id,device,bytes:[...bytes],destroyed:0,destroy(){this.destroyed++;}};values.push(value);return value;}};};
const aborted=error=>error.code==='E_LAYOUT_ASSET_ABORTED';

test('aborting the last pending asset acquisition reaches its original network resolver',async()=>{
 const doc=document(),started=pending();let resolverSignal;
 const owner=new LayoutAssetOwner(doc,{policy:{mode:'same-origin',baseUrl:'https://fixture.invalid/'},resolver:{resolve(_uri,signal){resolverSignal=signal;started.resolve();return new Promise((_yes,no)=>signal.addEventListener('abort',()=>no(Error('network cancelled')),{once:true}));}}});
 try{const controller=new AbortController(),load=owner.load('remote',{signal:controller.signal}),rejection=assert.rejects(load,aborted);await started.promise;controller.abort();await rejection;assert.equal(resolverSignal.aborted,true);assert.equal(owner.stats.entries,0);assert.equal(owner.stats.references,0);assert.equal(owner.stats.totalBytes,0);}finally{owner.dispose();}
});
test('cancelling one pending borrower does not abort another borrower of the same original asset',async()=>{
 const wait=pending(),started=pending();let resolverSignal;
 const owner=new LayoutAssetOwner(document(),{policy:{mode:'same-origin',baseUrl:'https://fixture.invalid/'},resolver:{async resolve(_uri,signal){resolverSignal=signal;started.resolve();await wait.promise;return new Uint8Array([1,2,3]);}}});
 try{const controller=new AbortController(),a=owner.load('remote',{signal:controller.signal}),b=owner.load('remote');await started.promise;const rejected=assert.rejects(a,aborted);controller.abort();await rejected;assert.equal(resolverSignal.aborted,false);assert.equal(owner.stats.references,1);wait.resolve();const handle=await b;assert.deepEqual([...handle.bytes],[1,2,3]);assert.equal(owner.stats.references,1);handle.release();assert.equal(owner.stats.references,0);}finally{wait.resolve();owner.dispose();}
});
test('pre-aborted loads start no work and abort after fulfillment does not revoke an acquired lease',async()=>{
 const owner=new LayoutAssetOwner(document(),{policy:{mode:'deny'}});
 try{const before=new AbortController();before.abort();await assert.rejects(owner.load('image',{signal:before.signal}),aborted);assert.equal(owner.stats.generation,0);const after=new AbortController(),handle=await owner.load('image',{signal:after.signal});after.abort();assert.equal(owner.stats.references,1);assert.deepEqual([...handle.bytes],[1,2,3]);handle.release();handle.release();assert.equal(owner.stats.references,0);}finally{owner.dispose();}
});
test('late cancelled network bytes do not start WebCrypto hashing or materialization',async()=>{
 const wait=pending(),started=pending(),subtle=globalThis.crypto.subtle,original=subtle.digest;let hashes=0;
 subtle.digest=function(...args){hashes++;return Reflect.apply(original,this,args);};
 const materializer=host(),owner=new LayoutAssetOwner(document(),{policy:{mode:'same-origin',baseUrl:'https://fixture.invalid/'},materializer,resolver:{async resolve(){started.resolve();await wait.promise;return new Uint8Array([1,2,3]);}}});
 try{const controller=new AbortController(),load=owner.load('remote',{signal:controller.signal});await started.promise;const rejected=assert.rejects(load,aborted);controller.abort();await rejected;wait.resolve();for(let i=0;i<20;i++)await Promise.resolve();assert.equal(hashes,0);assert.equal(materializer.values.length,0);assert.equal(owner.stats.cacheEntries,0);}finally{subtle.digest=original;wait.resolve();owner.dispose();}
});

test('replaced generations remain alive until all original handles release',async()=>{
 const materializer=host(),owner=new LayoutAssetOwner(document(),{policy:{mode:'deny'},materializer});
 try{
  const a=await owner.load('image'),peer=await owner.load('image'),old=a.materialized;
  owner.replace('image',embedded([4,5,6]));assert.equal(old.destroyed,0,'a rendered frame still owns the old texture');
  const b=await owner.load('image');assert.notEqual(a.generation,b.generation);assert.deepEqual([...a.bytes],[1,2,3]);assert.deepEqual([...b.bytes],[4,5,6]);
  a.release();a.release();assert.equal(old.destroyed,0);peer.release();assert.equal(old.destroyed,1);assert.equal(b.materialized.destroyed,0);
  b.release();assert.equal(materializer.values[1].destroyed,1);assert.equal(owner.stats.references,0);
 }finally{owner.dispose();}
});

test('hosted replacement preserves existing handles and distinct generations',async()=>{
 const materializer=host(),owner=new LayoutAssetOwner(document(),{policy:{mode:'deny'},materializer});
 try{
  const a=await owner.load('hosted'),old=a.materialized;owner.setHostedReplacement('hero',embedded([7]));
  const b=await owner.load('hosted');assert.equal(old.destroyed,0);assert.notEqual(a.generation,b.generation);
  a.release();assert.equal(old.destroyed,1);b.release();
 }finally{owner.dispose();}
});

test('existing handles observe recovered materializations and old retained generations recover too',async()=>{
 const materializer=host(),owner=new LayoutAssetOwner(document(),{policy:{mode:'deny'},materializer,device:{id:1}});
 try{
  const old=await owner.load('image');owner.replace('image',embedded([4]));const current=await owner.load('image');
  owner.notifyDeviceLost();assert.equal(old.materialized,undefined);assert.equal(current.materialized,undefined);
  const device={id:2};await owner.recoverDevice(device);assert.equal(old.materialized.device,device);assert.equal(current.materialized.device,device);
  assert.deepEqual(old.materialized.bytes,[1,2,3]);assert.deepEqual(current.materialized.bytes,[4]);old.release();current.release();
  assert.ok(materializer.values.every(value=>value.destroyed===1));
 }finally{owner.dispose();}
});

test('late materialization from a lost device is destroyed and never published',async()=>{
 const wait=pending(),created=pending(),value={destroyed:0,destroy(){this.destroyed++;}};
 const owner=new LayoutAssetOwner(document(),{policy:{mode:'deny'},materializer:{async materialize(){created.resolve();await wait.promise;return value;}}});
 try{
  const load=owner.load('image');await created.promise;owner.notifyDeviceLost();const rejection=assert.rejects(load,aborted);wait.resolve();await rejection;
  assert.equal(value.destroyed,1);assert.equal(owner.stats.entries,0);
 }finally{owner.dispose();}
});

test('releasing during device recovery cannot resurrect an unreferenced generation',async()=>{
 const wait=pending(),started=pending();let calls=0;const values=[];
 const materializer={async materialize(){const value={destroyed:0,destroy(){this.destroyed++;}};values.push(value);if(++calls===2){started.resolve();await wait.promise;}return value;}};
 const owner=new LayoutAssetOwner(document(),{policy:{mode:'deny'},materializer});
 try{
  const handle=await owner.load('image'),recovery=owner.recoverDevice({});await started.promise;handle.release();wait.resolve();await recovery;
  assert.equal(values[1].destroyed,1);assert.equal(owner.stats.entries,0);assert.equal(owner.stats.references,0);
 }finally{owner.dispose();}
});

test('simultaneous equal integrity loads deduplicate bytes under the original total ceiling',async()=>{
 const owner=new LayoutAssetOwner(document(),{policy:{mode:'deny'},maxAssetBytes:3,maxTotalBytes:3});
 try{const values=await Promise.all([owner.load('image'),owner.load('copy')]);assert.equal(owner.stats.totalBytes,3);assert.equal(owner.stats.cacheEntries,1);values.forEach(value=>value.release());}finally{owner.dispose();}
});

test('concurrent distinct loads cannot both reserve the last bytes',async()=>{
 const owner=new LayoutAssetOwner(document(),{policy:{mode:'deny'},maxAssetBytes:3,maxTotalBytes:3});
 try{owner.replace('copy',embedded([4,5,6]));const values=await Promise.allSettled([owner.load('image'),owner.load('copy')]);assert.equal(values.filter(value=>value.status==='fulfilled').length,1);assert.equal(values.find(value=>value.status==='rejected').reason.code,'E_LAYOUT_ASSET_LIMIT');assert.equal(owner.stats.totalBytes,3);for(const value of values)if(value.status==='fulfilled')value.value.release();}finally{owner.dispose();}
});

test('mutable replacement sources are snapshotted before asynchronous integrity work',async()=>{
 const owner=new LayoutAssetOwner(document(),{policy:{mode:'deny'}});
 try{const source=embedded([1,2,3]);owner.replace('copy',source);source.data[0]=9;source.integrity=embedded([9,2,3]).integrity;const handle=await owner.load('copy');assert.deepEqual([...handle.bytes],[1,2,3]);handle.release();}finally{owner.dispose();}
});

test('fallback dependents use a new generation without invalidating held resources',async()=>{
 const materializer=host(),owner=new LayoutAssetOwner(document(),{policy:{mode:'deny'},materializer});
 try{const old=await owner.load('hosted');owner.replace('image',embedded([8,9]));const next=await owner.load('hosted');assert.deepEqual([...next.bytes],[8,9]);assert.equal(old.materialized.destroyed,0);assert.notEqual(old.generation,next.generation);old.release();next.release();}finally{owner.dispose();}
});

test('overlapping recoveries publish only the newest device and clean every staged resource',async()=>{
 const wait=pending(),started=pending(),values=[];let calls=0;
 const materializer={async materialize(_asset,_bytes,device){const value={device,destroyed:0,destroy(){this.destroyed++;}};values.push(value);if(++calls===2){started.resolve();await wait.promise;}return value;}};
 const owner=new LayoutAssetOwner(document(),{policy:{mode:'deny'},materializer,device:{id:0}});
 try{const handle=await owner.load('image');const first=owner.recoverDevice({id:1});await started.promise;const rejection=assert.rejects(first,aborted);const device={id:2};await owner.recoverDevice(device);wait.resolve();await rejection;assert.equal(handle.materialized.device,device);assert.equal(values[1].destroyed,1);assert.equal(owner.stats.lost,false);handle.release();assert.ok(values.every(value=>value.destroyed===1));}finally{owner.dispose();}
});

test('disposal during recovery destroys its late return without resurrecting handles',async()=>{
 const wait=pending(),started=pending(),values=[];let calls=0;
 const materializer={async materialize(){const value={destroyed:0,destroy(){this.destroyed++;}};values.push(value);if(++calls===2){started.resolve();await wait.promise;}return value;}};
 const owner=new LayoutAssetOwner(document(),{policy:{mode:'deny'},materializer}),handle=await owner.load('image');
 const recovery=owner.recoverDevice({});await started.promise;const rejection=assert.rejects(recovery,aborted);owner.dispose();wait.resolve();await rejection;assert.equal(handle.materialized,undefined);handle.release();assert.equal(owner.stats.references,0);assert.ok(values.every(value=>value.destroyed===1));
});

test('a failing recovery publishes no partial resources and may be retried',async()=>{
 const values=[];let fail=false;
 const materializer={async materialize(asset){if(fail&&asset.id==='copy')throw new Error('host decode failed');const value={destroyed:0,destroy(){this.destroyed++;}};values.push(value);return value;}};
 const owner=new LayoutAssetOwner(document(),{policy:{mode:'deny'},materializer});
 try{const a=await owner.load('image'),b=await owner.load('copy');fail=true;await assert.rejects(owner.recoverDevice({}),/host decode failed/u);assert.equal(a.materialized,undefined);assert.equal(b.materialized,undefined);assert.equal(owner.stats.lost,true);assert.ok(values.every(value=>value.destroyed===1));fail=false;await owner.recoverDevice({});assert.ok(a.materialized&&b.materialized);a.release();b.release();}finally{owner.dispose();}
});

test('host and handle byte mutations cannot corrupt the verified cache',async()=>{
 const materializer={async materialize(_asset,bytes){bytes[0]=9;return {destroy(){}};}},owner=new LayoutAssetOwner(document(),{policy:{mode:'deny'},materializer});
 try{const a=await owner.load('image');assert.deepEqual([...a.bytes],[1,2,3]);a.bytes[0]=8;const b=await owner.load('copy');assert.deepEqual([...b.bytes],[1,2,3]);a.release();b.release();}finally{owner.dispose();}
});

test('invalid replacement metadata is rejected before retiring the current generation or invoking getters',async()=>{
 const owner=new LayoutAssetOwner(document(),{policy:{mode:'deny'}});let accesses=0;
 try{const a=await owner.load('image'),source={kind:'embedded',integrity:embedded([1]).integrity,get data(){accesses++;return [1];}};assert.throws(()=>owner.replace('image',source));const b=await owner.load('image');assert.equal(a.generation,b.generation);assert.equal(accesses,0);
  const data={get length(){accesses++;return 1;},0:1};assert.throws(()=>owner.replace('image',{kind:'embedded',data,integrity:embedded([1]).integrity}));assert.equal(accesses,0);a.release();b.release();}finally{owner.dispose();}
});

test('replacing a pending generation aborts it without poisoning its replacement',async()=>{
 const wait=pending(),owner=new LayoutAssetOwner(document(),{policy:{mode:'same-origin',baseUrl:'https://example.test/'},resolver:{resolve:()=>wait.promise}});
 try{const old=owner.load('remote'),rejection=assert.rejects(old,aborted);owner.replace('remote',embedded([4]));const next=await owner.load('remote');wait.resolve(Uint8Array.from([1,2,3]));await rejection;assert.deepEqual([...next.bytes],[4]);next.release();}finally{owner.dispose();}
});

test('cleanup failure releases all owners once and still clears retained accounting',async()=>{
 const values=[],owner=new LayoutAssetOwner(document(),{policy:{mode:'deny'},materializer:{async materialize(){const value={destroyed:0,destroy(){this.destroyed++;throw new Error('cleanup failed');}};values.push(value);return value;}}});
 const a=await owner.load('image'),b=await owner.load('copy');assert.throws(()=>owner.dispose(),AggregateError);assert.equal(owner.stats.references,0);assert.equal(owner.stats.totalBytes,0);owner.dispose();a.release();b.release();assert.ok(values.every(value=>value.destroyed===1));
});

test('hex and base64 integrity share one content reservation; lower per-load ceilings stay lazy',async()=>{
 const owner=new LayoutAssetOwner(document(),{policy:{mode:'deny'},maxAssetBytes:3,maxTotalBytes:3});
 try{const a=await owner.load('image');owner.replace('copy',{kind:'embedded',data:[1,2,3],integrity:'sha256-'+createHash('sha256').update(Uint8Array.from([1,2,3])).digest('hex')});const b=await owner.load('copy');assert.equal(owner.stats.totalBytes,3);a.release();b.release();}finally{owner.dispose();}
 const small=new LayoutAssetOwner(document(),{policy:{mode:'deny'},maxAssetBytes:2});try{await assert.rejects(small.load('image'),error=>error.code==='E_LAYOUT_ASSET_LIMIT');}finally{small.dispose();}
});
