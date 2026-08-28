import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { materializeFormalRiveAsset, validateDeviceMatrixEnvironment } from './rive-run-device-matrix.mjs';

test('device matrix materializes hash-pinned local official bytes without vendoring them', async t => {
  const temporary = mkdtempSync(resolve(tmpdir(), 'rive-device-matrix-'));
  const source = resolve(temporary, 'source');
  const output = resolve(temporary, 'output');
  mkdirSync(source); mkdirSync(output);
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const bytes = Buffer.from('RIVE fixture');
  writeFileSync(resolve(source, 'fixture.riv'), bytes);
  const asset = {
    id: 'official-fixture', riv: {
      sourceUrl: 'https://raw.githubusercontent.com/rive-app/rive-runtime/revision/fixture.riv',
      sha256: createHash('sha256').update(bytes).digest('hex'), byteLength: bytes.byteLength,
    },
  };
  const result = await materializeFormalRiveAsset(asset, { temporaryDirectory: output, sourceDirectory: source, fetchImpl: null });
  assert.equal(result.source, 'local-cache:fixture.riv');
  assert.equal(result.sha256, asset.riv.sha256);
  assert.equal(result.byteLength, bytes.byteLength);

  writeFileSync(resolve(source, 'fixture.riv'), Buffer.from('changed'));
  await assert.rejects(materializeFormalRiveAsset(asset, { temporaryDirectory: output, sourceDirectory: source, fetchImpl: null }), /byte length mismatch|SHA-256 mismatch/u);
});

test('device matrix rejects claimed environments that are not physical Windows 10+ zero-error captures', () => {
  const environment = {
    deviceClass: 'windows-10-plus-device-a', browser: 'chrome', physicalDevice: true,
    browserLogCaptured: true, consoleErrorCount: 0, exceptionCount: 0, os: 'Windows 10 22H2',
  };
  assert.equal(validateDeviceMatrixEnvironment(environment, { deviceClass: environment.deviceClass, browser: environment.browser }).physicalDevice, true);
  assert.throws(() => validateDeviceMatrixEnvironment({ ...environment, os: 'Windows 9', consoleErrorCount: 1 }, {
    deviceClass: environment.deviceClass, browser: environment.browser,
  }), /Windows 10 or later|consoleErrorCount/u);
});
