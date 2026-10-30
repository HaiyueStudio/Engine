import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
export const digest=value=>createHash('sha256').update(value).digest('hex');
export function validateContract(c){
  assert.equal(c.schemaVersion,1);assert.equal(c.contractId,'engine-022-g01-v1');assert.equal(c.targetVersion,'0.2.2');
  assert.equal(c.role,'implementation-contract-and-diagnostic-baseline-not-release-evidence');
  assert.deepEqual(c.requiredCorrectnessCaseIds,['grid-gap','grid-track-max','flex-clamp-redistribution','flex-wrap-line-justify']);
  assert.deepEqual(c.region.updateModes,['demand','once','continuous','disabled']);assert.deepEqual(c.region.samples,[1,4]);
  assert.equal(c.layout.maxDepth,128);assert.equal(c.layout.maxNodes,10000);assert.equal(c.oracle.geometryToleranceCssPx,0.02);
  assert.equal(c.hya.version,1);assert.equal(c.hya.profile,'hya-v1');assert.equal(c.versions.formatChanges,false);
  assert.equal(c.text.storedAndPublicIndexUnit,'UTF-16, preserved API compatibility');assert.equal(c.versions.thirdPartyDependenciesAdded,false);
  assert.equal(c.deviceMatrix.integrationOwner,'g13-integration-release');
  for(const entries of Object.values(c.apiAllocations))for(const a of Object.values(entries)){
    assert.equal(new Set(a.additions).size,a.additions.length);assert.equal(a.maximum,a.baseline+a.additions.length);
  }
  assert.equal(c.apiAllocations['@haiyue/engine']['.'].maximum,30);
  assert.deepEqual(c.sampling.workloads.map(x=>x.nodes),[128,1000,10000]);
  assert.equal(c.acceptance.cpuPhaseLimitsMs.hud.guiUpdateSubmitP95,4);
  assert.equal(c.acceptance.cpuPhaseLimitsMs.diagnostic.layoutP95,null);
  assert.equal(c.acceptance.destroyResidue,0);return c;
}
const finiteSamples=(x,n)=>{assert.equal(x.length,n);assert.ok(x.every(v=>Number.isFinite(v)&&v>=0));};
export function validateBaseline(r,c){
  validateContract(c);assert.equal(r.schemaVersion,1);assert.equal(r.kind,'g01-baseline-diagnostic');assert.equal(r.status,'captured');assert.equal(r.revision,c.sourceRevision);
  assert.ok(r.contractSnapshot);assert.equal(digest(JSON.stringify(r.contractSnapshot)),digest(JSON.stringify(c)));
  assert.equal(r.observations.length,4);assert.deepEqual(r.observations.map(x=>x.id),c.requiredCorrectnessCaseIds);
  for(const x of r.observations){assert.ok(x.differs);assert.notDeepEqual(x.actual,x.expected);}
  assert.equal(r.unicode.actual,'A\ud83dB');assert.equal(r.unicode.expected,'AB');assert.ok(r.unicode.differs);
  assert.equal(r.cpu.length,27);const keys=new Set();
  for(const x of r.cpu){finiteSamples(x.samples,30);assert.ok([128,1000,10000].includes(x.count));assert.ok([0,1,10].includes(x.changePercent));keys.add(`${x.round}/${x.count}/${x.changePercent}`);assert.equal(x.changedNodes,Math.floor((x.count-1)*x.changePercent/100));}
  assert.equal(keys.size,27);assert.equal(r.structural.length,3);
  for(const x of r.structural){finiteSamples(x.unchanged.samples,30);finiteSamples(x.visualMutation.samples,30);assert.equal(x.unchangedLayoutCalls,0);assert.ok(x.visualLayoutCalls>0);
    const a=x.auditInitial,b=x.auditAfterUnchanged;assert.equal(b.uploads.calls-a.uploads.calls,0);assert.ok(b.callCounts['renderPass.draw']>a.callCounts['renderPass.draw']);
    for(const kind of ['buffer','texture'])assert.equal(x.auditAfterDestroy.resources[kind].live,0);
  }
  assert.ok(Object.keys(r.fingerprints).length>10);assert.ok(Object.values(r.fingerprints).every(v=>/^[a-f0-9]{64}$/.test(v)));
  return r;
}
export function validateOracle(r,c){assert.equal(r.status,'passed');assert.equal(r.tolerance,c.oracle.geometryToleranceCssPx);assert.equal(r.results.length,4);for(const x of r.results){assert.ok(x.matches);assert.ok(c.requiredCorrectnessCaseIds.includes(x.id));for(const [i,rect] of x.rectangles.entries())for(const k of ['x','y','width','height'])assert.ok(Math.abs(rect[k]-x.expected[i][k])<=c.oracle.geometryToleranceCssPx);}return r;}
export function validateRegion(r){assert.equal(r.status,'passed');assert.equal(r.qualification,false);assert.ok(r.adapter.vendor);assert.equal(r.validationErrors.length,0);assert.deepEqual(r.cohorts.map(x=>x.samples),[1,4]);for(const x of r.cohorts){finiteSamples(x.cpuMs,120);finiteSamples(x.pacingMs,120);assert.equal(x.pixels.length,2);assert.notDeepEqual(x.pixels[0],x.pixels[1]);assert.equal(x.renderTargetBytes.plannedSidebarResolveRgba8,921600);}return r;}
