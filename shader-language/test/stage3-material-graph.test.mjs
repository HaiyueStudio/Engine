import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { validateShaderLanguageStage3VariantEvidence } from '../../scripts/webgpu-gate/shader-language-stage3-report.mjs';
import {
  MATERIAL_SURFACE_V1_SLOTS,
  METALLIC_ROUGHNESS_PBR_V1_SURFACE_SUPPORT,
  PBR_PILOT_VARIANT_POLICY,
  SHADER_GRAPH_V1_OPTIONAL_ROOT_FIELDS,
  SHADER_GRAPH_V1_REQUIRED_ROOT_FIELDS,
  SHADER_GRAPH_V1_ROOT_FIELDS,
  SHADER_GRAPH_V1_UNSUPPORTED_ROOT_FIELDS,
  ShaderComposerError,
  compileMaterialGraphV1,
  packShaderUniformBlock,
  parseShaderGraphV1,
} from '../dist/index.js';

const fixtureUrl = new URL('../pilot-pbr-composition.graph.json', import.meta.url);
const fixtureSource = await readFile(fixtureUrl, 'utf8');
const graphSchema = JSON.parse(await readFile(new URL('../graph-v1.schema.json', import.meta.url), 'utf8'));

test('Graph v1 lowers the canonical PBR composition into MaterialSurface, PBR and post-lighting Fog', () => {
  const compiled = compileMaterialGraphV1(fixtureSource, {
    id: 'graph.stage3-pbr-pilot',
    sourceName: 'pilot-pbr-composition.graph.json',
  });

  assert.match(compiled.canonicalHash, /^[a-f0-9]{64}$/);
  assert.deepEqual(compiled.vertexSemantics, [
    'TEXCOORD_0', 'POSITION_WORLD', 'NORMAL_WORLD', 'TANGENT_WORLD', 'TANGENT_SIGN',
  ]);
  assert.deepEqual(compiled.composition.reflection.resources.map(({ id, group, binding }) => ({ id, group, binding })), [
    { id: 'frame.scene', group: 0, binding: 0 },
    { id: 'material.parameters', group: 2, binding: 0 },
    { id: 'material.albedoTexture', group: 2, binding: 1 },
    { id: 'material.normalTexture', group: 2, binding: 2 },
    { id: 'material.surfaceSampler', group: 2, binding: 3 },
  ]);
  assert.deepEqual(compiled.composition.reflection.uniformBlocks.map(block => ({
    id: block.id,
    byteSize: block.byteSize,
    fields: block.fields.map(field => field.name),
  })), [
    {
      id: 'frame.scene',
      byteSize: 96,
      fields: ['cameraPosition', 'lightDirection', 'lightColor', 'ambientColor', 'fogColor', 'fogStart', 'fogEnd'],
    },
    {
      id: 'material.parameters',
      byteSize: 16,
      fields: ['metallic', 'noiseScale', 'noiseStrength', 'roughness'],
    },
  ]);
  assert.match(compiled.composition.code, /textureSample\(/);
  assert.match(compiled.composition.code, /cross\(/);
  assert.match(compiled.composition.code, /pow\(/);
  assert.match(compiled.composition.code, /sqrt\(/);
  assert.doesNotMatch(fixtureSource, /@group|@binding|WGSL|fn\s/);

  const lightingLines = compiled.composition.sourceMap
    .filter(span => span.sourceId === '@lighting.metallic-roughness')
    .map(span => span.generatedStartLine);
  const fogLines = compiled.composition.sourceMap
    .filter(span => span.sourceId === 'scene.fog')
    .map(span => span.generatedStartLine);
  assert.ok(lightingLines.length > 0 && fogLines.length > 0);
  assert.ok(Math.max(...fogLines) > Math.min(...lightingLines), 'Fog must lower after lighting');
  assert.ok(compiled.composition.sourceMap.some(span => span.sourceId === 'graph.composedBaseColor'));
});

test('Graph canonical Typed IR hash ignores metadata, node order and unreachable pure nodes', () => {
  const graph = JSON.parse(fixtureSource);
  const changed = structuredClone(graph);
  changed.metadata = { label: 'editor-only label', position: [100, 200] };
  changed.nodes.reverse();
  changed.nodes.push({
    id: 'unusedColor',
    type: 'haiyue.color.multiply',
    typeVersion: 1,
    inputs: {
      left: { literal: { type: 'color3<f32>', value: [1, 0, 0], colorSpace: 'linear' } },
      right: { literal: { type: 'color3<f32>', value: [0, 1, 0], colorSpace: 'linear' } },
    },
    metadata: { position: [999, 999] },
  });
  const clean = compileMaterialGraphV1(graph);
  const modified = compileMaterialGraphV1(changed);
  assert.equal(modified.canonicalHash, clean.canonicalHash);
  assert.equal(modified.composition.code, clean.composition.code);
});

test('Graph parser and compiler classify node, port, reference, cycle and surface failures', () => {
  const unknownNode = JSON.parse(fixtureSource);
  unknownNode.nodes[0].type = 'vendor.unknown-node';
  assertDiagnostic(() => compileMaterialGraphV1(unknownNode), 'E_SHADER_GRAPH_NODE_UNKNOWN', 'nodes.0');

  const missingPort = JSON.parse(fixtureSource);
  delete missingPort.nodes[0].inputs.scale;
  assertDiagnostic(() => compileMaterialGraphV1(missingPort), 'E_SHADER_GRAPH_PORT_INVALID', 'nodes.0.inputs');

  const missingReference = JSON.parse(fixtureSource);
  missingReference.outputs.baseColor.node = 'missingNode';
  assertDiagnostic(() => compileMaterialGraphV1(missingReference), 'E_SHADER_GRAPH_REFERENCE_INVALID', 'outputs.baseColor');

  const cycle = JSON.parse(fixtureSource);
  cycle.nodes[0].inputs.uv = { node: 'distortedUv', output: 'uv' };
  assertDiagnostic(() => compileMaterialGraphV1(cycle), 'E_SHADER_GRAPH_REFERENCE_INVALID', 'outputs');

  const wrongSurfaceType = JSON.parse(fixtureSource);
  wrongSurfaceType.outputs.metallic = wrongSurfaceType.outputs.baseColor;
  assertDiagnostic(() => compileMaterialGraphV1(wrongSurfaceType), 'E_SHADER_SURFACE_INVALID', 'outputs.metallic');

  const extraProperty = JSON.parse(fixtureSource);
  extraProperty.wgsl = '@fragment fn injected() {}';
  assertDiagnostic(() => parseShaderGraphV1(extraProperty), 'E_SHADER_GRAPH_INVALID', '$.wgsl');

  const unsupportedFrequency = JSON.parse(fixtureSource);
  unsupportedFrequency.resources[0].frequency = 'draw';
  assertDiagnostic(() => compileMaterialGraphV1(unsupportedFrequency), 'E_SHADER_GRAPH_INVALID', 'resources.0.frequency');
});

test('Graph v1 root schema, parser and machine contract expose the same bounded field set', async () => {
  assert.deepEqual(graphSchema.required, SHADER_GRAPH_V1_REQUIRED_ROOT_FIELDS);
  assert.deepEqual(Object.keys(graphSchema.properties), SHADER_GRAPH_V1_ROOT_FIELDS);
  assert.deepEqual(
    Object.keys(graphSchema.properties).filter(field => !graphSchema.required.includes(field)),
    SHADER_GRAPH_V1_OPTIONAL_ROOT_FIELDS,
  );

  const contract = JSON.parse(await readFile(new URL('../stage3-contract.json', import.meta.url), 'utf8'));
  assert.deepEqual(contract.graphRootV1.requiredFields, SHADER_GRAPH_V1_REQUIRED_ROOT_FIELDS);
  assert.deepEqual(contract.graphRootV1.optionalFields, SHADER_GRAPH_V1_OPTIONAL_ROOT_FIELDS);
  assert.equal(contract.graphRootV1.materialLightingModelSelection, 'compileMaterialGraphV1-fixed-metallic-roughness');
  assert.deepEqual(
    contract.graphRootV1.unsupportedArchitectureFields,
    Object.entries(SHADER_GRAPH_V1_UNSUPPORTED_ROOT_FIELDS).map(([field, value]) => ({
      field,
      currentOwner: value.currentOwner,
    })),
  );

  for (const field of SHADER_GRAPH_V1_REQUIRED_ROOT_FIELDS) {
    const graph = JSON.parse(fixtureSource);
    delete graph[field];
    assert.throws(() => parseShaderGraphV1(graph), error => {
      assert.ok(error instanceof ShaderComposerError);
      assert.equal(error.diagnostic.code, 'E_SHADER_GRAPH_INVALID');
      assert.equal(error.diagnostic.path, field);
      assert.equal(error.diagnostic.details?.field, field);
      assert.equal(error.diagnostic.details?.status, 'required-in-v1');
      return true;
    });
  }

  for (const [field, boundary] of Object.entries(SHADER_GRAPH_V1_UNSUPPORTED_ROOT_FIELDS)) {
    const graph = JSON.parse(fixtureSource);
    graph[field] = {};
    assert.throws(() => parseShaderGraphV1(graph), error => {
      assert.ok(error instanceof ShaderComposerError);
      assert.equal(error.diagnostic.code, 'E_SHADER_GRAPH_INVALID');
      assert.equal(error.diagnostic.path, `$.${field}`);
      assert.equal(error.diagnostic.details?.field, field);
      assert.equal(error.diagnostic.details?.status, 'unsupported-in-v1');
      assert.equal(error.diagnostic.details?.currentOwner, boundary.currentOwner);
      assert.equal(error.diagnostic.details?.guidance, boundary.guidance);
      return true;
    });
  }
});

test('metallic-roughness lowering consumes or precisely rejects every MaterialSurface v1 slot', () => {
  const support = METALLIC_ROUGHNESS_PBR_V1_SURFACE_SUPPORT;
  assert.deepEqual(
    [...support.consumedSlots, ...support.unsupportedSlots],
    MATERIAL_SURFACE_V1_SLOTS,
  );
  assert.equal(new Set([...support.consumedSlots, ...support.unsupportedSlots]).size, MATERIAL_SURFACE_V1_SLOTS.length);
  assert.equal(support.unsupportedDiagnosticCode, 'E_SHADER_SURFACE_UNSUPPORTED');

  const scalarSlots = new Set([
    'transmission', 'thickness', 'clearcoat', 'clearcoatRoughness', 'sheenRoughness',
  ]);
  const capabilityBySlot = {
    transmission: 'framebuffer-transmission',
    thickness: 'volume-thickness',
    clearcoat: 'clearcoat',
    clearcoatRoughness: 'clearcoat',
    clearcoatNormalTS: 'clearcoat',
    sheenColor: 'sheen',
    sheenRoughness: 'sheen',
  };
  for (const slot of support.unsupportedSlots) {
    const graph = JSON.parse(fixtureSource);
    graph.outputs[slot] = scalarSlots.has(slot)
      ? { literal: { type: 'f32', value: 0.5 } }
      : structuredClone(slot === 'clearcoatNormalTS' ? graph.outputs.normalTS : graph.outputs.emissive);
    assert.throws(() => compileMaterialGraphV1(graph), error => {
      assert.ok(error instanceof ShaderComposerError);
      assert.equal(error.diagnostic.code, 'E_SHADER_SURFACE_UNSUPPORTED');
      assert.equal(error.diagnostic.moduleId, '@lighting.metallic-roughness');
      assert.equal(error.diagnostic.path, `outputs.${slot}`);
      assert.deepEqual(error.diagnostic.details, {
        slot,
        lightingModel: 'metallic-roughness',
        loweringVersion: 1,
        status: 'unsupported',
        requiredCapability: capabilityBySlot[slot],
      });
      assert.match(error.diagnostic.message, /cannot be silently ignored/);
      return true;
    });
  }
});

test('Material and frame uniform reflection drives an exact ArrayBuffer packer', () => {
  const compiled = compileMaterialGraphV1(fixtureSource);
  const material = compiled.composition.reflection.uniformBlocks.find(block => block.id === 'material.parameters');
  assert.ok(material);
  const packed = packShaderUniformBlock(material, {
    metallic: 0.35,
    noiseScale: 1.75,
    noiseStrength: 0.025,
    roughness: 0.42,
  });
  assert.equal(packed.byteLength, 16);
  const floats = new Float32Array(packed);
  assert.ok(Math.abs(floats[0] - 0.35) < 1e-6);
  assert.ok(Math.abs(floats[1] - 1.75) < 1e-6);
  assert.ok(Math.abs(floats[2] - 0.025) < 1e-6);
  assert.ok(Math.abs(floats[3] - 0.42) < 1e-6);
  assertDiagnostic(() => packShaderUniformBlock(material, {
    metallic: 0.35,
    noiseScale: 1.75,
    roughness: 0.42,
  }), 'E_SHADER_UNIFORM_VALUE_INVALID', 'uniforms.noiseStrength');
});

test('Pilot 1 keeps normal/noise/gradient/Fog dynamic and bounds specialization variants', () => {
  const compiled = compileMaterialGraphV1(fixtureSource);
  assert.deepEqual(compiled.variantPolicy, PBR_PILOT_VARIANT_POLICY);
  assert.deepEqual(compiled.variantPolicy.dynamicFeatures, [
    'normal-map', 'uv-noise', 'height-gradient', 'scene.fog',
  ]);
  assert.deepEqual(compiled.variantPolicy.specializationAxes, []);
  assert.deepEqual(compiled.variantPolicy.reservedSpecializationAxes, ['clearcoat', 'transmission']);
  assert.equal(compiled.variantPolicy.reachableSpecializationVariants, 1);
  assert.equal(compiled.variantPolicy.reachableSpecializationVariants, 2 ** compiled.variantPolicy.specializationAxes.length);
  assert.equal(compiled.variantPolicy.maximumSpecializationVariants, 4);
  assert.deepEqual(compiled.variantPolicy.unsupportedSurfaceSlots, METALLIC_ROUGHNESS_PBR_V1_SURFACE_SUPPORT.unsupportedSlots);
  assert.deepEqual(compiled.typed.module.specializations, []);
  assert.equal(compiled.variantPolicy.reachablePilotFamilyVariants, 1);
  assert.equal(compiled.variantPolicy.maximumPilotFamilyVariants, 8);
  assert.ok(compiled.variantPolicy.reachablePilotFamilyVariants <= compiled.variantPolicy.maximumPilotFamilyVariants);
  assert.doesNotMatch(compiled.composition.code, /\boverride\b/);
});

test('stage 3 variant evidence rejects missing fields and actual/budget substitution', async () => {
  const contract = JSON.parse(await readFile(new URL('../stage3-contract.json', import.meta.url), 'utf8'));
  const valid = {
    specializationVariantCount: 1,
    maximumSpecializationVariantBudget: 4,
    pilotFamilyVariantCount: 1,
    maximumPilotFamilyVariantBudget: 8,
  };
  assert.deepEqual(validateShaderLanguageStage3VariantEvidence(valid, contract.pilot), []);
  for (const field of Object.keys(valid)) {
    const incomplete = { ...valid };
    delete incomplete[field];
    assert.ok(
      validateShaderLanguageStage3VariantEvidence(incomplete, contract.pilot)
        .some(failure => failure.startsWith(`${field} must be`)),
      `${field} must be required`,
    );
  }
  assert.deepEqual(
    validateShaderLanguageStage3VariantEvidence({
      ...valid,
      pilotFamilyVariantCount: valid.maximumPilotFamilyVariantBudget,
    }, contract.pilot),
    ['pilotFamilyVariantCount=8, expected 1'],
  );
});

test('stage 3 machine contract records a passed private Pilot 1 without production migration', async () => {
  const contract = JSON.parse(await readFile(new URL('../stage3-contract.json', import.meta.url), 'utf8'));
  assert.equal(contract.phase, 3);
  assert.equal(contract.status, 'implemented');
  assert.equal(contract.pilot.status, 'passed');
  assert.deepEqual(contract.pilot.fixedCenterPixelRgba8, [26, 27, 39, 230]);
  assert.equal(contract.pilot.maximumGeneratedToReferenceGzipRatio, 1.15);
  assert.deepEqual(contract.pilot.specializationAxes, PBR_PILOT_VARIANT_POLICY.specializationAxes);
  assert.deepEqual(contract.pilot.reservedSpecializationAxes, PBR_PILOT_VARIANT_POLICY.reservedSpecializationAxes);
  assert.equal(contract.pilot.reachableSpecializationVariants, PBR_PILOT_VARIANT_POLICY.reachableSpecializationVariants);
  assert.equal(contract.pilot.maximumSpecializationVariants, PBR_PILOT_VARIANT_POLICY.maximumSpecializationVariants);
  assert.equal(contract.pilot.reachablePilotFamilyVariants, PBR_PILOT_VARIANT_POLICY.reachablePilotFamilyVariants);
  assert.equal(contract.pilot.maximumPilotFamilyVariants, PBR_PILOT_VARIANT_POLICY.maximumPilotFamilyVariants);
  assert.deepEqual(contract.surfaceSlotConsumption, {
    lightingModel: METALLIC_ROUGHNESS_PBR_V1_SURFACE_SUPPORT.lightingModel,
    loweringVersion: METALLIC_ROUGHNESS_PBR_V1_SURFACE_SUPPORT.loweringVersion,
    consumed: METALLIC_ROUGHNESS_PBR_V1_SURFACE_SUPPORT.consumedSlots,
    unsupportedWithDiagnostic: METALLIC_ROUGHNESS_PBR_V1_SURFACE_SUPPORT.unsupportedSlots,
    diagnosticCode: METALLIC_ROUGHNESS_PBR_V1_SURFACE_SUPPORT.unsupportedDiagnosticCode,
  });
  assert.deepEqual(contract.productionMigrations, []);
  assert.ok(contract.deferred.includes('production-pbr-migration'));
  assert.ok(contract.deferred.includes('automatic-vertex-program-and-varying-codegen'));
  assert.ok(contract.deferred.includes('advanced-material-surface-lobes-in-graph-lowering'));
});

function assertDiagnostic(action, code, pathPrefix) {
  assert.throws(action, error => {
    assert.ok(error instanceof ShaderComposerError);
    assert.equal(error.diagnostic.code, code);
    assert.ok(error.diagnostic.path?.startsWith(pathPrefix), `${error.diagnostic.path} should start with ${pathPrefix}`);
    return true;
  });
}
