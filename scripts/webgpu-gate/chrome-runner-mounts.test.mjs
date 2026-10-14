import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { attachChromeFailureDiagnostics, createIsolatedFixtureTarget, removeChromeProfile, startHttpFixtureServer } from './chrome-runner.mjs';

test('Windows cleanup matches only this profile, executable and process generation', { skip: process.platform !== 'win32' }, () => {
  const executable = resolve(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const output = execFileSync(executable, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
    fileURLToPath(new URL('./chrome-profile-cleanup.test.ps1', import.meta.url))], { encoding: 'utf8', windowsHide: true });
  assert.match(output, /Owned-process policy checks passed: 29/);
});

test('fixture creation targets a fresh nonpersistent context without navigating or warming the engine', async () => {
  const calls = [];
  const cdp = { async call(method, params) {
    calls.push({ method, params });
    return { result: method === 'Target.createBrowserContext' ? { browserContextId: 'owned-context' } : { targetId: 'owned-page' } };
  } };
  assert.deepEqual(await createIsolatedFixtureTarget(cdp), { browserContextId: 'owned-context', targetId: 'owned-page' });
  assert.deepEqual(calls, [
    { method: 'Target.createBrowserContext', params: { disposeOnDetach: true } },
    { method: 'Target.createTarget', params: { url: 'about:blank', browserContextId: 'owned-context', background: false } },
  ]);
});

test('visible fixture context preserves requested window size', async () => {
  let target;
  await createIsolatedFixtureTarget({ async call(method, params) {
    if (method === 'Target.createTarget') target = params;
    return { result: method === 'Target.createBrowserContext' ? { browserContextId: 'context' } : { targetId: 'page' } };
  } }, { mode: 'visible', width: 1320, height: 960 });
  assert.deepEqual(target, { url: 'about:blank', browserContextId: 'context', background: false, newWindow: true, width: 1320, height: 960 });
});

test('missing context identity fails closed rather than selecting the default profile page', async () => {
  for (const browserContextId of [undefined, '', 1]) {
    const calls = [];
    await assert.rejects(createIsolatedFixtureTarget({ async call(method) { calls.push(method); return { result: { browserContextId } }; } }), /isolated browser context/);
    assert.deepEqual(calls, ['Target.createBrowserContext']);
  }
});

test('failed target creation disposes its owned context and preserves the original failure', async () => {
  for (const malformedResult of [false, true]) {
    const methods = [], original = Error('Target creation rejected');
    const cdp = { async call(method) {
      methods.push(method);
      if (method === 'Target.createBrowserContext') return { result: { browserContextId: 'owned' } };
      if (method === 'Target.createTarget') { if (malformedResult) return { result: {} }; throw original; }
      throw Error('Connection closed while disposing');
    } };
    await assert.rejects(createIsolatedFixtureTarget(cdp), error => malformedResult ? /requires a page/.test(error.message) : error === original);
    assert.deepEqual(methods, ['Target.createBrowserContext', 'Target.createTarget', 'Target.disposeBrowserContext']);
  }
});

test('Chrome timeout retains original cause, last progress, browser identity and stderr', () => {
  const original = new Error('Runtime.evaluate timed out');
  const result = attachChromeFailureDiagnostics(original, { url: 'http://127.0.0.1/fixture', browserProduct: 'Chrome/test',
    lastProgress: 'view 3/4', stderr: 'GPU process exited', browserErrors: [{ kind: 'exception', message: 'device lost' }] });
  assert.equal(result, original); assert.equal(result.message, 'Runtime.evaluate timed out');
  assert.equal(result.browserFailure.lastProgress, 'view 3/4');
  assert.equal(result.browserFailure.stderrTruncated, false);
  assert.match(result.stack, /Runtime.evaluate timed out/); assert.match(result.stack, /GPU process exited/);
  assert.match(result.stack, /Chrome\/test/); assert.match(result.stack, /device lost/);
});

test('Chrome failure stderr remains bounded without dropping its final error', () => {
  const result = attachChromeFailureDiagnostics('failed', { stderr: 'x'.repeat(70000) + 'final error' });
  assert.ok(result instanceof Error); assert.equal(result.browserFailure.stderr.length, 65536);
  assert.equal(result.browserFailure.stderrTruncated, true); assert.ok(result.browserFailure.stderr.endsWith('final error'));
});

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

test('Chrome fixture server serves stylesheets with a browser-applicable MIME type', async context => {
  const temporaryRoot = mkdtempSync(resolve(tmpdir(), 'haiyue-chrome-css-'));
  context.after(() => rmSync(temporaryRoot, { recursive: true, force: true }));
  writeFileSync(resolve(temporaryRoot, 'fixture.css'), 'body { color: red; }');
  const server = await startHttpFixtureServer(temporaryRoot);
  context.after(() => server.close());
  const response = await fetch(`${server.origin}/fixture.css`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'text/css; charset=utf-8');
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
