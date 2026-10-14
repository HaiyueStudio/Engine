import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { sha256 } from './deferred-fixture-policy.mjs';
import { frameGraphStudyPlan, assessResourceStudy, assessAblationStudy, compareStudyPixels, STUDY_VARIANTS } from './framegraph-study-policy.mjs';
import { auditFrameGraphStudy } from './framegraph-study-artifact.mjs';

const config=JSON.parse(readFileSync(new URL('../../config/framegraph-production-021.json',import.meta.url)));
function common(job) {
  const spec=config.workloads.find(w=>w.id===job.caseId);
  return {schemaVersion:1,status:'captured',caseId:job.caseId,startedAt:'2026-10-13T00:01:00Z',finishedAt:'2026-10-13T00:07:00Z',
    adapter:{vendor:'nvidia',architecture:'pascal',isFallbackAdapter:false},errors:[],cleanup:{resources:0,estimatedBytes:0},
    browserEvidence:{nativeBackend:true,presentationMode:'visible-window',userAgent:`Windows Chrome/154.0${job.browserId==='edge-windows'?' Edg/155.0':''}`},
    browserDiagnostics:{unclassifiedFailureCount:0},
    final:{width:spec.resolution[0],height:spec.resolution[1],views:spec.views,lights:spec.lights,boxes:256,
      lighting:{completeCoverage:true,effective:`deferred-${spec.algorithm}`,submittedPoints:spec.lights},
      effects:spec.effect==='gtao'?['GtaoPass']:spec.effect==='taa-blur'?['TaaPass','GaussianBlurPass']:[]}};
}
function resource(job,plan) {
  return {...common(job),plan,drained:{pendingCompletions:0,peakPendingCompletions:12},cleanupDetails:{owners:0,caches:0,releasedOwnerResiduals:0},
    samples:Array.from({length:plan.seconds/plan.sampleSeconds+1},(_,i)=>({elapsed:i*plan.sampleSeconds,resources:2,bytes:256,
      byType:{buffer:{current:1,estimatedBytes:256},bindGroup:{current:1,estimatedBytes:0}},ownerCount:1,cacheCount:1,cacheEntries:1,releasedOwnerResiduals:0,pendingCompletions:1,peakPendingCompletions:12})),
    frames:Array.from({length:plan.seconds*60+1},(_,i)=>{const t=i*1000/60;return [t,t+1,t+2,1,1];})};
}
function ablation(job,plan) {
  const raw=common(job),level=STUDY_VARIANTS.indexOf(job.variant),row=i=>({time:100+i*1000/60,cpuMs:2,visible:'visible',focused:true,counters:{drawCalls:1}});
  const deferred=config.workloads.find(w=>w.id===job.caseId).algorithm!=='forward';
  const snapshot={...raw.final,controls:{forceEnabledPassRoots:level===0,attachment:level>=4,
    caches:Object.fromEntries(['view','scene','requirements','post','postAllocation',...(deferred?['deferred','aoAllocation','mrtAllocation']:[])].map(k=>[k,level>=3])),
    pools:Object.fromEntries(['post',...(deferred?['ao','mrt']:[])].map(k=>[k,level>=2]))},
    pools:{post:{physicalBytes:level>=2?256:1024}},caches:{view:{hits:3}},graphs:{view:{passCount:2}},resources:{resources:5,estimatedBytes:1024}};
  return {...raw,variant:job.variant,sampling:plan.sampling,before:structuredClone(snapshot),afterCpu:structuredClone(snapshot),final:structuredClone(snapshot),
    loading:[row(0),row(1),row(2)],cpu:Array.from({length:plan.sampling.cpuFrames},(_,i)=>row(i)),
    gpu:Array.from({length:plan.sampling.gpuFrames},(_,i)=>({...row(i),queueWaitMs:1,readbackMs:.5,timing:{spanMs:2,totalMs:1.5,passes:[{kind:'render',durationMs:1},{kind:'compute',durationMs:.5}]}}))};
}
function png(red=150,width=1280,height=720) {
  const rows=Buffer.alloc((width*3+1)*height);
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){const i=y*(width*3+1)+1+x*3;rows[i]=red;rows[i+1]=40;rows[i+2]=20;}
  const chunk=(name,data)=>{const b=Buffer.alloc(data.length+12);b.writeUInt32BE(data.length);b.write(name,4);data.copy(b,8);return b;};
  const header=Buffer.alloc(13);header.writeUInt32BE(width);header.writeUInt32BE(height,4);header[8]=8;header[9]=2;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',header),chunk('IDAT',deflateSync(rows)),chunk('IEND',Buffer.alloc(0))]);
}
function artifact(mode='resources') {
  const plan=frameGraphStudyPlan(config,mode),files=new Map(),put=(file,value)=>{const bytes=Buffer.isBuffer(value)?value:Buffer.from(JSON.stringify(value));files.set(file,bytes);return {file,sha256:sha256(bytes)};};
  const build=[put('fixture.js',Buffer.from('runtime'))];put('runtime/fixture.js',Buffer.from('runtime'));const image=put('canvas.png',png());
  const inputs={runtime:{sha256:'a'.repeat(64),fileCount:1},harness:[{path:'fixture',sha256:'b'.repeat(64)}]};
  const report={schemaVersion:1,tier:'local-full',mode,config,plan,inputs,inputsAfter:structuredClone(inputs),build,revision:'c'.repeat(40),dirty:true,host:{platform:'win32'},entries:[]};
  report.registration=put('registration.json',{...report,registeredAt:'2026-10-13T00:00:00Z'});
  for(const [i,job]of plan.jobs.entries()){
    const raw=mode==='resources'?resource(job,plan):ablation(job,plan);raw.httpProvenance={files:[{sourcePath:'probe-runtime/fixture.js',sha256:build[0].sha256}]};
    report.entries.push({job,raw:put(`${i}.json`,raw),image,status:'forged-pass'});
  }
  return {report,files,put,read:name=>{assert.ok(files.has(name),`missing ${name}`);return files.get(name);}};
}

