import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import { scanRiveBrowserClosure } from './rive-browser-closure-scan.mjs';

const denyList = {
  forbiddenPackages: ['@rive-app/webgl2'],
  forbiddenFileGlobs: ['**/*.riv', '**/rive.wasm', '**/rive.js'],
  forbiddenStaticPatterns: ['RiveFile'],
  forbiddenNetworkSuffixes: ['.riv', '/rive.wasm'],
};

function createTarGzip(entries) {
  const chunks = [];
  for (const [name, value] of entries) {
    const body = Buffer.from(value);
    const header = Buffer.alloc(512);
    header.write(name, 0, 100, 'utf8');
    writeTarOctal(header, 0o644, 100, 8);
    writeTarOctal(header, 0, 108, 8);
    writeTarOctal(header, 0, 116, 8);
    writeTarOctal(header, body.byteLength, 124, 12);
    writeTarOctal(header, 0, 136, 12);
    header.fill(32, 148, 156);
    header[156] = '0'.charCodeAt(0);
    header.write('ustar\0', 257, 6, 'ascii');
    header.write('00', 263, 2, 'ascii');
    writeTarChecksum(header, header.reduce((sum, byte) => sum + byte, 0));
    chunks.push(header, body, Buffer.alloc((512 - (body.byteLength % 512)) % 512));
  }
  chunks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(chunks));
}

function writeTarOctal(header, value, offset, length) {
  const text = value.toString(8).padStart(length - 1, '0');
  header.write(`${text}\0`, offset, length, 'ascii');
}

function writeTarChecksum(header, value) {
  const text = value.toString(8).padStart(6, '0');
  header.write(`${text}\0 `, 148, 8, 'ascii');
}

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

test('closure scan expands clean packed player tarballs', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'rive-closure-tgz-clean-'));
  const archive = resolve(root, 'player.tgz');
  writeFileSync(archive, createTarGzip([['package/player.js', 'export const format = "HYA1";\n']]));
  const result = scanRiveBrowserClosure({ denyList, artifacts: [{ name: 'packedPlayerTarball', path: archive }] });
  assert.equal(result.scans[0].status, 'passed');
  assert.equal(result.scans[0].fileCount, 1);
  assert.equal(result.scans[0].archiveErrorCount, 0);
  assert.equal(result.scans[0].byteLength, Buffer.byteLength('export const format = "HYA1";\n'));
  assert.ok(result.scans[0].physicalByteLength > 0);
});

test('closure scan exposes forbidden Rive content inside packed player tarballs', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'rive-closure-tgz-red-'));
  const archive = resolve(root, 'player.tgz');
  writeFileSync(archive, createTarGzip([
    ['package/bundle.js', 'import "@rive-app/webgl2"; const source = "RiveFile";\n'],
    ['package/assets/source.riv', 'RIVE'],
  ]));
  const result = scanRiveBrowserClosure({ denyList, artifacts: [{ name: 'packedPlayerTarball', path: archive }] });
  assert.equal(result.scans[0].status, 'failed');
  assert.equal(result.scans[0].archiveErrorCount, 0);
  assert.equal(result.scans[0].forbiddenPackageCount, 1);
  assert.equal(result.scans[0].forbiddenStaticPatternCount, 1);
  assert.equal(result.scans[0].rawRivCount, 1);
});

test('closure scan fails closed for malformed packed player tarballs', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'rive-closure-tgz-malformed-'));
  const archive = resolve(root, 'player.tgz');
  writeFileSync(archive, gzipSync(Buffer.from('not a tar archive')));
  const result = scanRiveBrowserClosure({ denyList, artifacts: [{ name: 'packedPlayerTarball', path: archive }] });
  assert.equal(result.scans[0].status, 'failed');
  assert.equal(result.scans[0].archiveErrorCount, 1);
  assert.match(result.scans[0].matches.archiveErrors[0].message, /no regular files/u);
});

test('closure scan fails closed for unsafe packed player paths', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'rive-closure-tgz-unsafe-'));
  const archive = resolve(root, 'player.tgz');
  writeFileSync(archive, createTarGzip([['../source.riv', 'RIVE']]));
  const result = scanRiveBrowserClosure({ denyList, artifacts: [{ name: 'packedPlayerTarball', path: archive }] });
  assert.equal(result.scans[0].status, 'failed');
  assert.equal(result.scans[0].archiveErrorCount, 1);
  assert.match(result.scans[0].matches.archiveErrors[0].message, /unsafe tar entry path/u);
});
