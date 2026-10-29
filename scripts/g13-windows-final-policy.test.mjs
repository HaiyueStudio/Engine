import test from 'node:test';
import assert from 'node:assert/strict';
import {WINDOWS_RENDER_JOBS,windowsFinalPaths,assertWindowsFinalLocation,validateWindowsRenderReport,validateWindowsG05BudgetSummary,windowsFinalPlan} from './g13-windows-final-policy.mjs';
import {readFileSync} from 'node:fs';
import {windowsRemainingPlan,validateWindowsRemainingConfig,windowsRemainingOutput,assertWindowsRemainingOutput,validateWindowsRemainingReuse} from './g13-windows-remaining-policy.mjs';
const revision='a'.repeat(40);

test('remaining plan adds exactly 196 untouched captures to the pinned 384, then all final gates',()=>{
  const p=windowsRemainingPlan();assert.deepEqual(p.jobs.map(j=>[j.id,j.captures]),[['instances',96],['forward',24],['production',36],['ablation',40]]);
  assert.equal(p.captures,196);assert.equal(p.reused.reduce((n,j)=>n+j.captures,0)+p.captures,580);assert.equal(p.reusedHyaProductionCaptures,30);
  assert.deepEqual(p.jobs,WINDOWS_RENDER_JOBS.filter(j=>['instances','forward','production','ablation'].includes(j.id)));
  assert.equal(p.following.length,4);assert.equal(p.automaticRetry,false);assert.equal(p.externalPublishPerformed,false);assert.equal(p.baselinePromoted,false);
  p.jobs[0].args.push('--smoke');assert.equal(windowsRemainingPlan().jobs[0].args.includes('--smoke'),false);
});
const remainingConfig=()=>JSON.parse(readFileSync(new URL('../config/g13-windows-remaining.json',import.meta.url)));
test('remaining source bindings cannot omit reports, hide overrides or escape artifact paths',()=>{
  const c=remainingConfig();assert.equal(validateWindowsRemainingConfig(c),c);
  for(const mutate of [x=>x.targetVersion='0.2.1',x=>x.captureRevision='bad',x=>x.checkout='../checkout',x=>x.sourceRun.sha256='bad',
    x=>delete x.reports.rooms,x=>x.reports.forward=x.reports.rooms,x=>x.reports.rooms.file='../report.json',
    x=>x.reports.rooms.file=x.reports.resources.file,x=>x.reports.rooms.captureRevision='f'.repeat(40),
    x=>delete x.support.gamepad,x=>x.support.ime.file='C:/outside.json',x=>x.gpuLimit=.1]){const bad=structuredClone(c);mutate(bad);assert.throws(()=>validateWindowsRemainingConfig(bad));}
  const out=windowsRemainingOutput(process.cwd(),'1793151130884-1234abcd');assert.equal(assertWindowsRemainingOutput(process.cwd(),out),out);
  for(const p of [process.cwd(),out+'/checkout',out+'/../other'])assert.throws(()=>assertWindowsRemainingOutput(process.cwd(),p));
});
function remainingFixture(){
  const c=remainingConfig(),reports={};for(const kind of ['resources','rooms','correctness']){const job=WINDOWS_RENDER_JOBS.find(j=>j.id===kind);reports[kind]={revision:c.captureRevision,dirty:false,status:kind==='rooms'?'failed':'passed',tier:kind==='correctness'?'full':'local-full',suite:kind,plan:new Array(job.captures),entries:Array.from({length:job.captures},()=>({status:'captured'}))};}
  reports.rooms.assessment=g05Summary('rooms');reports.rooms.assessment.status='failed';Object.assign(reports.rooms.assessment.checks[0],{observed:4.1,passed:false});
  const run={revision:c.captureRevision,dirty:false,status:'failed',reports:{resources:{...c.reports.resources,originalStatus:'passed'},rooms:{...c.reports.rooms,originalStatus:'failed'}}};
  const support={roomDecision:{decision:'ADR0137-g05-moving-sparse256-cpu-investigation',status:'passed-adr0137-g05-prerequisite-only',captureRevision:c.captureRevision,originalReport:{sha256:c.reports.rooms.sha256}},correctnessAudit:{status:'passed-independent-correctness-audit',report:{sha256:c.reports.correctness.sha256},audit:{captures:224,pixelPairs:72}},hyaByteAudit:{status:'passed-independent-hya-byte-bindings',productionCaptures:new Array(30),rounds:new Array(3)},productionLauncher:{status:'passed-local-hya-production',originalGpuRegressionLimit:.05,independentlyAuditedCaptures:30},layout:{status:'passed',cohorts:new Array(27)},corpus:{status:'passed',rounds:new Array(3),unchangedDenominator:23},gamepad:{status:'passed-physical-gamepad',physicalInputAccepted:true,errors:[]},ime:{status:'passed-real-browser-ime',errors:[]}};
  return {c,run,reports,support};
}
test('reuse prerequisites preserve the failed room status and reject missing physical/HYA/raw coverage',()=>{
  const d=remainingFixture(),before=JSON.stringify(d),r=validateWindowsRemainingReuse(d.c,d.run,d.reports,d.support);assert.equal(r.releaseQualified,false);assert.equal(r.rooms.originalStatus,'failed');assert.equal(JSON.stringify(d),before);
  for(const mutate of [x=>x.run.status='passed',x=>x.run.dirty=true,x=>x.reports.rooms.status='passed',x=>x.reports.correctness.entries.pop(),
    x=>x.support.roomDecision.originalReport.sha256='0'.repeat(64),x=>x.support.correctnessAudit.audit.captures=223,
    x=>x.support.hyaByteAudit.productionCaptures.pop(),x=>x.support.productionLauncher.originalGpuRegressionLimit=.1,
    x=>x.support.layout.cohorts.pop(),x=>x.support.corpus.unchangedDenominator=22,x=>x.support.gamepad.physicalInputAccepted=false,
    x=>x.support.ime.errors.push('composition failed')]){const bad=remainingFixture();mutate(bad);assert.throws(()=>validateWindowsRemainingReuse(bad.c,bad.run,bad.reports,bad.support));}
});
test('the Windows population keeps every full capture and separate Apple admission',()=>{
  const p=windowsFinalPlan();assert.equal(p.captures,580);assert.equal(p.jobs.length,7);assert.deepEqual(p.jobs.map(j=>j.captures),[4,156,96,24,36,40,224]);
  assert.equal(p.macQualified,false);assert.equal(p.iPhoneQualified,false);assert.equal(p.externalPublishPerformed,false);assert.equal(p.automaticRetry,false);
  assert.deepEqual(p.hyaFollowups.map(j=>j.id),['layout','corpus']);assert.equal(p.hyaFollowups[0].cohorts,27);assert.equal(p.hyaFollowups[1].denominator,23);assert.equal(p.hyaFollowups[1].rounds,3);
  assert.deepEqual(p.hyaProduction,{captures:30,originalGpuRegressionLimit:.05});
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

function g05Summary(kind){
  const shape={rooms:[156,60,156,156],instances:[96,96,192,0],forward:[24,8,16,0]}[kind];
  return {status:'passed',cleanCandidate:true,captures:shape[0],
    checks:Array.from({length:shape[1]},(_,i)=>({metric:kind==='forward'?(i%2?'gpuP95Ratio':'cpuP95Ratio'):'cpuP95Ms',observed:kind==='forward'?1:3,limit:kind==='forward'?1.05:4,passed:true,
      ...(kind==='rooms'&&i<2?{job:{suite:'rooms',cohort:0,browserId:i?'edge-windows':'chrome-windows',caseId:'sparse-256',moving:true,algorithm:'tiled',preference:'high-performance',full:true,idleMs:0}}:{})})),
    stability:Array.from({length:shape[2]},()=>({stable:true,passed:true,cohortP95:[1,1,1],relativeSpread:0,cv:0})),
    memory:Array.from({length:shape[3]},()=>({status:'passed',checks:[{passed:true,observed:1,limit:2}]}))};
}
test('early G05 rejection keeps original absolute/GPU budgets and never grants raw qualification',()=>{
  for(const kind of ['rooms','instances','forward']){
    const job={id:kind},assessment=g05Summary(kind),report={status:'passed',assessment};assert.doesNotThrow(()=>validateWindowsG05BudgetSummary(job,report));
    const hard=structuredClone(report);hard.status=hard.assessment.status='failed';const c=hard.assessment.checks[kind==='forward'?1:kind==='rooms'?2:0];c.observed=c.limit+.001;c.passed=false;assert.throws(()=>validateWindowsG05BudgetSummary(job,hard),/original performance budget/);
    const incomplete=structuredClone(report);incomplete.assessment.checks.pop();assert.throws(()=>validateWindowsG05BudgetSummary(job,incomplete),/incomplete/);
    const variation=structuredClone(report);variation.status=variation.assessment.status='failed';Object.assign(variation.assessment.stability[0],{stable:false,passed:false,cohortP95:[1,1,2],relativeSpread:1,cv:.3});assert.doesNotThrow(()=>validateWindowsG05BudgetSummary(job,variation));
  }
  const assessment=g05Summary('forward');assessment.status='failed';Object.assign(assessment.checks[0],{observed:1.2,passed:false});assert.equal(validateWindowsG05BudgetSummary({id:'forward'},{status:'failed',assessment}).cpuRegressionInvestigations.length,1);
  assert.throws(()=>validateWindowsG05BudgetSummary({id:'production'},{status:'passed'}));
});

test('G13 early summary uses ADR 0137 without changing the raw rooms report',()=>{
  const assessment=g05Summary('rooms');assessment.status='failed';Object.assign(assessment.checks[0],{observed:4.1,passed:false});
  const report={status:'failed',assessment},before=JSON.stringify(report),result=validateWindowsG05BudgetSummary({id:'rooms'},report);
  assert.equal(result.originalStatus,'failed');assert.equal(result.hardPerformanceChecks,58);assert.equal(result.cpuAbsoluteInvestigations.length,1);
  assert.equal(JSON.stringify(report),before);
  for(const mutate of [c=>c.job.moving=false,c=>c.job.algorithm='reference',c=>c.metric='gpuP95Ms']){const copy=structuredClone(report);mutate(copy.assessment.checks[0]);assert.throws(()=>validateWindowsG05BudgetSummary({id:'rooms'},copy));}
});
