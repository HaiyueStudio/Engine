import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {ghBytes} from './release-workflow-assets.mjs';
import {assetPlanId,assetLabel,verifyAssetStream,runReleaseAssets} from './release-workflow-assets-policy.mjs';
const bytes=Buffer.from([0,255,27,91,51,49,109,65,0,66,27,91,48,109]);
const asset={name:'binary.tgz',file:'binary.tgz',bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
const plan={schemaVersion:1,repository:'HaiyueStudio/Engine',releaseId:42,tag:'v0.2.3',revision:'a'.repeat(40),assets:[asset]};
async function* stream(content=bytes){for(let i=0;i<content.length;i+=3)yield content.subarray(i,i+3);}
function harness(initial=[]){const h={remote:structuredClone(initial),saved:[],writes:[],downloads:0,release:{id:42,tag_name:'v0.2.3',draft:true}};h.io={
 release:async()=>h.release,tagRevision:async()=>plan.revision,local:async()=>stream(),list:async()=>structuredClone(h.remote),currentUser:async()=>({id:7}),asset:async id=>h.remote.find(a=>a.id===id),
 download:async()=>{h.downloads++;return stream();},save:async s=>h.saved.push(structuredClone(s)),
 upload:async(a,label)=>{h.writes.push('upload');h.remote=[{...a,id:1,state:'uploaded',size:a.bytes,label,uploader:{id:7}}];},
 remove:async id=>{h.writes.push('delete');h.remote=h.remote.filter(r=>r.id!==id);},
};return h;}
const completed=()=>({id:1,name:asset.name,state:'uploaded',size:asset.bytes,uploader:{id:7}});
test('binary ANSI/NUL/invalid UTF8 bytes are hashed unchanged with bounded chunks',async()=>assert.deepEqual(await verifyAssetStream(asset,stream()),{bytes:bytes.length,sha256:asset.sha256}));
test('text transports, truncation, extra bytes and SHA conflicts are rejected',async()=>{
 await assert.rejects(verifyAssetStream(asset,(async function*(){yield bytes.toString();})()),/text/);
 for(const b of [bytes.subarray(1),Buffer.concat([bytes,Buffer.from([0])]),Buffer.alloc(bytes.length)])await assert.rejects(verifyAssetStream(asset,stream(b)),/byte|SHA|exceeds/);
});
test('existing completed attachments are always streamed and verified without mutation',async()=>{const h=harness([completed()]);assert.equal((await runReleaseAssets(plan,null,h.io)).status,'verified');assert.equal(h.downloads,1);assert.deepEqual(h.writes,[]);});
test('new upload persists intent before write; partial completion resumes by readback',async()=>{
 const h=harness();h.io.upload=async(a,label)=>{assert.equal(h.saved.at(-1).assets[a.name].status,'submitting');h.writes.push('upload');h.remote=[{...completed(),label}];};
 const first=await runReleaseAssets(plan,null,h.io,{allowUpload:true});assert.equal(first.status,'verified');
 await runReleaseAssets(plan,first.journal,h.io,{allowUpload:true});assert.deepEqual(h.writes,['upload']);
});
test('a lost upload acknowledgement and missing remote result never trigger an automatic repeat',async()=>{
 const h=harness();h.io.upload=async()=>{h.writes.push('upload');throw Error('connection lost');};
 await assert.rejects(runReleaseAssets(plan,null,h.io,{allowUpload:true}),/lost/);
 assert.equal(h.saved.at(-1).status,'failed');assert.match(h.saved.at(-1).lastFailure,/lost/);
 assert.equal((await runReleaseAssets(plan,h.saved.at(-1),h.io,{allowUpload:true})).status,'pending');assert.deepEqual(h.writes,['upload']);
});
test('verified asset disappearing later is pending, never permission to overwrite or reupload',async()=>{
 const h=harness([completed()]);const first=await runReleaseAssets(plan,null,h.io);h.remote=[];
 assert.equal((await runReleaseAssets(plan,first.journal,h.io,{allowUpload:true})).status,'pending');assert.deepEqual(h.writes,[]);
});
test('late completion after a lost acknowledgement is verified and retained',async()=>{
 const h=harness([completed()]),journal={schemaVersion:1,planId:assetPlanId(plan),assets:{[asset.name]:{attempted:true,status:'indeterminate'}}};
 assert.equal((await runReleaseAssets(plan,journal,h.io,{allowUpload:true})).status,'verified');assert.deepEqual(h.writes,[]);
});
test('owned incomplete draft requires explicit repair, label, uploader and prior intent',async()=>{
 const starter={...completed(),state:'starter',size:0,label:assetLabel(plan,asset)};
 const journal={schemaVersion:1,planId:assetPlanId(plan),assets:{[asset.name]:{attempted:true,status:'indeterminate'}}};
 for(const mutate of [h=>h.release.draft=false,h=>h.remote[0].uploader.id=8,h=>h.remote[0].label='different-plan']){
   const h=harness([starter]);mutate(h);await assert.rejects(runReleaseAssets(plan,journal,h.io,{allowUpload:true,allowRepairIncomplete:true}));assert.deepEqual(h.writes,[]);
 }
 const h=harness([starter]);await assert.rejects(runReleaseAssets(plan,journal,h.io,{allowUpload:true}));assert.deepEqual(h.writes,[]);
 const yes=harness([starter]);assert.equal((await runReleaseAssets(plan,journal,yes.io,{allowUpload:true,allowRepairIncomplete:true})).status,'verified');assert.deepEqual(yes.writes,['delete','upload']);
});
test('placeholder completing between inspection and deletion is never deleted',async()=>{
 const h=harness([{...completed(),state:'starter',size:0,label:assetLabel(plan,asset)}]);h.io.asset=async()=>completed();
 const journal={schemaVersion:1,planId:assetPlanId(plan),assets:{[asset.name]:{attempted:true,status:'indeterminate'}}};
 await assert.rejects(runReleaseAssets(plan,journal,h.io,{allowUpload:true,allowRepairIncomplete:true}),/changed/);assert.deepEqual(h.writes,[]);
});
test('completed hash conflict, changed tag, wrong journal and missing local file stop writes',async()=>{
 for(const mutate of [h=>h.remote[0].digest='sha256:'+'0'.repeat(64),h=>h.io.tagRevision=async()=>'b'.repeat(40),h=>h.io.local=async()=>{throw Error('missing local');}]){
 const h=harness([completed()]);mutate(h);await assert.rejects(runReleaseAssets(plan,null,h.io,{allowUpload:true}));assert.deepEqual(h.writes,[]);}
 await assert.rejects(runReleaseAssets(plan,{schemaVersion:1,planId:'wrong'},harness().io),/another/);
});

test('transport keeps stderr control characters separate from raw stdout and never verifies a failed stream',async()=>{
  for(const exit of [0,1]){
    const output=ghBytes(['api','fake'],{spawnImpl:()=>{
      const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.exitCode=null;child.kill=()=>{};
      queueMicrotask(()=>{child.stderr.write('\x1b[31mnoise\x00 npm_secret\ngh');child.stderr.write('p_transportsecret\n');child.stdout.end(bytes);child.stderr.end();child.exitCode=exit;child.emit('close',exit);});return child;
    }});
    if(exit===0)assert.equal((await verifyAssetStream(asset,output)).sha256,asset.sha256);
    else await assert.rejects(verifyAssetStream(asset,output),error=>error.message.includes('gh exited 1')&&!error.message.includes('npm_secret')&&!error.message.includes('transportsecret')&&!error.message.includes('\x00'));
  }
});

test('target changes before upload stop before mutation and retain a sanitized failure journal',async()=>{
 const h=harness();let reads=0;h.io.release=async()=>({...h.release,tag_name:++reads===1?plan.tag:'v9.9.9'});
 await assert.rejects(runReleaseAssets(plan,null,h.io,{allowUpload:true}),/frozen candidate/);assert.deepEqual(h.writes,[]);assert.equal(h.saved.at(-1).status,'failed');
 const secrets=harness();secrets.io.upload=async()=>{throw Error('lost npm_secret password=hidden');};
 await assert.rejects(runReleaseAssets(plan,null,secrets.io,{allowUpload:true}));const saved=secrets.saved.at(-1);assert.ok(!JSON.stringify(saved).includes('npm_secret'));assert.ok(!JSON.stringify(saved).includes('hidden'));
});
