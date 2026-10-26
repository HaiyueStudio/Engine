import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {validatePublicationPlan, publicationPlanId, runPublication, publicationNextStep, redactPublicationLog} from './publication-policy.mjs';
const bytes = Buffer.from('qualified immutable tarball');
const integrity = 'sha512-'+createHash('sha512').update(bytes).digest('base64');
const sha256 = createHash('sha256').update(bytes).digest('hex');
const plan = {schemaVersion: 1, version: '0.2.2', revision: 'a'.repeat(40), dirty: false,
  packages: ['engine','animation-spec','extensions','shader-language'].map(n=>({name:'@haiyue/'+n,version:'0.2.2',sha256,integrity,file:n+'.tgz'}))};
function harness(observe) {
  let clock=0; const saved=[],submitted=[];
  return {saved,submitted,io:{localBytes:async()=>bytes,download:async()=>bytes,
    observe:async entry=>observe(entry,submitted),submit:async entry=>{submitted.push(entry.name);return {status:'accepted'};},
    save:async j=>saved.push(structuredClone(j)),now:()=>clock,wait:async ms=>{clock+=ms;}}};
}
test('requires exactly four clean immutable identities and rejects dirty or duplicate plans',()=>{
  validatePublicationPlan(plan);
  assert.throws(()=>validatePublicationPlan({...plan,dirty:true}));
  assert.throws(()=>validatePublicationPlan({...plan,packages:[...plan.packages.slice(0,3),plan.packages[0]]}));
});
test('accepted then delayed visibility submits each package exactly once and journals intent first',async()=>{
  const counts=new Map();const h=harness((entry)=>{
    const n=counts.get(entry.name)??0;counts.set(entry.name,n+1);
    return n<2?{status:'absent'}:{status:'visible',integrity};
  });
  const result=await runPublication(plan,null,h.io,{allowSubmit:true,maxWaitMs:30,pollMs:10});
  assert.equal(result.status,'verified');assert.equal(h.submitted.length,4);
  assert.equal(h.saved[0].packages[plan.packages[0].name].status,'submitting');
  assert.equal(result.mayCreateGithubRelease,true);assert.equal(result.mayDeployPages,false);
});
test('visibility timeout resumes without resubmission even when registry still returns 404',async()=>{
  const h=harness(()=>({status:'absent'}));
  const first=await runPublication(plan,null,h.io,{allowSubmit:true,maxWaitMs:20,pollMs:10});
  assert.equal(first.status,'pending');assert.equal(h.submitted.length,1);
  await runPublication(plan,first.journal,h.io,{allowSubmit:true,maxWaitMs:20,pollMs:10});
  assert.equal(h.submitted.length,1);
});
test('interrupted submitting journal and externally processing package never get submitted',async()=>{
  const h=harness(()=>({status:'processing'}));
  const journal={schemaVersion:1,planId:publicationPlanId(plan),packages:{[plan.packages[0].name]:{status:'submitting',attempted:true}}};
  assert.equal((await runPublication(plan,journal,h.io,{allowSubmit:true,maxWaitMs:0})).status,'pending');
  assert.equal(h.submitted.length,0);
});
test('same-version integrity or downloaded-byte conflicts stop before any submit',async()=>{
  const h=harness(()=>({status:'visible',integrity:'sha512-conflict'}));
  await assert.rejects(runPublication(plan,null,h.io,{allowSubmit:true}),/conflicting/);
  h.io.observe=async()=>({status:'visible',integrity});h.io.download=async()=>Buffer.from('tampered');
  await assert.rejects(runPublication(plan,null,h.io,{allowSubmit:true}),/conflict/);assert.equal(h.submitted.length,0);
});
test('authorization rejection is preserved; partial success survives a later failure',async()=>{
  const h=harness((entry)=>entry===plan.packages[0]?{status:'visible',integrity}:{status:'absent'});
  h.io.submit=async()=>({status:'rejected',detail:'authorization: npm_secret'});
  await assert.rejects(runPublication(plan,null,h.io,{allowSubmit:true}),/rejected/);
  const last=h.saved.at(-1);assert.equal(last.packages[plan.packages[0].name].status,'verified');
  assert.equal(last.packages[plan.packages[1].name].status,'rejected');
  assert.ok(!JSON.stringify(last).includes('npm_secret'));
});
test('query transport failures stop, verification-only never submits, other-plan journal rejected',async()=>{
  const h=harness(()=>{throw Error('registry unavailable');});
  await assert.rejects(runPublication(plan,null,h.io),/unavailable/);assert.equal(h.submitted.length,0);
  h.io.observe=async()=>({status:'absent'});assert.equal((await runPublication(plan,null,h.io)).status,'not-published');
  await assert.rejects(runPublication(plan,{schemaVersion:1,planId:'different'},h.io),/another/);
});
test('lost submit acknowledgement remains indeterminate and cannot be retried automatically',async()=>{
  const h=harness(()=>({status:'absent'}));h.io.submit=async()=>{h.submitted.push('attempt');throw Error('connection lost');};
  await assert.rejects(runPublication(plan,null,h.io,{allowSubmit:true}),/connection lost/);
  const last=h.saved.at(-1);assert.equal(last.packages[plan.packages[0].name].status,'indeterminate');
  await runPublication(plan,last,h.io,{allowSubmit:true,maxWaitMs:0});assert.equal(h.submitted.length,1);
});
test('previously visible verified versions cannot be submitted when the registry later returns 404',async()=>{
  const h=harness(()=>({status:'visible',integrity}));
  const first=await runPublication(plan,null,h.io,{allowSubmit:true});
  h.io.observe=async()=>({status:'absent'});
  assert.equal((await runPublication(plan,first.journal,h.io,{allowSubmit:true,maxWaitMs:0})).status,'pending');
  assert.equal(h.submitted.length,0);
});
test('no credentials persist; release attachment mismatch prevents Pages advancement',()=>{
  assert.equal(redactPublicationLog('otp=123456 npm_secret https://user:pass@host'), 'otp=[REDACTED] [REDACTED] https://[REDACTED]@host');
  assert.equal(publicationNextStep({status:'pending'},[]),'wait-for-npm');
  assert.equal(publicationNextStep({status:'verified'},[{expectedSha256:sha256,downloadedSha256:'bad'}]),'verify-github-assets');
  assert.equal(publicationNextStep({status:'verified'},[{expectedSha256:sha256,downloadedSha256:sha256}]),'deploy-pages-and-check-deployed-revision');
});
