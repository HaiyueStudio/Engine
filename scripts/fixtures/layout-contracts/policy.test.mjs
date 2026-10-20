import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {validateContract,validateBaseline,validateOracle,validateRegion} from './policy.mjs';
import {cases} from './cases.mjs';
const root=resolve(import.meta.dirname,'../../..'),read=p=>JSON.parse(readFileSync(resolve(root,p),'utf8'));
const c=read('config/layout-022-contract.json');
test('G01 contract freezes topology, boundaries, semantics, versions and named allocations',()=>{validateContract(c);assert.equal(cases.length,4);for(const x of cases){assert.equal(x.children.length,x.expected.length);assert.ok(x.classification);}});
test('reject malformed contract or silent expansion',()=>{
  for(const edit of [x=>x.layout.maxDepth=129,x=>x.apiAllocations['@haiyue/engine']['.'].maximum=31,x=>x.region.updateModes.pop(),x=>x.versions.formatChanges=true,x=>x.requiredCorrectnessCaseIds.pop()]){const bad=structuredClone(c);edit(bad);assert.throws(()=>validateContract(bad));}
});
test('actual baseline includes every cohort, current semantics and zero destructible residue',()=>validateBaseline(read('artifacts/engine-0.2.2/g01/baseline-frozen.json'),c));
test('partial populations, stale config, nonfinite times and hidden leaks are rejected',()=>{
  const original=read('artifacts/engine-0.2.2/g01/baseline-frozen.json');
  for(const edit of [x=>x.cpu.pop(),x=>x.cpu[0].samples[0]=NaN,x=>x.contractSnapshot.layout.maxDepth=1,x=>x.structural[0].auditAfterDestroy.resources.texture.live=1,x=>x.observations[0].actual=x.observations[0].expected]){const bad=structuredClone(original);edit(bad);assert.throws(()=>validateBaseline(bad,c));}
});
test('real browser oracle independently matches selected subset',()=>validateOracle(read('artifacts/engine-0.2.2/g01/oracle.json'),c));
test('native baseline has MSAA cohorts, distinct pixels and no release qualification',()=>validateRegion(read('artifacts/engine-0.2.2/g01/region-baseline.json')));
test('proposed API inventory is declared without private HYA type imports',()=>{
  const draft=readFileSync(resolve(root,c.apiDraft),'utf8');
  for(const entries of Object.values(c.apiAllocations))for(const a of Object.values(entries))for(const name of a.additions)assert.match(draft,new RegExp(`\\b(?:type|interface|class|function) ${name}\\b`));
  assert.doesNotMatch(draft,/from ['"][^'"]*(?:\/src\/|\/experimental|animation-spec|opentype)/);
  for(const p of [c.apiDraft,c.review])assert.ok(existsSync(resolve(root,p)));
});