test('study plans retain both browsers, fixed durations and every attribution variant',()=>{
  const resources=frameGraphStudyPlan(config,'resources'),ablation=frameGraphStudyPlan(config,'ablation');
  assert.equal(resources.seconds,310);assert.equal(resources.jobs.length,4);assert.equal(ablation.jobs.length,40);
  for(const browser of config.browser)for(const group of ['F0','F2','F3','F4'])assert.deepEqual(ablation.jobs.filter(j=>j.browserId===browser&&config.workloads.find(w=>w.id===j.caseId).group===group).map(j=>j.variant).sort(),[...STUDY_VARIANTS].sort());
  assert.equal(frameGraphStudyPlan(config,'resources',true).seconds,20);assert.throws(()=>frameGraphStudyPlan(config,'unknown'));
});
test('resource envelope detects zero-byte binding and cache growth without confusing allocation peaks with leaks',()=>{
  const plan=frameGraphStudyPlan(config,'resources'),job=plan.jobs[0],raw=resource(job,plan);
  assert.equal(assessResourceStudy(raw,job,config,plan).status,'passed');
  for(const mutate of [s=>{s.byType.bindGroup.current++;s.resources++;},s=>s.cacheEntries++,s=>s.ownerCount++]){
    const copy=structuredClone(raw);mutate(copy.samples.at(-1));assert.equal(assessResourceStudy(copy,job,config,plan).status,'failed');
  }
});
test('resource residue, truncated checkpoints, wrong totals and native workload changes fail closed',()=>{
  const plan=frameGraphStudyPlan(config,'resources'),job=plan.jobs[0];
  for(const mutate of [r=>r.drained.pendingCompletions=1,r=>r.cleanupDetails.caches=1,r=>r.samples.pop(),r=>r.samples.splice(20,1),r=>r.frames.pop(),r=>r.samples[5].bytes++,r=>r.cleanup.resources=1,r=>r.final.lights=1,r=>r.browserEvidence.userAgent='Edg/155.0',r=>r.errors.push('device lost')]){
    const raw=resource(job,plan);mutate(raw);assert.throws(()=>assessResourceStudy(raw,job,config,plan));
  }
});
test('resource pacing and focus remain independently enforced',()=>{
  const plan=frameGraphStudyPlan(config,'resources'),job=plan.jobs[0],raw=resource(job,plan);
  raw.frames[100][4]=0;assert.equal(assessResourceStudy(raw,job,config,plan).status,'inconclusive');raw.frames[100][4]=1;
  raw.frames=raw.frames.filter((_,i)=>i%3===0);assert.equal(assessResourceStudy(raw,job,config,plan).status,'failed');
});
test('ablation retains separate CPU, GPU, queue and readback channels and checks selected controls',()=>{
  const plan=frameGraphStudyPlan(config,'ablation'),job=plan.jobs[0],raw=ablation(job,plan),result=assessAblationStudy(raw,job,config,plan);
  assert.equal(result.status,'passed');assert.equal(result.metrics.cpuP95Ms,2);assert.equal(result.metrics.gpuSpanP95Ms,2);assert.equal(result.metrics.queueWaitP95Ms,1);assert.equal(result.metrics.readbackP95Ms,.5);
  for(const mutate of [r=>r.cpu.pop(),r=>r.gpu.pop(),r=>r.loading.pop(),r=>r.cpu.reverse(),r=>delete r.before.controls.caches.scene,r=>r.afterCpu.controls.attachment=true,r=>r.before.controls.caches.view=true,r=>r.gpu[0].timing.passes.pop(),r=>r.gpu[0].timing={totalMs:0,passes:[],passLabels:[]},r=>r.gpu[0].timing.spanMs=.5,r=>r.gpu[0].readbackMs=NaN]){
    const copy=structuredClone(raw);mutate(copy);assert.throws(()=>assessAblationStudy(copy,job,config,plan));
  }
  raw.gpu[0].focused=false;assert.equal(assessAblationStudy(raw,job,config,plan).status,'inconclusive');
});
test('pixel comparison checks the complete visible canvas and rejects clipping',()=>{
  assert.equal(compareStudyPixels(png(),png(152)).passed,true);assert.equal(compareStudyPixels(png(),png(153)).passed,false);
  assert.throws(()=>compareStudyPixels(png(150,1279),png()),/clipped/);
});
test('artifact audit recomputes raw results and never promotes a dirty local study to release',async()=>{
  const f=artifact(),result=await auditFrameGraphStudy(f.report,f.read);assert.equal(result.status,'passed');assert.equal(result.cleanCandidate,false);assert.equal(result.releaseQualified,false);
  const raw=JSON.parse(f.read('0.json'));raw.samples.at(-1).cacheEntries++;f.report.entries[0].raw=f.put('0.json',raw);
  assert.equal((await auditFrameGraphStudy(f.report,f.read)).status,'failed');
});
test('artifact audit rejects omitted cases, smoke substitution, changed source/bytes, late registration and wrong served runtime',async()=>{
  for(const mutate of [f=>f.report.entries.pop(),f=>f.report.tier='smoke',f=>f.report.inputsAfter.runtime.sha256='d'.repeat(64),f=>f.files.set('0.json',Buffer.from('{}')),f=>f.files.set('runtime/fixture.js',Buffer.from('changed')),
    f=>{const r=JSON.parse(f.read('registration.json'));r.registeredAt='2026-10-14T00:00:00Z';f.report.registration=f.put('registration.json',r);},
    f=>{const r=JSON.parse(f.read('0.json'));r.httpProvenance.files=[];f.report.entries[0].raw=f.put('0.json',r);}]){
    const f=artifact();mutate(f);await assert.rejects(()=>auditFrameGraphStudy(f.report,f.read));
  }
});
test('ablation audit requires actual allocation benefit and pixel equivalence across each group',async()=>{
  const f=artifact('ablation'),result=await auditFrameGraphStudy(f.report,f.read);assert.equal(result.status,'passed');assert.equal(result.benefits.length,8);
  const e=f.report.entries[1];e.image=f.put('different.png',png(200));assert.equal((await auditFrameGraphStudy(f.report,f.read)).status,'failed');
});
