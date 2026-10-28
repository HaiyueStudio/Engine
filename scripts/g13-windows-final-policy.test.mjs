import test from 'node:test';
import assert from 'node:assert/strict';
import {WINDOWS_RENDER_JOBS,windowsFinalPaths,assertWindowsFinalLocation,validateWindowsRenderReport,windowsFinalPlan} from './g13-windows-final-policy.mjs';
const revision='a'.repeat(40);
test('the Windows population keeps every full capture and separate Apple admission',()=>{
  const p=windowsFinalPlan();assert.equal(p.captures,580);assert.equal(p.jobs.length,7);assert.deepEqual(p.jobs.map(j=>j.captures),[4,156,96,24,36,40,224]);
  assert.equal(p.macQualified,false);assert.equal(p.iPhoneQualified,false);assert.equal(p.externalPublishPerformed,false);assert.equal(p.automaticRetry,false);
  assert.deepEqual(p.hyaFollowups.map(j=>j.id),['layout','corpus']);assert.equal(p.hyaFollowups[0].cohorts,27);assert.equal(p.hyaFollowups[1].denominator,23);assert.equal(p.hyaFollowups[1].rounds,3);
});
test('the isolated checkout is bounded to a new named G13 directory',()=>{
  const root=process.cwd(),paths=windowsFinalPaths(root,'1793151130884-1234abcd');assert.equal(assertWindowsFinalLocation(root,paths.output),paths.output);
  for(const path of [root,paths.checkout,paths.output+'/../other',paths.output+'-old'])assert.throws(()=>assertWindowsFinalLocation(root,path));
  for(const id of ['','../escape','1793151130884-ABCDEF01'])assert.throws(()=>windowsFinalPaths(root,id));
});
test('only complete clean full reports can enter the seven-report raw audit',()=>{
  for(const job of WINDOWS_RENDER_JOBS){const r={revision,dirty:false,plan:Array.from({length:job.captures},()=>({})),entries:Array.from({length:job.captures},()=>({status:'captured'})),status:'passed',tier:job.id==='correctness'?'full':job.id==='production'?'production-local':'local-full',suite:job.id};
    assert.doesNotThrow(()=>validateWindowsRenderReport(job,r,revision));
    for(const change of [x=>x.revision='b'.repeat(40),x=>x.dirty=true,x=>x.plan.pop(),x=>x.entries.pop(),x=>x.entries[0].status='invalid',x=>x.tier='smoke']){const bad=structuredClone(r);change(bad);assert.throws(()=>validateWindowsRenderReport(job,bad,revision));}
  }
});
test('original G05 failures remain visible and require the independent inherited audit',()=>{
  for(const job of WINDOWS_RENDER_JOBS.filter(j=>['rooms','instances','forward'].includes(j.id))){const r={revision,dirty:false,plan:new Array(job.captures),entries:Array.from({length:job.captures},()=>({status:'captured'})),status:'failed',tier:'local-full',suite:job.id};assert.doesNotThrow(()=>validateWindowsRenderReport(job,r,revision));r.status='invalid';assert.throws(()=>validateWindowsRenderReport(job,r,revision));}
});
