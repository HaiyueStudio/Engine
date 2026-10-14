import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateProductionConfig, productionPlan, productionDiagnosticPlan, summarizePacing, assessProductionCapture } from './framegraph-production-policy.mjs';
import { chromePresentationArguments } from './chrome-runner.mjs';
const config = JSON.parse(readFileSync(new URL('../../config/framegraph-production-021.json', import.meta.url)));
const job = { round:1, caseId:'f1-reference-128', browserId:'chrome-windows' };
test('stress diagnostic covers both browsers separately from the complete production plan',()=>{
  const jobs=productionDiagnosticPlan(config);
  assert.deepEqual(jobs.map(j=>j.browserId),config.browser);
  assert.ok(jobs.every(j=>j.caseId==='f8-stress-512'));
  assert.equal(productionPlan(config).length,36);
});
function capture() {
  const spec = config.workloads.find(w=>w.id===job.caseId), snapshot = { width:1280,height:720,lights:128,boxes:256,views:1,
    lighting:{ completeCoverage:true, effective:'deferred-reference', submittedPoints:128 }, effects:[] };
  return { schemaVersion:1,contractId:config.contractId,caseId:spec.id,status:'captured', measurement:'engine-rAF-cadence-visible-canvas',
    browserEvidence:{ presentationMode:'visible-window',nativeBackend:true,userAgent:'Windows Chrome/140.0' },
    browserDiagnostics:{unclassifiedFailureCount:0}, adapter:{vendor:'nvidia',architecture:'pascal',isFallbackAdapter:false},
    initial:snapshot,final:structuredClone(snapshot),cleanup:{resources:0,estimatedBytes:0},errors:[],events:[],
    startMs:50,startedAt:'2026-10-13T00:00:00Z',finishedAt:'2026-10-13T00:00:42Z',
    firstFrameMs:100,firstSubmissionMs:102,screen:{innerWidth:1300,innerHeight:760},
    sceneInitializedMs:60,readyMs:90,preparation:[{start:60,submitted:65,completed:72,visible:'visible',focused:true},{start:73,submitted:80,completed:85,visible:'visible',focused:true}],
    frames:Array.from({length:2401},(_,i)=>{ const t=100+i*1000/60;return [t,t+1,t+2,1,1]; }) };
}
test('production plan retains every case and reverses the second browser/workload cohort',()=>{
  assert.equal(validateProductionConfig(config),config);
  const plan=productionPlan(config);assert.equal(plan.length,36);
  assert.equal(plan[0].caseId,plan.at(-1).caseId);assert.equal(plan[0].browserId,plan.at(-1).browserId);assert.equal(plan.at(-1).round,2);
  const missing=structuredClone(config);missing.workloads=missing.workloads.filter(w=>w.group!=='F3');assert.throws(()=>productionPlan(missing),/Missing F3/);
  const noWarmup=structuredClone(config);delete noWarmup.warmupBoundary.seconds;assert.throws(()=>productionPlan(noWarmup));
});
test('visible mode is opt-in and never disables vsync/background scheduling',()=>{
  assert.deepEqual(chromePresentationArguments(null),['--headless=new']);
  const args=chromePresentationArguments({mode:'visible',width:1320,height:840});
  assert.ok(args.every(a=>!/headless|disable-frame|disable-background|disable-renderer/.test(a)));
  assert.throws(()=>chromePresentationArguments({mode:'visible',width:0,height:840}));
});
test('60 Hz complete visible engine frames pass, with independent CPU and startup statistics',()=>{
  const result=assessProductionCapture(capture(),config,job);assert.equal(result.status,'passed');
  assert.ok(Math.abs(result.steady.averageFps-60)<.001);assert.equal(result.cpuFrame.p95Ms,1);assert.equal(result.g09Complete,false);assert.equal(result.releaseQualified,false);
});
test('frame ordering, truncation, dimensions, residuals, headless and silent fallback fail closed',()=>{
  for (const change of [r=>r.frames.pop(),r=>r.frames[2][0]=r.frames[1][0],r=>r.final.width=640,r=>r.cleanup.resources=1,
    r=>r.browserEvidence.presentationMode='headless',r=>r.final.lighting.completeCoverage=false,r=>r.errors.push('device lost'),
    r=>delete r.firstSubmissionMs,r=>delete r.events,r=>r.final.effects=['GtaoPass']]) {
    const raw=capture();change(raw);assert.throws(()=>assessProductionCapture(raw,config,job));
  }
});
test('hidden or unfocused intervals are inconclusive even when all frame budgets pass',()=>{
  const raw=capture();raw.frames[800][4]=0;const result=assessProductionCapture(raw,config,job);assert.equal(result.status,'inconclusive');assert.ok(result.contamination.length);
});
test('missed frames remain in percentiles and consecutive stalls rather than trimmed as outliers',()=>{
  const result=summarizePacing([16,16,100,100,100,16],50);assert.equal(result.p95Ms,100);assert.equal(result.longFrameRatio,.5);assert.equal(result.maxConsecutiveLongFrames,3);
  const raw=capture();raw.frames=raw.frames.filter((_,i)=>i%2===0);const assessed=assessProductionCapture(raw,config,job);assert.equal(assessed.status,'failed');assert.ok(assessed.failures.includes('frameP95Ms'));
});

test('readiness requires actual ordered GPU completion and measures the first interactive intervals',()=>{
  for(const change of [r=>delete r.readyMs,r=>r.preparation.pop(),r=>r.readyMs=70,r=>r.preparation[1].start=50]){
    const raw=capture();change(raw);assert.throws(()=>assessProductionCapture(raw,config,job));
  }
  const raw=capture();raw.frames=raw.frames.filter((_,i)=>i===0||i===6||i===12||i>=18);
  const result=assessProductionCapture(raw,config,job);
  assert.equal(result.status,'failed');assert.ok(result.failures.includes('interactiveStartup:maxConsecutiveLongFrames'));
  assert.equal(result.loading.navigationToReadyMs,90);
});

test('legacy profiles keep their original startup classification instead of being silently promoted',()=>{
  const legacy=structuredClone(config);legacy.contractId='g09-presented-production-v1';delete legacy.readiness;
  const raw=capture();raw.contractId=legacy.contractId;delete raw.preparation;delete raw.readyMs;delete raw.sceneInitializedMs;
  raw.frames=raw.frames.filter((_,i)=>i===0||i===6||i===12||i>=18);
  const result=assessProductionCapture(raw,legacy,job);assert.equal(result.status,'passed');assert.equal(result.loading,undefined);
  const missing=structuredClone(config);delete missing.readiness;assert.throws(()=>validateProductionConfig(missing));
});
