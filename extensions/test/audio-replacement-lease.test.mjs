import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {loadG08Modules} from './audio-event-parity-fixture.mjs';
const {runtime:{AudioAssetOwner}}=await loadG08Modules();
const resource=(n,id='tone')=>{const bytes=Buffer.from([n,n,n,n]);return{id,codec:'wav',mediaType:'audio/wav',integrity:{algorithm:'sha256',digest:createHash('sha256').update(bytes).digest('hex')},sampleRate:48000,channels:1,frameLength:4,source:{kind:'embedded',data:bytes.toString('base64')}};};
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
async function waitFor(check){const end=Date.now()+3000;while(!check()){if(Date.now()>end)throw Error('decode job did not start');await tick();}}
async function setup(){const waiting=[],released=[];const decoder={decode({resource:r}){return new Promise((resolve,reject)=>waiting.push({r,reject,resolve:()=>resolve({sampleRate:48000,channels:1,frameLength:4,payload:r.integrity.digest,release(){released.push(r.integrity.digest);}})}));}};const a=resource(1),b=resource(2),c=resource(3),owner=new AudioAssetOwner([a],decoder,{maxDecodeJobs:4,maxDecodedFrames:100,maxDecodedBytes:1000});const p=owner.load('tone');await waitFor(()=>waiting.length===1);waiting[0].resolve();const handle=await p;return{a,b,c,owner,waiting,released,handle};}
for(const outcome of ['success','failure','release','dispose'])test(`overlapping replacement keeps committed lease through ${outcome}`,async()=>{
 const f=await setup(),b=f.owner.replace(f.b);b.catch(()=>{});await waitFor(()=>f.waiting.length===2);const c=f.owner.replace(f.c);c.catch(()=>{});await waitFor(()=>f.waiting.length===3);
 assert.equal(await f.owner.load('tone'),f.handle,'committed A remains available while C is pending');
 if(outcome==='release')f.owner.releaseResource('tone');if(outcome==='dispose')f.owner.dispose();
 f.waiting[1].resolve();await assert.rejects(b,e=>e.code==='E_AUDIO_RUNTIME_ABORTED');
 if(outcome==='failure'){f.waiting[2].reject(Error('decode failed'));await assert.rejects(c);assert.equal(await f.owner.load('tone'),f.handle);}
 else{f.waiting[2].resolve();if(outcome==='success')await c;else await assert.rejects(c,e=>e.code==='E_AUDIO_RUNTIME_ABORTED');}
 f.owner.releaseResource('tone');assert.equal(f.owner.stats.cacheEntries,0);assert.equal(f.owner.stats.decodedBytes,0);assert.equal(f.released.filter(x=>x===f.a.integrity.digest).length,1);assert.equal(new Set(f.released).size,f.released.length);f.owner.dispose();
});
test('A to pending B to cached A keeps one lease and late B cannot overwrite it',async()=>{const f=await setup(),b=f.owner.replace(f.b);b.catch(()=>{});await waitFor(()=>f.waiting.length===2);assert.equal(await f.owner.replace(f.a),f.handle);f.waiting[1].resolve();await assert.rejects(b);assert.equal(f.owner.stats.cacheEntries,1);f.owner.releaseResource('tone');assert.equal(f.owner.stats.cacheEntries,0);assert.equal(f.released.filter(x=>x===f.a.integrity.digest).length,1);f.owner.dispose();});
