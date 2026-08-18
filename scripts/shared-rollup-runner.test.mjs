import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { RollupRunnerError, runRollupOnce } from './shared-rollup-runner.mjs';

const fixture = fileURLToPath(new URL('./test-fixtures/rollup-runner-child.mjs', import.meta.url));

test('shared Rollup runner accepts an exact marker and normal exit', async () => {
  const result = await runFixture('normal');

  assert.equal(result.markersComplete, true);
  assert.equal(result.lingeringHandles, false);
  assert.equal(result.termination, 'none');
  assert.equal(result.exitCode, 0);
});

test('shared Rollup runner recognizes a marker split across output chunks', async () => {
  const result = await runFixture('split-marker');

  assert.deepEqual(result.observedOutputs, ['fixture/bundle.js']);
  assert.equal(result.exitCode, 0);
});

test('shared Rollup runner does not accept a similar output path', async () => {
  const error = await captureRunnerError(() => runFixture('wrong-output'));

  assert.equal(error.kind, 'missing-marker');
  assert.equal(error.result.markersComplete, false);
});

test('shared Rollup runner records and terminates a process retained after its marker', async () => {
  const messages = [];
  const result = await runFixture('interval', {
    logger: collectingLogger(messages),
  });

  assert.equal(result.markersComplete, true);
  assert.equal(result.lingeringHandles, true);
  assert.equal(result.termination, 'sigterm');
  assert.equal(result.exitSignal, 'SIGTERM');
  assert.match(messages.join('\n'), /retained process handles/);
});

test('shared Rollup runner rejects a timeout before any marker', async () => {
  const error = await captureRunnerError(() => runFixture('no-marker', {
    timeoutMs: 80,
    logger: collectingLogger([]),
  }));

  assert.equal(error.kind, 'marker-timeout');
  assert.equal(error.result.markersComplete, false);
});

test('shared Rollup runner preserves a nonzero exit before its marker', async () => {
  const error = await captureRunnerError(() => runFixture('fail'));

  assert.equal(error.kind, 'nonzero-exit');
  assert.equal(error.result.exitCode, 7);
  assert.equal(error.result.markersComplete, false);
});

test('shared Rollup runner does not hide a nonzero exit after its marker', async () => {
  const error = await captureRunnerError(() => runFixture('marker-then-fail'));

  assert.equal(error.kind, 'nonzero-exit');
  assert.equal(error.result.exitCode, 9);
  assert.equal(error.result.markersComplete, true);
});

test('shared Rollup runner SIGKILLs a stubborn process group without an orphan', {
  skip: process.platform === 'win32' ? 'POSIX process groups are required for this assertion.' : false,
}, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'rollup-runner-test-'));
  const pidFile = join(directory, 'grandchild.pid');
  try {
    const result = await runFixture('stubborn-tree', {
      extraArgs: [pidFile],
      logger: collectingLogger([]),
    });
    const grandchildPid = Number.parseInt(readFileSync(pidFile, 'utf8'), 10);

    assert.equal(result.termination, 'sigkill');
    assert.equal(result.exitSignal, 'SIGKILL');
    await assertProcessGone(grandchildPid);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

function runFixture(mode, overrides = {}) {
  const { extraArgs = [], ...runnerOverrides } = overrides;
  const output = { write() {} };
  return runRollupOnce({
    command: process.execPath,
    args: [fixture, mode, ...extraArgs],
    expectedOutputs: ['fixture/bundle.js'],
    label: `fixture ${mode}`,
    timeoutMs: 500,
    exitGraceMs: 30,
    terminateGraceMs: 40,
    killGraceMs: 300,
    stdout: output,
    stderr: output,
    logger: collectingLogger([]),
    ...runnerOverrides,
  });
}

function collectingLogger(messages) {
  return {
    warn(message) { messages.push(message); },
    error(message) { messages.push(message); },
  };
}

async function captureRunnerError(run) {
  try {
    await run();
  } catch (error) {
    assert.ok(error instanceof RollupRunnerError);
    return error;
  }
  assert.fail('Expected runRollupOnce to reject.');
}

async function assertProcessGone(pid) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(isProcessAlive(pid), false, `process ${pid} is still alive`);
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    throw error;
  }
}
