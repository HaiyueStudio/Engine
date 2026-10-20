import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
const root=fileURLToPath(new URL('../..',import.meta.url));
const windows={skip:process.platform!=='win32'?'Windows PowerShell controller':false};
function run(scenario){
 const shell=resolve(process.env.SystemRoot??'C:/Windows','System32/WindowsPowerShell/v1.0/powershell.exe');
 const output=execFileSync(shell,['-NoProfile','-File',resolve(root,'scripts/webgpu-gate/framegraph-gpu-power-control.fixture.ps1'),'-Scenario',scenario,'-OutputDirectory',resolve(root,'artifacts/engine-0.2.1/g09','gpu-controller-policy-'+randomUUID())],{encoding:'utf8',windowsHide:true,timeout:30000});
 const line=output.split(/\r?\n/).find(x=>x.startsWith('GPU_TEST_RESULT='));
 assert.ok(line,output);return JSON.parse(line.slice('GPU_TEST_RESULT='.length));
}
test('Chrome policy restores default or existing user value after success and capture failure',windows,()=>{
 for(const mode of ['success-default','success-override','capture-failure']){
  const r=run(mode);assert.equal(r.journal.restored,true);assert.deepEqual(r.after,r.before);assert.equal(Boolean(r.failure),mode==='capture-failure');assert.equal(r.journal.during.Value,1);
 }
});
test('partial save and readback failures restore before returning failure',windows,()=>{
 for(const mode of ['write-failure','readback-mismatch']){const r=run(mode);assert.ok(r.failure);assert.equal(r.journal.restored,true);assert.deepEqual(r.after,r.before);}
});
test('failed GPU restoration is recorded and an external change is not overwritten',windows,()=>{
 const failed=run('restoration-failure');assert.match(failed.failure,/restoration/);assert.equal(failed.journal.restored,false);assert.equal(failed.after.Value,1);
 const foreign=run('foreign-change');assert.match(foreign.failure,/externally/);assert.equal(foreign.journal.restored,false);assert.equal(foreign.after.Value,2);assert.equal(foreign.writes,1);
});
test('multi-application Chrome profile is rejected without writes',windows,()=>{
 const r=run('shared-profile');assert.ok(r.failure);assert.equal(r.writes,0);assert.equal(r.journal,null);assert.deepEqual(r.after,r.before);
});