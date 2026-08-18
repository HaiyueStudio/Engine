import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { parseAnimation } from '../dist/index.js';

const samplesDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'samples');
const manifest = JSON.parse(await readFile(resolve(samplesDirectory, 'manifest.json'), 'utf8'));

test('HYA sample manifest has one unique capability and binary per entry', async () => {
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.kind, 'hya-samples');
  assert.ok(manifest.entries.length >= 8);

  const ids = new Set();
  const capabilities = new Set();
  const files = new Set();
  for (const entry of manifest.entries) {
    assert.match(entry.id, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    assert.ok(entry.title.length > 0);
    assert.ok(entry.category.length > 0);
    assert.ok(entry.description.length > 0);
    assert.match(entry.capability, /^[a-z0-9-]+\/[a-z0-9-]+$/);
    assert.match(entry.file, /^[a-z0-9-]+\.hya$/);
    assert.equal(ids.has(entry.id), false, `duplicate sample id ${entry.id}`);
    assert.equal(capabilities.has(entry.capability), false, `duplicate primary capability ${entry.capability}`);
    assert.equal(files.has(entry.file), false, `duplicate sample file ${entry.file}`);
    ids.add(entry.id);
    capabilities.add(entry.capability);
    files.add(entry.file);

    const bytes = await readFile(resolve(samplesDirectory, entry.file));
    const input = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const animation = parseAnimation(input);
    assert.equal(animation.source, 'binary');
    assert.equal(animation.extensions['org.haiyue.sample@1']?.id, entry.id);
    assert.ok(animation.nodes.length > 0);
    assert.ok(animation.duration > 0);
  }
});

test('HYA samples directory contains no unlisted binary fixture', async () => {
  const diskFiles = (await readdir(samplesDirectory)).filter(file => file.endsWith('.hya')).sort();
  const manifestFiles = manifest.entries.map(entry => entry.file).sort();
  assert.deepEqual(diskFiles, manifestFiles);
});

test('Lottie precomp sample retains nested instances, parent inheritance and timing windows', async () => {
  const animation = await readSample('lottie-precomp-layers');
  const outer = animation.nodes.find(node => node.name === 'Orbit precomp');
  const orbitParent = animation.nodes.find(node => node.name === 'Orbit parent');
  const primary = animation.nodes.find(node => node.name === 'Primary gem');
  const stretched = animation.nodes.find(node => node.name === 'Stretched gem');
  const gemParents = animation.nodes.filter(node => node.name === 'Gem parent');

  assert.equal(orbitParent.parent, outer.id);
  assert.equal(primary.parent, orbitParent.id);
  assert.equal(stretched.parent, orbitParent.id);
  assert.equal(gemParents.length, 2);
  assert.deepEqual(new Set(gemParents.map(node => node.parent)), new Set([primary.id, stretched.id]));
  assert.equal(stretched.start, 0.25);
  assert.equal(stretched.duration, 2.5);
  assert.equal(stretched.transform.opacity, 0.72);
  assert.ok(animation.tracks.some(track => track.node === gemParents[0].id && track.property === 'rotation'));
  assert.ok(animation.tracks.some(track => track.node === gemParents[1].id && track.property === 'rotation'));
});

test('pseudo-3D samples retain their focused projection and depth structures', async () => {
  const cube = await readSample('projected-wire-cube');
  const cubeNode = cube.nodes.find(node => node.id === 'cube');
  assert.equal(cubeNode.components.length, 12);
  assert.ok(cubeNode.components.every(component => component.type === 'org.haiyue.vector-shape@1'));
  assert.ok(cubeNode.components.every(component => component.morph?.valueSize === 4));

  const tunnel = await readSample('depth-tunnel');
  assert.equal(tunnel.nodes.filter(node => node.id.startsWith('tunnel-ring-')).length, 8);
  assert.equal(tunnel.tracks.filter(track => track.node.startsWith('tunnel-ring-')).length, 24);

  const card = await readSample('perspective-card-flip');
  const cardNode = card.nodes.find(node => node.id === 'card');
  assert.equal(cardNode.components.length, 2);
  assert.ok(cardNode.components.every(component => component.morph?.valueSize === 8));
  assert.equal(cardNode.components[0].fill.colorTrack.interpolation, 'step');
});

async function readSample(id) {
  const entry = manifest.entries.find(candidate => candidate.id === id);
  assert.ok(entry, `missing sample manifest entry ${id}`);
  const bytes = await readFile(resolve(samplesDirectory, entry.file));
  return parseAnimation(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}
