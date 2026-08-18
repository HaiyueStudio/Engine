import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  MOTION_BLUR_POSTPROCESS_PASSES,
  ShaderComposerError,
  compileMotionBlurGraphV1,
  packShaderUniformBlock,
  parseShaderGraphV1,
} from '../dist/index.js';

const fixtureUrl = new URL('../pilot-motion-blur-postprocess.graph.json', import.meta.url);
const fixtureSource = await readFile(fixtureUrl, 'utf8');
const contract = JSON.parse(await readFile(new URL('../stage5-contract.json', import.meta.url), 'utf8'));
const rootManifest = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));

test('stage 5 contract pins graph provenance and keeps the pilot private', () => {
  const compiled = compileMotionBlurGraphV1(fixtureSource, {
    id: contract.graph.programId,
    sourceName: 'pilot-motion-blur-postprocess.graph.json',
  });
  assert.equal(contract.phase, 5);
  assert.equal(contract.status, 'implemented');
  assert.equal(contract.packageStatus, 'private-workspace');
  assert.deepEqual(contract.productionMigrations, []);
  assert.equal(contract.graph.sha256, createHash('sha256').update(fixtureSource).digest('hex'));
  assert.equal(contract.graph.canonicalHash, compiled.program.canonicalHash);
  assert.equal(contract.graph.typedModuleHash, compiled.compilation.typedModuleHash);
  assert.match(rootManifest.scripts['verify:shader-language-stage5'], /verify-webgpu-shader-language-stage5\.mjs/);
  assert.match(rootManifest.scripts['verify:render'], /npm run verify:motion-blur/);
});

test('postprocess Graph v1 lowers to one Typed IR module and three externally planned passes', () => {
  const compiled = compileMotionBlurGraphV1(fixtureSource, {
    id: 'pilot3.motion-blur',
    sourceName: 'pilot-motion-blur-postprocess.graph.json',
  });
  assert.equal(compiled.program.format, 'haiyue-typed-shader-ir');
  assert.equal(compiled.program.kind, 'postprocess');
  assert.match(compiled.program.canonicalHash, /^[a-f0-9]{64}$/);
  assert.deepEqual(compiled.program.nodes.map(node => node.operation), [
    'signed-uv-velocity',
    'tile-maximum-8x8',
    'neighbor-maximum-3x3',
    'centered-or-stable-reconstruction',
    'dynamic-display-mode',
  ]);
  assert.deepEqual(Object.keys(compiled.compilation.passes), [...MOTION_BLUR_POSTPROCESS_PASSES]);
  for (const pass of MOTION_BLUR_POSTPROCESS_PASSES) {
    assert.equal(compiled.compilation.passes[pass].typedModuleHash, compiled.compilation.typedModuleHash);
  }
  assert.deepEqual(compiled.compilation.plans.centered, {
    mode: 'centered',
    passes: ['motion-blur-resolve'],
    activeIntermediateTextureCount: 0,
    allocatedIntermediateTextureCount: 2,
    compilerSchedulesPasses: false,
  });
  assert.deepEqual(compiled.compilation.plans['tile-neighbor-max'], {
    mode: 'tile-neighbor-max',
    passes: ['motion-tile-max', 'motion-neighbor-max', 'motion-blur-resolve'],
    activeIntermediateTextureCount: 2,
    allocatedIntermediateTextureCount: 2,
    compilerSchedulesPasses: false,
  });
  assert.equal(compiled.compilation.generationPlacement, 'compile-or-warmup-only');
});

test('reflection owns pass bindings and uniform packing without graph binding numbers', () => {
  const compiled = compileMotionBlurGraphV1(fixtureSource);
  assert.doesNotMatch(fixtureSource, /@group|@binding|WGSL|createTexture|beginRenderPass/);
  const resolve = compiled.compilation.passes['motion-blur-resolve'];
  assert.deepEqual(resolve.reflection.resources.map(resource => [resource.id, resource.group, resource.binding]), [
    ['pass.sourceColor', 3, 0],
    ['pass.velocity', 3, 1],
    ['pass.neighborMax', 3, 2],
    ['pass.linearSampler', 3, 3],
    ['pass.motionBlurParameters', 3, 4],
  ]);
  const resolveBlock = resolve.reflection.uniformBlocks[0];
  assert.equal(resolveBlock.byteSize, 48);
  const packed = packShaderUniformBlock(resolveBlock, {
    resolution: [64, 64, 1 / 64, 1 / 64],
    settings: [0.75, 2.5, 24, 12],
    display: [1, 1, 0.5, 8],
  });
  assert.equal(packed.byteLength, 48);
  const tile = compiled.compilation.passes['motion-tile-max'];
  assert.equal(tile.reflection.uniformBlocks[0].byteSize, 16);
});

