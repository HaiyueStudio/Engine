import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const corpusRoot = new URL('../../scripts/webgpu-gate/assets/gltf-corpus/', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('manifest.json', corpusRoot), 'utf8'));

test('production glTF corpus pins upstream provenance, license, byte length, and SHA-256', async () => {
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.upstream.repository, 'https://github.com/KhronosGroup/glTF-Sample-Assets');
  assert.match(manifest.upstream.commit, /^[a-f0-9]{40}$/);
  assert.deepEqual(manifest.tiers.map(tier => tier.id), ['small', 'medium', 'large']);

  let corpusBytes = 0;
  for (const tier of manifest.tiers) {
    assert.ok(['CC0-1.0', 'CC-BY-4.0'].includes(tier.license));
    assert.ok(tier.attribution.length > 0);
    assert.ok(tier.gate.firstVisibleFrameMaxMs > 0);
    for (const file of tier.files) {
      const bytes = await readFile(new URL(file.path, corpusRoot));
      corpusBytes += bytes.byteLength;
      assert.equal(bytes.byteLength, file.bytes, `${file.path} byte length`);
      assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256, `${file.path} SHA-256`);
    }
  }
  assert.ok(corpusBytes > 10 * 1024 * 1024, `expected a production-size corpus, received ${corpusBytes} bytes`);
});

test('production glTF tiers characterize morph, Draco skin, and KTX2 multi-material coverage', async () => {
  const assets = new Map();
  for (const tier of manifest.tiers) {
    const bytes = await readFile(new URL(tier.entry, corpusRoot));
    assets.set(tier.id, tier.entry.endsWith('.glb') ? parseGlbJson(bytes) : JSON.parse(bytes));
  }

  const small = assets.get('small');
  assert.equal(small.meshes.length, 1);
  assert.equal(small.animations.length, 1);
  assert.equal(small.meshes[0].primitives[0].targets.length, 2);

  const medium = assets.get('medium');
  assert.deepEqual(medium.extensionsRequired, ['KHR_draco_mesh_compression']);
  assert.equal(medium.skins.length, 1);
  assert.equal(medium.animations.length, 1);
  assert.ok(medium.nodes.length >= 20);

  const large = assets.get('large');
  assert.ok(large.extensionsRequired.includes('KHR_texture_basisu'));
  assert.equal(large.meshes.length, 8);
  assert.equal(large.materials.length, 13);
  assert.equal(large.textures.length, 19);
  assert.equal(large.images.length, 19);
  assert.ok(large.images.every(image => image.mimeType === 'image/ktx2'));
});

function parseGlbJson(bytes) {
  assert.equal(bytes.readUInt32LE(0), 0x46546c67);
  assert.equal(bytes.readUInt32LE(4), 2);
  const jsonLength = bytes.readUInt32LE(12);
  assert.equal(bytes.readUInt32LE(16), 0x4e4f534a);
  return JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLength)).replace(/\0+$/u, ''));
}
