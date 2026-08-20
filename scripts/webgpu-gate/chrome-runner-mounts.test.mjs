import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';

import { removeChromeProfile, startHttpFixtureServer } from './chrome-runner.mjs';

test('Chrome fixture server mounts a sibling content root without exposing its parent', async context => {
  const temporaryRoot = mkdtempSync(resolve(tmpdir(), 'haiyue-chrome-mount-'));
  context.after(() => rmSync(temporaryRoot, { recursive: true, force: true }));
  const engineRoot = resolve(temporaryRoot, 'Engine');
  const gamesRoot = resolve(temporaryRoot, 'Games', 'games');
  mkdirSync(engineRoot, { recursive: true });
  mkdirSync(gamesRoot, { recursive: true });
  writeFileSync(resolve(engineRoot, 'fixture.html'), '<p>fixture</p>');
  writeFileSync(resolve(gamesRoot, 'scene.json'), '{"scene":true}');

  const server = await startHttpFixtureServer(engineRoot, {
    mounts: [{ prefix: '/games', directory: gamesRoot }],
  });
  context.after(() => server.close());

  const response = await fetch(`${server.origin}/games/scene.json`);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), '{"scene":true}');
  assert.deepEqual(server.provenance().files, [{
    sourcePath: 'games/scene.json',
    byteLength: 14,
    sha256: 'ec8d6be752f7d45c4ff043ef8637c3450354620e504d12e6e23d194b875a0120',
    requestCount: 1,
  }]);
  assert.equal((await fetch(`${server.origin}/games/../outside.txt`)).status, 404);
});

test('Chrome fixture server rejects unsafe mount prefixes', async () => {
  assert.rejects(
    startHttpFixtureServer(process.cwd(), {
      mounts: [{ prefix: '/../escape', directory: process.cwd() }],
    }),
    /mount prefix/,
  );
});

test('Chrome profile cleanup retries transient Windows locks and reports attempts', async () => {
  let attempts = 0;
  const result = await removeChromeProfile('ignored-test-profile', {
    maxAttempts: 3,
    retryDelayMs: 0,
    remove() {
      attempts++;
      if (attempts < 3) throw Object.assign(new Error('profile locked'), { code: 'EPERM' });
    },
  });

  assert.equal(attempts, 3);
  assert.equal(result.status, 'passed');
  assert.equal(result.attempts, 3);
});

test('Chrome profile cleanup rejects a persistent residual', async () => {
  await assert.rejects(
    removeChromeProfile('ignored-test-profile', {
      maxAttempts: 2,
      retryDelayMs: 0,
      remove() {
        throw Object.assign(new Error('profile still locked'), { code: 'EBUSY' });
      },
    }),
    error => error.code === 'EBUSY' && /after 2 attempts/u.test(error.message),
  );
});
