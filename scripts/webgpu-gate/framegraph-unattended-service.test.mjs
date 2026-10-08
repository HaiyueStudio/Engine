import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { resolve, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
const root = fileURLToPath(new URL('../..', import.meta.url));
const candidates = [...(process.env.PATH ?? '').split(delimiter).map(p=>resolve(p,'pwsh.exe')),
  resolve(process.env.ProgramFiles ?? 'C:/Program Files','PowerShell/7/pwsh.exe'),
  resolve(process.env.USERPROFILE ?? 'C:/Users/Administrator','.cache/codex-runtimes/codex-primary-runtime/dependencies/native/powershell/pwsh.exe')];
const shell = candidates.find(existsSync);
function run(state, mode, ...flags) {
  assert.ok(shell, 'PowerShell 7 is required for Windows service orchestration tests');
  const out = resolve(root, 'artifacts/engine-0.2.1/g09', `service-test-${randomUUID()}`);
  const stdout = execFileSync(shell, ['-NoProfile', '-File', resolve(root, 'scripts/webgpu-gate/framegraph-unattended-service.fixture.ps1'),
    '-InitialState', state, '-InitialMode', mode, '-OutputDirectory', out, ...flags], { encoding:'utf8', timeout:30000, windowsHide:true });
  const line = stdout.split(/\r?\n/).find(s=>s.startsWith('SERVICE_TEST_RESULT='));
  assert.ok(line, stdout); return JSON.parse(line.slice('SERVICE_TEST_RESULT='.length));
}
const windowsOnly = { skip:process.platform !== 'win32' ? 'Windows Search orchestration requires PowerShell on Windows' : false };
test('already stopped/disabled Search runs isolation without any service mutation', windowsOnly, () => {
  const r = run('Stopped','Disabled');
  assert.equal(r.failure,null); assert.deepEqual(r.calls,[]);
  assert.equal(r.record.captureExitCode,0); assert.equal(r.record.samplingStarted,false);
  assert.equal(r.record.serviceCheckOnly,true); assert.equal(r.record.restored,true);
  assert.equal(r.final.State,'Stopped'); assert.equal(r.final.StartMode,'Disabled');
});
test('running and stopped Search restore each original startup and delayed-start setting', windowsOnly, () => {
  for (const [state,mode,flags] of [['Running','Auto',[]],['Stopped','Auto',[]],['Stopped','Manual',[]],['Running','Disabled',[]],['Stopped','Auto',['-MissingDelayedStart']]]) {
    const r = run(state,mode,...flags);
    assert.equal(r.failure,null); assert.equal(r.record.restored,true); assert.equal(r.record.captureExitCode,0);
    assert.deepEqual(r.record.startupAfter,r.record.startupBefore);
    assert.equal(r.final.State,state); assert.equal(r.final.StartMode,mode);
    assert.equal(r.calls.some(c=>c.startsWith('StartService')),state==='Running');
    assert.equal(r.calls.some(c=>c.startsWith('StopService')),state==='Running');
  }
});
test('isolation failures retain the error and restore the original service configuration', windowsOnly, () => {
  for (const flag of ['-FailDisable','-FailStop']) {
    const r = run('Running','Auto',flag);
    assert.match(r.failure,/Could not prevent WSearch restart|StopService failed/);
    assert.equal(r.record.failure,r.failure); assert.equal(r.record.captureExitCode,1);
    assert.equal(r.record.samplingStarted,false); assert.equal(r.record.restored,true);
    assert.equal(r.final.State,'Running'); assert.equal(r.final.StartMode,'Auto');
    assert.deepEqual(r.record.startupAfter,r.record.startupBefore);
  }
});
