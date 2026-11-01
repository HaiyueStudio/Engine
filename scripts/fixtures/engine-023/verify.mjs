import assert from 'node:assert/strict';
import {readFileSync,realpathSync} from 'node:fs';
import {resolve,relative,isAbsolute} from 'node:path';
import {validateContract,validateDiagnosticReports,validateFileReference} from './policy.mjs';

const root=resolve(import.meta.dirname,'../../..');
const read=p=>{const path=realpathSync(resolve(root,p)),rel=relative(root,path);assert.ok(rel&&!rel.startsWith('..')&&!isAbsolute(rel),'evidence escapes repository');return readFileSync(path);};
const json=p=>JSON.parse(read(p));
const c=json('config/gameplay-023-contract.json');
validateFileReference({path:c.api.baseline,sha256:c.api.baselineSha256},read);
const contract=validateContract(c,read(c.api.declarations).toString(),json('review/engine-0.2.3/api-baseline-0.2.2.json'));
const reports={source:json('artifacts/engine-0.2.3/g01/source-probes-current.json'),cpu:json('artifacts/engine-0.2.3/g01/cpu-baseline.json'),native:json('artifacts/engine-0.2.3/g01/native-reference.json'),icons:json('artifacts/engine-0.2.3/g01/icon-oracle.json'),published:json('artifacts/engine-0.2.3/g01/published/verification.json')};
const diagnostics=validateDiagnosticReports(reports);
for(const r of [reports.source,reports.native,reports.icons])for(const input of r.inputs)validateFileReference(input,read);
for(const [path,sha256] of Object.entries(reports.cpu.fingerprints))validateFileReference({path,sha256},read);
for(const [path,sha256] of Object.entries(reports.cpu.built))validateFileReference({path,sha256},read);
for(const p of reports.published.packages)validateFileReference({path:'artifacts/engine-0.2.3/g01/published/'+p.package.replace('@haiyue/','')+'-0.2.2.tgz',sha256:p.sha256},read);
if(process.argv.includes('--manifest')){
  const checks=json('review/engine-0.2.3/g01-checks.json');
  assert.equal(checks.goalStatus,'complete');assert.equal(checks.releaseQualified,false);
  for(const f of checks.files)validateFileReference(f,read);
  for(const v of checks.validations)assert.equal(v.exitCode,0,v.id);
  assert.ok(checks.deviceHandoffs.every(h=>h.owner==='g11-integration-candidate'&&h.status==='required-before-candidate-completion'));
}
console.log(JSON.stringify({status:'passed',qualification:false,contract,diagnostics,manifestChecked:process.argv.includes('--manifest')}));
