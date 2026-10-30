import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {summarize,cohort,validateReport,MIN_MEDIAN_PARSE_SPEEDUP,MIN_GZIP_SAVING} from './report-policy.mjs';
const baseline=JSON.parse(readFileSync(new URL('../../animation-spec/corpus/results/latest.json',import.meta.url),'utf8'));
test('shared corpus policy preserves original checked-in numeric summaries and thresholds',()=>{
  assert.equal(MIN_MEDIAN_PARSE_SPEEDUP,1.25);assert.equal(MIN_GZIP_SAVING,.15);
  assert.deepEqual(summarize(baseline.samples),baseline.summary);
  if(baseline.cohorts)for(const size of ['small','large'])assert.deepEqual(summarize(cohort(baseline.samples,size)),baseline.cohorts[size]);
  assert.doesNotThrow(()=>validateReport(baseline,baseline));
});
test('shared corpus policy rejects incomplete delivery, fidelity regression and unclassified failures',()=>{
  for(const mutate of [p=>{p.samples[0].delivery=null;},p=>{p.cohorts.small.minimumFidelity-=.01;},p=>{p.summary.unclassifiedFailureCount=1;},p=>{p.cohorts.small.gzipByteSaving=.149;}]){
    const report=structuredClone(baseline);mutate(report);assert.throws(()=>validateReport(report,baseline));
  }
});
