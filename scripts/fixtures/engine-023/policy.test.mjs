import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {validateContract,validateDiagnosticReports,validateFileReference,hashBytes} from './policy.mjs';
const root=resolve(import.meta.dirname,'../../..');
const read=p=>readFileSync(resolve(root,p));const json=p=>JSON.parse(read(p));
const contract=json('config/gameplay-023-contract.json'),source=read(contract.api.declarations).toString();
const baseline=json('review/engine-0.2.3/api-baseline-0.2.2.json');
// Synthetic unit-test records; actual physical reports are validated by verify.mjs.
const reports={source:{qualification:false,status:'completed-expected-baseline-observations',checks:[{id:'box2d-real-shape-sweep',actual:{sweep:[{id:'initial-overlap-needs-distance-check',point:null},...Array.from({length:9},()=>({}))],manifolds:Array(6).fill({}),rawPointAssignmentDefect:true}},...Array(8).fill({})]},cpu:{qualification:false,cpu:Array.from({length:27},()=>({samples:Array(30).fill(.1)})),structural:Array.from({length:3},()=>({unchangedLayoutCalls:0,visualLayoutCalls:0,auditAfterDestroy:{resources:{buffer:{live:0},texture:{live:0}}}}))},native:{qualification:false,status:'passed',adapter:{vendor:'nvidia',architecture:'pascal'},validationErrors:[],cohorts:Array.from({length:2},()=>({warmupFrames:60,measuredFrames:120,cpuMs:Array(120).fill(.1)}))},icons:{qualification:false,status:'passed',cases:Array.from({length:8},(_,i)=>({targetOnly:i>=4}))},published:{receiptSha256:'0aff32d45c727b85cae88de8109d50008225acdcad33db9968e71d9440ccfa43',packages:Array(4).fill({version:'0.2.2'})}};

test('complete admitted contract and synthetic policy fixtures',()=>{assert.equal(validateContract(contract,source,baseline).admittedSymbols,69);assert.equal(validateDiagnosticReports(reports).sweeps,10);});
for(const [name,mutate] of [
  ['missing user GUI capability',c=>c.gui.requiredCapabilities.pop()],
  ['root expansion',c=>c.api.rootExportCount++],
  ['unassigned extra symbol allowance',c=>c.api.entries[0].unusedSymbolReserve=1],
  ['inflated exact export target',c=>c.api.entries[1].targetExportCount++],
  ['silent format bump',c=>c.versions.formatChanges=true],
  ['mandatory custom backend break',c=>c.backend.optionalDriverCapability=false],
  ['invalid upstream point reuse',c=>c.backend.rawOutputPointUsable=true],
  ['unbounded collection',c=>c.limits.collections.maxItemsMax=Infinity],
  ['hidden scene sampling population change',c=>c.sampling.mutationsPercent=[0]],
  ['GPU budget relaxation',c=>c.acceptance.gpuRegressionPercent=10],
  ['inherited CPU limit relaxation',c=>c.acceptance.cpuPhaseLimitsMs.hud.guiUpdateSubmitP95=8],
  ['missing device owner',c=>c.deviceMatrix.owner=null],
  ['permitted borrowed content destruction',c=>c.gui.contentOwnership='owned'],
  ['hash reuse blanket permission',c=>c.reuse.status='all-approved']
])test('reject '+name,()=>{const c=structuredClone(contract);mutate(c);assert.throws(()=>validateContract(c,source,baseline));});
test('reject changed declaration despite a recomputed hash',()=>{const c=structuredClone(contract),s=source.replace('export type GuiIconPosition','export type UnadmittedIconPosition');c.api.declarationSha256=hashBytes(s);assert.throws(()=>validateContract(c,s,baseline));});
for(const [name,mutate] of [
 ['diagnostic promoted to qualification',r=>r.native.qualification=true],
 ['truncated sweep evidence',r=>r.source.checks.find(c=>c.id==='box2d-real-shape-sweep').actual.sweep.pop()],
 ['missing measured samples',r=>r.cpu.cpu[0].samples.pop()],
 ['residual GPU buffer',r=>r.cpu.structural[0].auditAfterDestroy.resources.buffer.live=1],
 ['missing native validation channel',r=>delete r.native.validationErrors],
 ['unavailable adapter labeled native',r=>r.native.adapter.vendor='google'],
 ['unimplemented right icon labeled existing',r=>r.icons.cases.find(c=>c.targetOnly).targetOnly=false]
])test('reject '+name,()=>{const r=structuredClone(reports);mutate(r);assert.throws(()=>validateDiagnosticReports(r));});
test('evidence byte mismatch and escape rejected',()=>{const bytes=Buffer.from('original');const ref={path:'artifacts/engine-0.2.3/g01/test.json',sha256:hashBytes(bytes)};validateFileReference(ref,()=>bytes);assert.throws(()=>validateFileReference(ref,()=>Buffer.from('changed')));for(const path of ['../source','D:/source','/source','a/../source','a\\source'])assert.throws(()=>validateFileReference({...ref,path},()=>bytes));});

test('reject a new namespace or root export even when hash is recomputed',()=>{for(const extra of ['\nexport namespace Unadmitted {export interface Extra {}}','\nexport interface Extra {}']){const c=structuredClone(contract),s=source+extra;c.api.declarationSha256=hashBytes(s);assert.throws(()=>validateContract(c,s,baseline));}});
