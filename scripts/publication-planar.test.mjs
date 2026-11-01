import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createPlanarConfigurations,PLANAR_BUDGET_CASE_IDS,planarFixtureProtocol,validatePlanarProgress} from './release-workflow-planar-policy.mjs';
const root=resolve(import.meta.dirname,'..');
test('four original smoke cases and complete 48-case Cartesian matrix remain unchanged',()=>{
 assert.equal(createPlanarConfigurations('smoke').length,4);assert.equal(createPlanarConfigurations('full').length,48);
 const id=c=>`render3d.planar-reflection.${c.entityCount}e.${c.mirrorCount}m.${c.maxBounces}b.${c.viewCount}v`;
 assert.deepEqual(createPlanarConfigurations('smoke').map(id),PLANAR_BUDGET_CASE_IDS);
 const full=createPlanarConfigurations('full');assert.equal(new Set(full.map(id)).size,48);
 for(const e of [1000,10000])for(const v of [1,4])for(const m of [1,2,4])for(const b of [1,3,5,8])assert.ok(full.some(c=>c.entityCount===e&&c.viewCount===v&&c.mirrorCount===m&&c.maxBounces===b));
});
test('one original fixture result deadline covers all cases; warmup and sample populations unchanged',()=>{
 const smoke=planarFixtureProtocol(),full=planarFixtureProtocol({mode:'full'});
 assert.equal(smoke.resultWaitTimeoutMs,300000);assert.equal(full.resultWaitTimeoutMs,900000);
 assert.equal(full.nonBudgetMatrixSamples,1);assert.equal(smoke.warmup,3);assert.equal(smoke.samples,40);assert.equal(smoke.pixelCases,4);
 const fixture=readFileSync(resolve(root,'scripts/webgpu-gate/planar-reflection-fixture.mjs'),'utf8');
 assert.match(fixture,/const caseSamples = budgetCase \? samples : 1/);assert.match(fixture,/for \(let index = 0; index < caseWarmup; index\+\+\)/);
 assert.match(fixture,/durations\.push\(performance\.now\(\) - startedAt\);\n\s+if\(index/,'progress emitted after the timing sample');
 const entry=readFileSync(resolve(root,'scripts/verify-webgpu-planar-reflection.mjs'),'utf8');
 assert.equal((entry.match(/runChromeWebGpuFixture\(/g)??[]).length,1);assert.match(entry,/timeoutMs:protocol.resultWaitTimeoutMs/);
 assert.match(entry,/browserFailure:error.browserFailure/);assert.match(entry,/!diagnosticOutput && shouldWriteFormalPerformanceEvidence/);
});
test('invalid progress, unknown modes and invalid sample counts are rejected',()=>{
 const good={schemaVersion:1,suite:'render3d.planar-reflection',mode:'smoke',phase:'samples',elapsedMs:1,frame:40};
 assert.equal(validatePlanarProgress(good),good);
 for(const change of [{phase:'passed-with-timeout'},{elapsedMs:NaN},{frame:-1},{mode:'skip-heavy'}])assert.throws(()=>validatePlanarProgress({...good,...change}));
 for(const change of [{mode:'skip-heavy'},{warmup:0},{samples:0},{samples:1.5}])assert.throws(()=>planarFixtureProtocol(change));
});