test('depth is explicitly DCE and auxiliary shaders retain stable tile-level reconstruction', () => {
  const compiled = compileMotionBlurGraphV1(fixtureSource);
  assert.deepEqual(compiled.eliminatedResourceIds, ['pass.depth']);
  for (const pass of MOTION_BLUR_POSTPROCESS_PASSES) {
    assert.doesNotMatch(compiled.compilation.passes[pass].code, /depthTexture|pass\.depth/);
  }
  const tile = compiled.compilation.passes['motion-tile-max'].code;
  const neighbor = compiled.compilation.passes['motion-neighbor-max'].code;
  const resolve = compiled.compilation.passes['motion-blur-resolve'].code;
  assert.match(tile, /origin = tile \* params\.tileSize/);
  assert.match(tile, /y < 8u/);
  assert.match(neighbor, /for \(var y = -1; y <= 1/);
  assert.match(resolve, /textureLoad\(neighborMaxTexture, tile, 0\)/);
  assert.match(resolve, /stationaryReceiver/);
  assert.match(resolve, /velocityHeatmap/);
  assert.doesNotMatch(resolve, /candidatePixel|maximumMotion|for \(var y = -2/);
});

test('display controls remain dynamic and do not multiply pipelines', () => {
  const policy = compileMotionBlurGraphV1(fixtureSource).compilation.variantPolicy;
  assert.deepEqual(policy.dynamicParameters, [
    'shutter-angle',
    'intensity',
    'max-blur-pixels',
    'sample-count',
    'display-mode',
    'split-position',
  ]);
  assert.deepEqual(policy.displayModes, ['blur', 'split', 'velocity']);
  assert.equal(policy.specializationVariantCount, 0);
  assert.equal(policy.pipelineCount, 3);
});

test('postprocess parser and compiler classify kind, node, port, resource and output failures', () => {
  const wrongSpace = JSON.parse(fixtureSource);
  wrongSpace.resources[0].space = 'material';
  assertDiagnostic(() => compileMotionBlurGraphV1(wrongSpace), 'E_SHADER_GRAPH_INVALID', 'resources.0.space');

  const unknownNode = JSON.parse(fixtureSource);
  unknownNode.nodes[0].type = 'vendor.motion-blur';
  assertDiagnostic(() => compileMotionBlurGraphV1(unknownNode), 'E_SHADER_GRAPH_NODE_UNKNOWN', 'nodes.0.type');

  const missingPort = JSON.parse(fixtureSource);
  delete missingPort.nodes[0].inputs.velocity;
  assertDiagnostic(() => compileMotionBlurGraphV1(missingPort), 'E_SHADER_GRAPH_PORT_INVALID', 'nodes.0.inputs.velocity');

  const wrongResource = JSON.parse(fixtureSource);
  wrongResource.resources[2].colorSpace = 'linear';
  assertDiagnostic(() => compileMotionBlurGraphV1(wrongResource), 'E_SHADER_GRAPH_PORT_INVALID', 'resources.pass.velocity');

  const wrongOutput = JSON.parse(fixtureSource);
  wrongOutput.outputs.color.output = 'velocity';
  assertDiagnostic(() => compileMotionBlurGraphV1(wrongOutput), 'E_SHADER_GRAPH_REFERENCE_INVALID', 'outputs.color');

  const material = JSON.parse(awaitMaterialFixture());
  material.resources[0].space = 'pass';
  assertDiagnostic(() => parseShaderGraphV1(material), 'E_SHADER_GRAPH_INVALID', 'resources.0.space');
});

test('postprocess canonical hash ignores editor metadata', () => {
  const changed = JSON.parse(fixtureSource);
  changed.metadata = { label: 'renamed' };
  changed.nodes[0].metadata = { position: [999, 42] };
  assert.equal(
    compileMotionBlurGraphV1(changed).program.canonicalHash,
    compileMotionBlurGraphV1(fixtureSource).program.canonicalHash,
  );
});

function awaitMaterialFixture() {
  return JSON.stringify({
    format: 'haiyue-shader-graph',
    version: 1,
    kind: 'material',
    profile: 'webgpu-portable',
    resources: [{
      id: 'material.test',
      space: 'material',
      kind: 'uniform',
      valueType: 'f32',
      frequency: 'material',
    }],
    nodes: [],
    outputs: {
      baseColor: { literal: { type: 'color3<f32>', value: [1, 1, 1], colorSpace: 'linear' } },
    },
  });
}

function assertDiagnostic(action, code, pathPrefix) {
  assert.throws(action, error => {
    assert.ok(error instanceof ShaderComposerError);
    assert.equal(error.diagnostic.code, code);
    assert.ok(error.diagnostic.path?.startsWith(pathPrefix));
    return true;
  });
}
