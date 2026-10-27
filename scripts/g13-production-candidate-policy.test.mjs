import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {g13ProductionPlan} from './g13-production-candidate-policy.mjs';
import {createReleaseGateChecks} from './release-gate-policy.mjs';
const root=fileURLToPath(new URL('..',import.meta.url));
test('run identities cannot escape or reuse arbitrary artifact paths',()=>{
  for(const id of ['','../other','1793059045652-ABCD1234','1793059045652-1234abcd/old'])assert.throws(()=>g13ProductionPlan(root,id,()=>{throw Error('must not read')}),/identity/);
});
test('changed qualified report fails before invoking a sampler',()=>{
  assert.throws(()=>g13ProductionPlan(root,'1793059045652-1234abcd',()=>Buffer.from('{}')),/report changed/);
});
test('independent terminal uses installed Windows PowerShell and the shared bounded wait',()=>{
  const cmd=readFileSync(new URL('start-g13-production-70187df.cmd',import.meta.url),'utf8'),ps=readFileSync(new URL('start-g13-production.ps1',import.meta.url),'utf8');
  assert.match(cmd,/System32\\WindowsPowerShell\\v1\.0\\powershell\.exe/);assert.doesNotMatch(cmd,/pwsh|Get-FileHash/);assert.match(cmd,/pause/);
  assert.match(ps,/framegraph-background-policy\.ps1/);assert.match(ps,/Wait-G09GpuDiagnosticStart -TimeoutSeconds 300/);
  assert.ok(ps.indexOf('Wait-G09GpuDiagnosticStart -TimeoutSeconds 300')<ps.indexOf('scripts/run-g13-production-candidate.mjs --run'));
  assert.doesNotMatch(ps,/Stop-Process|Stop-Service|Set-ItemProperty|Start-G09Power/);
});
test('the independent production run grants no global or publication qualification',()=>{
  const worker=readFileSync(new URL('run-g13-production-candidate.mjs',import.meta.url),'utf8');
  assert.match(worker,/raw\.diagnostic!==false/);assert.match(worker,/raw\.captures\?\.length!==30/);
  assert.match(worker,/git\(\['status','--porcelain'\]\)/);assert.match(worker,/finally\{closeSync/);
  assert.match(worker,/Assert-G09GpuDiagnosticReady/);
  assert.match(worker,/assessProductionCapture\(original,raw\.plan\[index\],budget\)/);
  assert.match(worker,/assert\.deepEqual\(raw\.plan,productionCapturePlan\(\)\)/);
  assert.ok(worker.indexOf('Assert-G09GpuDiagnosticReady')<worker.indexOf('spawnSync(process.execPath'));
  assert.ok(createReleaseGateChecks('global').some(args=>args.includes('release:render:evidence:check')));
});
