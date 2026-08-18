import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const rendererDir = new URL('../src/renderer/', import.meta.url);
const targetRenderers = [
  'Mesh3DRenderer.ts',
  'DepthRenderer.ts',
  'NormalRenderer.ts',
  'PbrRenderer.ts',
  'BlinnPhongRenderer.ts',
  'ToonRenderer.ts',
  'VolumeRenderer.ts',
  'InstancedMesh3DRenderer.ts',
];

test('all M2.5 renderer targets delegate lifecycle ownership to ParameterizedRendererCore', async () => {
  for (const file of targetRenderers) {
    const source = await readFile(new URL(file, rendererDir), 'utf8');
    assert.match(source, /ParameterizedRendererCore/, `${file} must consume the shared core`);
    assert.doesNotMatch(source, /new RendererObjectTable\s*\(/, `${file} must not recreate object-table ownership`);
  }
});

test('all CPU renderer depth paths consume the shared typed quantizer', async () => {
  const transparent = await readFile(new URL('TransparentMegaBatch.ts', rendererDir), 'utf8');
  const gpuDriven = await readFile(new URL('../systems/Render3DGpuDrivenBatchBuilder.ts', rendererDir), 'utf8');
  const instanced = await readFile(new URL('../systems/InstancedMesh3DRenderSystem.ts', rendererDir), 'utf8');
  assert.match(transparent, /DepthSortPolicy/);
  assert.match(gpuDriven, /DepthSortPolicy/);
  assert.match(instanced, /DepthSortPolicy/);
  assert.doesNotMatch(`${transparent}\n${gpuDriven}\n${instanced}`, /viewDepth\s*\*\s*(?:16|1024)/);
});

test('Render3D planned views reuse camera-frame work and remove no-op lifecycle owners', async () => {
  const system = await readFile(new URL('../systems/Render3DSystem.ts', rendererDir), 'utf8');
  const transparent = await readFile(new URL('../systems/Render3DTransparentOrchestrator.ts', rendererDir), 'utf8');
  assert.match(system, /plannedView\?\.cameraFrame/);
  assert.match(system, /_materialContextScratch\.reset\(\)/);
  assert.doesNotMatch(transparent, /destroy\(\): void \{\s*\}/);
});
