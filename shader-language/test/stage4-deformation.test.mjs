import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  DEFORMATION_PASS_KINDS,
  DeformationHistoryTracker,
  ShaderComposerError,
  compileDeformationPassFamilyV1,
  defineDeformationProgramV1,
} from '../dist/index.js';

function createProgram() {
  return defineDeformationProgramV1({
    id: 'pilot2.character-deformation',
    morphTargetCount: 2,
    jointCount: 2,
    displacement: { kind: 'normal-sine' },
  });
}

test('deformation IR defines morph then skin then object displacement exactly once', () => {
  const program = createProgram();
  assert.equal(program.format, 'haiyue-typed-shader-ir');
  assert.equal(program.version, 1);
  assert.equal(program.kind, 'vertex-deformation');
  assert.match(program.canonicalHash, /^[a-f0-9]{64}$/);
  assert.deepEqual(program.nodes.map(node => node.operation), [
    'morph-target-blend',
    'linear-blend-skinning',
    'object-normal-sine-displacement',
  ]);
  assert.equal(createProgram().canonicalHash, program.canonicalHash);
  assertDiagnostic(() => defineDeformationProgramV1({
    id: 'bad',
    morphTargetCount: 5,
    jointCount: 2,
    displacement: { kind: 'normal-sine' },
  }), 'deformation.morphTargetCount');
});

test('automatic vertex ABI and pass varyings are reflected without author bindings', () => {
  const family = compileDeformationPassFamilyV1(createProgram());
  const attributes = family.passes.forward.reflection.vertexAttributes;
  assert.deepEqual(attributes.map(attribute => [attribute.semantic, attribute.location, attribute.format]), [
    ['POSITION', 0, 'float32x3'],
    ['NORMAL', 1, 'float32x3'],
    ['JOINTS_0', 2, 'float32x4'],
    ['WEIGHTS_0', 3, 'float32x4'],
    ['MORPH_POSITION_0', 4, 'float32x3'],
    ['MORPH_POSITION_1', 5, 'float32x3'],
    ['MORPH_NORMAL_0', 6, 'float32x3'],
    ['MORPH_NORMAL_1', 7, 'float32x3'],
  ]);
  assert.deepEqual(family.passes.forward.reflection.varyings.map(varying => varying.semantic), [
    'POSITION_WORLD', 'NORMAL_WORLD',
  ]);
  assert.deepEqual(family.passes['motion-vector'].reflection.varyings.map(varying => varying.semantic), [
    'CURRENT_CLIP_POSITION', 'PREVIOUS_CLIP_POSITION',
  ]);
  assert.equal(family.passes.depth.reflection.varyings.length, 0);
  assert.deepEqual(family.passes.forward.reflection.resources.map(resource => [
    resource.id, resource.group, resource.binding,
  ]), [
    ['object.deformationState', 1, 0],
    ['object.currentJointMatrices', 1, 1],
    ['object.previousJointMatrices', 1, 2],
  ]);
  assert.equal(family.passes.forward.reflection.uniformBlocks[0].byteSize, 416);
});

test('five passes share one deformation module and auxiliary passes DCE surface lighting', () => {
  const family = compileDeformationPassFamilyV1(createProgram());
  assert.deepEqual(Object.keys(family.passes), [...DEFORMATION_PASS_KINDS]);
  for (const pass of DEFORMATION_PASS_KINDS) {
    const compiled = family.passes[pass];
    assert.equal(compiled.deformationModuleHash, family.deformationModuleHash);
    assert.equal(compiled.sharedDeformationSource, family.passes.forward.sharedDeformationSource);
    assert.equal(count(compiled.code, 'fn hy_deform_vertex('), 1);
    const morph = compiled.code.indexOf('// IR node 0: morph-target-blend');
    const skin = compiled.code.indexOf('// IR node 1: linear-blend-skinning');
    const displacement = compiled.code.indexOf('// IR node 2: object-normal-sine-displacement');
    assert.ok(morph >= 0 && morph < skin && skin < displacement);
    if (pass !== 'forward') assert.doesNotMatch(compiled.code, /hy_surface_lighting/);
  }
  const motion = family.passes['motion-vector'];
  assert.equal(motion.reflection.historySemantics, 'current-and-previous-same-ir');
  assert.match(motion.code, /currentDeformed = hy_deform_vertex[\s\S]+0u/);
  assert.match(motion.code, /previousDeformed = hy_deform_vertex[\s\S]+1u/);
});

test('history resets previous=current and isolates every view/entity pair', () => {
  const tracker = new DeformationHistoryTracker();
  const first = tracker.sample('view-a', 7, state(1));
  assert.equal(first.reset, true);
  assert.equal(first.resetReason, 'first-frame');
  assert.deepEqual([...first.previous.morphWeights], [...first.current.morphWeights]);

  const viewAMid = tracker.sample('view-a', 7, state(2));
  const viewBFirst = tracker.sample('view-b', 7, state(8));
  assert.equal(viewAMid.reset, false);
  assert.equal(viewAMid.previous.morphWeights[0], 1);
  assert.equal(viewBFirst.reset, true);
  assert.equal(viewBFirst.previous.morphWeights[0], 8);

  tracker.reset('view-a', 7, 'teleport');
  const teleported = tracker.sample('view-a', 7, state(12));
  assert.equal(teleported.reset, true);
  assert.equal(teleported.resetReason, 'teleport');
  assert.equal(teleported.previous.morphWeights[0], 12);
  assert.equal(tracker.audit().entryCount, 2);

  tracker.releaseEntity(7);
  assert.equal(tracker.audit().entryCount, 0);
  tracker.dispose();
  assert.deepEqual(tracker.audit(), {
    state: 'disposed',
    entryCount: 0,
    viewCount: 0,
    entityCount: 0,
  });
  assertDiagnostic(() => tracker.sample('view-a', 7, state(1)), 'deformation.history');
});

test('stage 4 machine contract records a passed private Pilot 2 without production migration', async () => {
  const contract = JSON.parse(await readFile(new URL('../stage4-contract.json', import.meta.url), 'utf8'));
  assert.equal(contract.phase, 4);
  assert.equal(contract.status, 'implemented');
  assert.equal(contract.pilot.id, 'multi-pass-deformation');
  assert.equal(contract.pilot.passCount, 5);
  assert.deepEqual(contract.productionMigrations, []);
  assert.ok(contract.deferred.includes('production-renderer-deformation-migration'));
  assert.ok(contract.acceptance.includes('npm run verify:shader-language-stage4'));
  const packageJson = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
  assert.match(packageJson.scripts['verify:shader-language-stage4'], /verify-webgpu-shader-language-stage4/);
});

function state(marker) {
  return {
    modelMatrix: identity(marker * 0.01),
    viewProjectionMatrix: identity(0),
    morphWeights: [marker, 0],
    jointMatrices: [...identity(0), ...identity(marker * 0.02)],
    displacement: [0.02, 2, marker],
  };
}

function identity(translationX) {
  return [
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    translationX, 0, 0, 1,
  ];
}

function count(source, pattern) {
  return source.split(pattern).length - 1;
}

function assertDiagnostic(action, path) {
  assert.throws(action, error => {
    assert.ok(error instanceof ShaderComposerError);
    assert.equal(error.diagnostic.code, 'E_SHADER_IR_INVALID');
    assert.ok(error.diagnostic.path?.startsWith(path));
    return true;
  });
}
