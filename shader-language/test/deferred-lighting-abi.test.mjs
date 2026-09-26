import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { generateDeferredLightingAbi } from '../scripts/generate-deferred-lighting-abi.mjs';
const source = await readFile(new URL('../../engine/src/shaders/generated/deferred-lighting-abi.generated.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText;
const abi = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);

test('Deferred ABI generation is deterministic and host/reflection/WGSL share the frozen layouts', async () => {
  await generateDeferredLightingAbi();
  const { blocks } = abi.DEFERRED_LIGHTING_ABI;
  assert.equal(blocks.sourceHeader.byteSize, 16);
  assert.equal(blocks.light.byteSize, 64);
  assert.equal(blocks.viewHeader.byteSize, 32);
  assert.deepEqual(blocks.light.fields.map(f => f.offset), [0, 16, 32, 48]);
  assert.match(abi.DEFERRED_LIGHTING_ABI_WGSL, /identity: vec4<u32>/);
  const bytes = new ArrayBuffer(128), out = new DataView(bytes);
  abi.writeDeferredLightRecord(out, 16, { positionRange: [1, 2, 3, 4], radiance: [.2, .4, .6, 0],
    direction: [0, -1, 0, 0], identity: [2, 0xabcdef01, 0xffffffff, 0] });
  assert.equal(out.getUint32(68, true), 0xabcdef01);
  assert.equal(out.getUint32(72, true), 0xffffffff);
  assert.equal(out.getFloat32(28, true), 4);
});

test('generated writers reject unaligned/truncated destinations, wrapped IDs and non-finite floats', () => {
  const out = new DataView(new ArrayBuffer(80));
  const header = { abiVersion: 1, sourceGeneration: 1, pointCount: 0, directionalCount: 0 };
  assert.throws(() => abi.writeDeferredSourceHeader(out, 4, header), /destination/);
  assert.throws(() => abi.writeDeferredSourceHeader(out, 80, header), /destination/);
  assert.throws(() => abi.writeDeferredSourceHeader(out, 0, { ...header, sourceGeneration: 2 ** 32 }), /u32/);
  assert.throws(() => abi.writeDeferredViewHeader(out, 0, { sourceGeneration: 1, pointCount: 0, directionalCount: 0, flags: 0,
    ambientRadiance: [1e40, 0, 0, 0] }), /f32/);
});
