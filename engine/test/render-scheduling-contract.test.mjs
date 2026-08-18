import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const plan = await source('../src/renderer/frame-plan/RenderFramePlan.ts');
const compatibility = await source('../src/renderer/frame-plan/RenderPassCompatibility.ts');
const pipeline = await source('../src/renderer/RenderPipeline.ts');
const graph = await source('../src/core/RenderGraph.ts');
const integration = await source('../src/renderer/RenderIntegration.ts');

test('frame plan compiler is device-free and RenderPipeline consumes it as the only entry-order owner', () => {
  assert.match(plan, /class RenderFramePlanCompiler/);
  assert.match(plan, /readonly items: readonly RenderFramePlanItem/);
  assert.doesNotMatch(plan, /GPUDevice|GPUCommand|RenderCommandContext|\bWorld\b|from ['"].*RenderPipeline/);
  assert.match(pipeline, /from ['"]\.\/frame-plan\/RenderFramePlan['"]/);
  assert.match(pipeline, /from ['"]\.\/frame-plan\/RenderPassCompatibility['"]/);
  assert.match(pipeline, /this\._getFramePlan\(\)\.items/);
  assert.doesNotMatch(pipeline, /this\._entries\.sort/);
});

test('actual pass compatibility is a focused submit contract without graph or resource ownership', () => {
  assert.match(compatibility, /function canShareRenderPass/);
  assert.match(compatibility, /left\.view !== right\.view/);
  assert.match(compatibility, /currentSampleCount !== nextSampleCount/);
  assert.doesNotMatch(compatibility, /RenderGraph|createTexture|createBuffer|queue\.submit/);
});

test('RenderGraph remains a device-free logical dependency/lifetime compiler', () => {
  assert.match(graph, /stable topological sort/);
  assert.match(graph, /resource\.observable && resource\.writer/);
  assert.doesNotMatch(graph, /GPUDevice|GPUCommandEncoder|beginRenderPass|queue\.submit/);
});

test('RenderIntegration coordinates systems without owning graph or command recording', () => {
  assert.match(integration, /new RenderPipeline|options\.pipeline/);
  assert.doesNotMatch(integration, /RenderGraph|GPUCommandEncoder|beginRenderPass|queue\.submit/);
});

async function source(path) {
  return readFile(new URL(path, import.meta.url), 'utf8');
}
