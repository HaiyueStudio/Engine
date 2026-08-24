import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { scanRiveBrowserClosure } from './rive-browser-closure-scan.mjs';

const denyList = {
  forbiddenPackages: ['@rive-app/webgl2'],
  forbiddenFileGlobs: ['**/*.riv', '**/rive.wasm', '**/rive.js'],
  forbiddenStaticPatterns: ['RiveFile'],
  forbiddenNetworkSuffixes: ['.riv', '/rive.wasm'],
};

test('closure scan accepts a source-neutral HYA bundle and network log', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'rive-closure-clean-'));
  writeFileSync(resolve(root, 'player.js'), 'export const format = "HYA1";\n');
  const network = resolve(root, 'network.json');
  writeFileSync(network, JSON.stringify([{ url: 'https://app.invalid/animation.hya' }]));
  const result = scanRiveBrowserClosure({
    denyList,
    artifacts: [
      { name: 'browserBundle', path: root },
      { name: 'networkRequests', path: network },
    ],
  });
  assert.deepEqual(result.scans.map(value => value.status), ['passed', 'passed']);
  assert.equal(result.unclassifiedFailureCount, 0);
});

test('closure scan exposes packages, raw RIV, runtime files, static symbols and network requests', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'rive-closure-red-'));
  mkdirSync(resolve(root, 'assets'));
  writeFileSync(resolve(root, 'bundle.js'), 'import "@rive-app/webgl2"; const source = "RiveFile";\n');
  writeFileSync(resolve(root, 'assets', 'source.riv'), 'RIVE');
  writeFileSync(resolve(root, 'rive.wasm'), new Uint8Array([0, 97, 115, 109]));
  const network = resolve(root, 'network.json');
  writeFileSync(network, JSON.stringify([{ url: 'https://app.invalid/source.riv' }, { url: 'https://app.invalid/rive.wasm' }]));
  const result = scanRiveBrowserClosure({
    denyList,
    artifacts: [
      { name: 'browserBundle', path: root },
      { name: 'networkRequests', path: network },
    ],
  });
  assert.deepEqual(result.scans.map(value => value.status), ['failed', 'failed']);
  assert.equal(result.scans[0].forbiddenPackageCount, 1);
  assert.ok(result.scans[0].forbiddenFileCount >= 2);
  assert.equal(result.scans[0].forbiddenStaticPatternCount, 1);
  assert.equal(result.scans[0].rawRivCount, 1);
  assert.equal(result.scans[1].forbiddenNetworkCount, 2);
});
