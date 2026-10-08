import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
const root=fileURLToPath(new URL('../..',import.meta.url));
const windows={skip:process.platform!=='win32'?'Windows power controller':false};
function run(scenario){
  const shell=resolve(process.env.SystemRoot??'C:/Windows','System32/WindowsPowerShell/v1.0/powershell.exe');
  const stdout=execFileSync(shell,['-NoProfile','-File',resolve(root,'scripts/webgpu-gate/framegraph-power-control.fixture.ps1'),'-Scenario',scenario,'-OutputDirectory',resolve(root,'artifacts/engine-0.2.1/g09',`power-test-${randomUUID()}`)],{encoding:'utf8',windowsHide:true,timeout:30000});
  const line=stdout.split(/\r?\n/).find(s=>s.startsWith('POWER_TEST_RESULT='));assert.ok(line,stdout);
  return JSON.parse(line.slice('POWER_TEST_RESULT='.length));
}
test('controlled scheme changes only its copy and restores after success/capture failure',windows,()=>{
  for(const scenario of ['success','capture-failure']){const r=run(scenario);assert.equal(r.record.during.minimumAcPercent,100);assert.equal(r.record.before.minimumAcPercent,5);assert.equal(r.record.after.minimumAcPercent,5);assert.equal(r.record.restored,true);assert.equal(r.record.removed,true);assert.equal(r.copyExists,false);assert.equal(r.active,r.record.original);assert.equal(Boolean(r.failure),scenario!=='success');}
});
test('activation and readback failures restore without beginning a capture',windows,()=>{
  for(const scenario of ['activation-failure','readback-mismatch']){const r=run(scenario);assert.ok(r.failure);assert.equal(r.record.restored,true);assert.equal(r.record.removed,true);assert.equal(r.copyExists,false);}
});
test('failed restoration never deletes the active scheme, and cleanup errors stay failures',windows,()=>{
  const restore=run('restoration-failure');assert.match(restore.failure,/restoration/);assert.equal(restore.record.restored,false);assert.equal(restore.copyExists,true);assert.ok(restore.calls.every(c=>!c.startsWith('/delete')));
  const remove=run('deletion-failure');assert.match(remove.failure,/deletion/);assert.equal(remove.record.restored,true);assert.equal(remove.record.removed,false);assert.equal(remove.copyExists,true);
});
test('battery or limited maximum processor state is rejected without power writes',windows,()=>{
  for(const scenario of ['battery','max-limited']){const r=run(scenario);assert.ok(r.failure);assert.deepEqual(r.calls,[]);assert.equal(r.record,null);assert.equal(r.copyExists,false);}
});
