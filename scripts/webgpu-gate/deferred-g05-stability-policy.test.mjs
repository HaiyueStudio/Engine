import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateG05Stability} from './deferred-g05-stability-policy.mjs';
import {createG05InstancePlan} from './deferred-g05-instance-cohort-policy.mjs';
import {instanceEvidence} from './deferred-g05-instance-test-data.mjs';
import {createG05RoomPlan} from './deferred-g05-cohort-policy.mjs';
import {valid} from './deferred-g05-test-data.mjs';
test('F stability preserves all paired channels and rejects round drift despite a fast pooled percentile',()=>{
 const all=createG05InstancePlan().map(job=>({job,evidence:instanceEvidence(job)}));
 const report=evaluateG05Stability(all,'instances');assert.equal(report.status,'passed');assert.equal(report.checks.length,192);assert.deepEqual(report.exceptionsApplied,[]);
 // 30 slow samples affect one cohort P95 but less than 5% of the 900 pooled samples.
 for(let i=0;i<30;i++)all[0].evidence.result.paths[1].cpu[i].cpuRuntimeMs=2;
 const drift=evaluateG05Stability(all,'instances');assert.equal(drift.status,'failed');assert.equal(drift.checks.filter(c=>!c.passed).length,1);assert.equal(drift.checks.find(c=>!c.passed).path,'reference');
 assert.throws(()=>evaluateG05Stability(all.slice(1),'instances'),/Incomplete/);
});
test('E/G stability covers both algorithms, all static workloads and stress without creating an FPS budget',()=>{
 const all=createG05RoomPlan().map(job=>{
  const e=instanceEvidence({...job,count:1000,views:1,variant:'lod-on'});e.options=job;e.tier='diagnostic-g05-performance-candidate';e.result=valid(job);
  if(job.preference==='low-power')e.result.adapter={vendor:'intel',architecture:'gen-9',isFallbackAdapter:false};return {job,evidence:e};
 });
 const report=evaluateG05Stability(all,'rooms');assert.equal(report.status,'passed');assert.equal(report.checks.length,156);
 const stress=all.find(e=>e.job.caseId==='stress-1024');for(const s of stress.evidence.result.cpu)s.frameWallMs=6;
 const result=evaluateG05Stability(all,'rooms');assert.equal(result.status,'failed');assert.ok(result.checks.some(c=>c.caseId==='stress-1024'&&!c.passed));
 assert.throws(()=>evaluateG05Stability(all,'other'),/Unknown/);
});
import {parseG05AuditOptions} from './deferred-g05-stability-policy.mjs';
test('audit selection is explicit and cannot skip stability or request partial populations',()=>{
 assert.deepEqual(parseG05AuditOptions(['--instances=artifacts/x.json']),{scope:'instances',manifest:'artifacts/x.json'});
 for(const args of [[],['--instances='],['--rooms=x.txt'],['--instances=x.json','--skip-stability'],['--partial=x.json']])assert.throws(()=>parseG05AuditOptions(args));
});
