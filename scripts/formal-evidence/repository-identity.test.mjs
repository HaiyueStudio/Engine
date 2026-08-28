import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertFormalRepositoryIdentity,
  captureRepositoryIdentity,
  formalRepositoryIdentityViolations,
} from './repository-identity.mjs';

test('captures the revision and complete porcelain status', () => {
  const calls = [];
  const snapshot = captureRepositoryIdentity('D:/repo', {
    execFileSync(command, args, options) {
      calls.push({ command, args, options });
      return args.includes('rev-parse') ? 'a'.repeat(40) + '\n' : ' M source.ts\n?? fixture.riv\n';
    },
  });
  assert.deepEqual(snapshot, {
    revision: 'a'.repeat(40),
    status: 'M source.ts\n?? fixture.riv',
    dirty: true,
  });
  assert.deepEqual(calls.map(value => value.args), [
    ['-C', 'D:/repo', 'rev-parse', 'HEAD'],
    ['-C', 'D:/repo', 'status', '--porcelain=v1', '--untracked-files=all'],
  ]);
});

test('accepts a clean repository that remains at the same revision', () => {
  const snapshot = { revision: 'a'.repeat(40), status: '', dirty: false };
  assert.deepEqual(formalRepositoryIdentityViolations(snapshot, snapshot, { label: 'Engine' }), []);
  assert.doesNotThrow(() => assertFormalRepositoryIdentity(snapshot, snapshot, { label: 'Engine' }));
});

test('rejects dirty, revision-changing, and worktree-changing runs', () => {
  const start = { revision: 'a'.repeat(40), status: ' M before.ts', dirty: true };
  const end = { revision: 'b'.repeat(40), status: ' M after.ts', dirty: true };
  const violations = formalRepositoryIdentityViolations(start, end, { label: 'Engine' });
  assert.deepEqual(violations, [
    'Engine worktree is dirty',
    `Engine revision changed during the run (${'a'.repeat(40)} -> ${'b'.repeat(40)})`,
    'Engine worktree changed during the run',
  ]);
  assert.throws(
    () => assertFormalRepositoryIdentity(start, end, { label: 'Engine' }),
    /Formal evidence repository identity check failed:[\s\S]*Engine revision changed during the run/u,
  );
});
