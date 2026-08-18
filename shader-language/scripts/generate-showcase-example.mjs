import { readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFORMATION_PASS_KINDS,
  compileDeformationPassFamilyV1,
  compileMaterialGraphV1,
  compileShaderIrProgramToGlslEs300,
  composeShaderModules,
  defineDeformationProgramV1,
  defineTypedShaderModule,
} from '../dist/index.js';

const directory = dirname(fileURLToPath(import.meta.url));
const root = resolve(directory, '../..');
const outputPath = resolve(root, 'examples/shader-language-lab/generated/showcase.generated.ts');
const pbrGraphPath = resolve(root, 'shader-language/pilot-pbr-composition.graph.json');

const PBR_VERTEX_WGSL = /* wgsl */ `
struct ShowcasePbrObject {
  modelViewProjection : mat4x4<f32>,
  model : mat4x4<f32>,
}

@group(1) @binding(0) var<uniform> showcasePbrObject : ShowcasePbrObject;

struct ShowcasePbrVertexInput {
  @location(0) position : vec3<f32>,
  @location(1) normal : vec3<f32>,
  @location(2) tangent : vec3<f32>,
  @location(3) uv : vec2<f32>,
}

struct ShowcasePbrVertexOutput {
  @builtin(position) position : vec4<f32>,
  @location(0) uv0 : vec2<f32>,
  @location(1) worldPosition : vec3<f32>,
  @location(2) worldNormal : vec3<f32>,
  @location(3) worldTangent : vec3<f32>,
  @location(4) tangentSign : f32,
}

@vertex fn showcasePbrVertex(input : ShowcasePbrVertexInput) -> ShowcasePbrVertexOutput {
  let world = showcasePbrObject.model * vec4<f32>(input.position, 1.0);
  var output : ShowcasePbrVertexOutput;
  output.position = showcasePbrObject.modelViewProjection * vec4<f32>(input.position, 1.0);
  output.uv0 = input.uv;
  output.worldPosition = world.xyz;
  output.worldNormal = normalize((showcasePbrObject.model * vec4<f32>(input.normal, 0.0)).xyz);
  output.worldTangent = normalize((showcasePbrObject.model * vec4<f32>(input.tangent, 0.0)).xyz);
  output.tangentSign = 1.0;
  return output;
}
`;

const POSITION_CLIP = Object.freeze({ dataType: 'vec4<f32>', semantic: 'position', coordinateSpace: 'clip' });
const POSITION_SCREEN = Object.freeze({ dataType: 'vec4<f32>', semantic: 'position', coordinateSpace: 'screen' });
const UV_SCREEN = Object.freeze({ dataType: 'vec2<f32>', semantic: 'uv', coordinateSpace: 'screen' });
const COLOR_LINEAR = Object.freeze({ dataType: 'vec4<f32>', semantic: 'color', colorSpace: 'linear' });

const COMPOSITION_NODES = Object.freeze([
  { id: 'screen-position', label: 'Screen Position', operation: 'builtin(position)', category: 'input', sourceId: 'showcase.screen-position' },
  { id: 'normalize-uv', label: 'Normalize UV', operation: 'xy × invResolution', category: 'space', sourceId: 'showcase.normalize-uv' },
  { id: 'radial-field', label: 'Radial Field', operation: 'dot(uv - 0.5)', category: 'math', sourceId: 'showcase.radial-field' },
  { id: 'noise-distortion', label: 'Wave Distortion', operation: 'sin(x × scale + time)', category: 'effect', sourceId: 'showcase.noise-distortion' },
  { id: 'texture-sample', label: 'Texture Sample', operation: 'texture(source, sampler, uv)', category: 'resource', sourceId: 'showcase.texture-sample' },
  { id: 'srgb-decode', label: 'sRGB → Linear', operation: 'explicit color conversion', category: 'color', sourceId: 'showcase.srgb-decode' },
  { id: 'gradient', label: 'Radial Gradient', operation: 'mix(tintA, tintB, radius)', category: 'color', sourceId: 'showcase.gradient' },
  { id: 'scanlines', label: 'Scanlines', operation: 'sin(y × frequency + time)', category: 'effect', sourceId: 'showcase.scanlines' },
  { id: 'output', label: 'Linear Color Output', operation: 'sample × tint × scan × vignette', category: 'output', sourceId: 'showcase.output' },
]);

const COMPOSITION_EDGES = Object.freeze([
  ['screen-position', 'normalize-uv'],
  ['normalize-uv', 'radial-field'],
  ['normalize-uv', 'noise-distortion'],
  ['radial-field', 'noise-distortion'],
  ['noise-distortion', 'texture-sample'],
  ['texture-sample', 'srgb-decode'],
  ['radial-field', 'gradient'],
  ['srgb-decode', 'gradient'],
  ['normalize-uv', 'scanlines'],
  ['gradient', 'output'],
  ['scanlines', 'output'],
]);

export function createShaderLanguageShowcaseBundle() {
  const typed = defineTypedShaderModule({
    id: 'example.shader-language-lab',
    resources: [
      {
        id: 'material.params',
        space: 'material',
        kind: 'uniform-buffer',
        visibility: ['fragment'],
        fields: [
          { id: 'invResolution', type: 'vec2<f32>' },
          { id: 'time', type: 'f32' },
          { id: 'noiseScale', type: 'f32' },
          { id: 'noiseStrength', type: 'f32' },
          { id: 'gradientBias', type: 'f32' },
          { id: 'scanStrength', type: 'f32' },
          { id: 'vignetteStrength', type: 'f32' },
          { id: 'tintA', type: 'vec4<f32>', semantic: 'color', colorSpace: 'linear' },
          { id: 'tintB', type: 'vec4<f32>', semantic: 'color', colorSpace: 'linear' },
        ],
      },
      {
        id: 'material.sourceTexture',
        space: 'material',
        kind: 'texture',
        visibility: ['fragment'],
        valueType: 'texture_2d<f32>',
        colorSpace: 'srgb',
      },
      {
        id: 'material.sourceSampler',
        space: 'material',
        kind: 'sampler',
        visibility: ['fragment'],
        valueType: 'sampler',
      },
    ],
    entries: [
      {
        id: 'vertexMain',
        stage: 'vertex',
        name: 'vertexMain',
        inputs: [{ id: 'position', type: POSITION_CLIP, location: 0 }],
        output: { type: POSITION_CLIP, builtin: 'position' },
        build: (_builder, inputs) => inputs.position,
      },
      {
        id: 'fragmentMain',
        stage: 'fragment',
        name: 'fragmentMain',
        inputs: [{ id: 'fragPosition', type: POSITION_SCREEN, builtin: 'position', source: source('screen-position', 1) }],
        output: { type: COLOR_LINEAR, location: 0, source: source('output', 9) },
        build: (builder, inputs) => {
          const zero = builder.literal('f32', 0);
          const one = builder.literal('f32', 1);
          const fragXY = builder.swizzle(inputs.fragPosition, 'xy', source('screen-position', 1));
          const normalizedRaw = builder.multiply(
            fragXY,
            builder.uniformField('material.params', 'invResolution'),
            source('normalize-uv', 2),
          );
          const centered = builder.subtract(normalizedRaw, builder.literal('vec2<f32>', [0.5, 0.5]));
          const radiusSquared = builder.dot(centered, centered, source('radial-field', 3));
          const x = builder.swizzle(normalizedRaw, 'x');
          const phase = builder.add(
            builder.multiply(x, builder.uniformField('material.params', 'noiseScale')),
            builder.uniformField('material.params', 'time'),
          );
          const wave = builder.sin(phase, source('noise-distortion', 4));
          const distortedX = builder.add(
            x,
            builder.multiply(wave, builder.uniformField('material.params', 'noiseStrength')),
          );
          const sampleY = builder.clamp(
            builder.add(
              builder.multiply(radiusSquared, builder.literal('f32', 2.15)),
              builder.multiply(wave, builder.literal('f32', 0.045)),
            ),
            zero,
            one,
          );
          const sampleUv = builder.withSemantic(
            builder.construct('vec2<f32>', [distortedX, sampleY]),
            UV_SCREEN,
          );
          const sampled = builder.textureSample('material.sourceTexture', 'material.sourceSampler', sampleUv, {
            source: source('texture-sample', 5),
          });
          const decoded = builder.srgbToLinear(sampled, source('srgb-decode', 6));
          const gradient = builder.clamp(
            builder.add(
              builder.multiply(radiusSquared, builder.literal('f32', 1.85)),
              builder.uniformField('material.params', 'gradientBias'),
            ),
            zero,
            one,
          );
          const tint = builder.mix(
            builder.uniformField('material.params', 'tintA'),
            builder.uniformField('material.params', 'tintB'),
            gradient,
            source('gradient', 7),
          );
          const y = builder.swizzle(normalizedRaw, 'y');
          const scanPhase = builder.add(
            builder.multiply(y, builder.literal('f32', 150)),
            builder.multiply(builder.uniformField('material.params', 'time'), builder.literal('f32', 4)),
          );
          const scan = builder.clamp(
            builder.add(
              builder.literal('f32', 0.88),
              builder.multiply(builder.sin(scanPhase), builder.uniformField('material.params', 'scanStrength')),
            ),
            zero,
            one,
            source('scanlines', 8),
          );
          const vignette = builder.clamp(
            builder.subtract(
              one,
              builder.multiply(radiusSquared, builder.uniformField('material.params', 'vignetteStrength')),
            ),
            builder.literal('f32', 0.18),
            one,
          );
          const shaded = builder.multiply(
            builder.multiply(builder.multiply(decoded, tint), scan),
            vignette,
          );
          return builder.construct(
            COLOR_LINEAR,
            [builder.swizzle(shaded, 'rgb'), one],
            source('output', 9),
          );
        },
      },
    ],
  });
  const wgsl = composeShaderModules({ label: 'shader-language-lab', entry: typed.module });
  const glsl = compileShaderIrProgramToGlslEs300(typed.ir);
  const { cost: glslCompilationCost, ...stableGlslArtifact } = glsl;
  const wgslBlock = wgsl.reflection.uniformBlocks.find(block => block.id === 'material.params');
  const glslBlock = glsl.uniformBlocks.find(block => block.resourceId === 'material.params');
  if (!wgslBlock || !glslBlock) throw new Error('Showcase compiler output is missing material.params reflection.');
  assertCompatibleLayouts(wgslBlock, glslBlock.layout);

  const pbrGraphSource = readFileSync(pbrGraphPath, 'utf8');
  const pbr = compileMaterialGraphV1(pbrGraphSource, {
    id: 'example.shader-language-lab.pbr',
    label: 'shader-language-lab-real-pbr',
    sourceName: 'pilot-pbr-composition.graph.json',
  });
  const pbrObjectBlock = Object.freeze({
    id: 'object.pbrTransform',
    alignment: 16,
    byteSize: 128,
    fields: Object.freeze([
      Object.freeze({ name: 'modelViewProjection', type: 'mat4x4<f32>', offset: 0, size: 64, matrixStride: 16 }),
      Object.freeze({ name: 'model', type: 'mat4x4<f32>', offset: 64, size: 64, matrixStride: 16 }),
    ]),
  });
  const pbrArtifact = Object.freeze({
    graph: pbr.graph,
    ir: pbr.typed.ir,
    canonicalHash: pbr.canonicalHash,
    compositionHash: pbr.composition.irHash,
    vertexSemantics: pbr.vertexSemantics,
    variantPolicy: pbr.variantPolicy,
    wgsl: Object.freeze({
      code: `${PBR_VERTEX_WGSL.trim()}\n\n${pbr.composition.code}`,
      vertexEntryPoint: 'showcasePbrVertex',
      fragmentEntryPoint: 'fragmentMain',
      reflection: pbr.composition.reflection,
      objectUniformBlock: pbrObjectBlock,
      sourceMap: pbr.composition.sourceMap,
    }),
  });

  const deformationProgram = defineDeformationProgramV1({
    id: 'example.shader-language-lab.character',
    morphTargetCount: 2,
    jointCount: 19,
    displacement: { kind: 'normal-sine' },
  });
  const deformation = compileDeformationPassFamilyV1(deformationProgram);
  const characterArtifact = Object.freeze({
    asset: Object.freeze({
      path: '../../scripts/webgpu-gate/assets/gltf-corpus/medium-rigged-figure-draco/RiggedFigure.gltf',
      decoderScriptPath: '../../node_modules/draco3dgltf/draco_decoder_gltf_nodejs.js',
      decoderWasmPath: '../../node_modules/draco3dgltf/draco_decoder_gltf.wasm',
      expectedJointCount: 19,
      license: 'CC0-1.0',
    }),
    program: deformation.program,
    deformationModuleHash: deformation.deformationModuleHash,
    passOrder: DEFORMATION_PASS_KINDS,
    passes: Object.freeze(Object.fromEntries(DEFORMATION_PASS_KINDS.map(pass => {
      const compiled = deformation.passes[pass];
      return [pass, Object.freeze({
        code: compiled.code,
        canonicalHash: compiled.canonicalHash,
        deformationModuleHash: compiled.deformationModuleHash,
        reflection: compiled.reflection,
      })];
    }))),
  });

  const sourceIds = new Set(typed.ir.entries.flatMap(entry => entry.nodes.map(node => node.source.sourceId)));
  for (const node of COMPOSITION_NODES) {
    if (!sourceIds.has(node.sourceId)) throw new Error(`Showcase graph node ${node.id} is not represented in canonical Typed IR.`);
  }
  return Object.freeze({
    schemaVersion: 1,
    id: 'shader-language-lab',
    title: 'Shader Language Lab',
    compilerStage: 14,
    runtimeCompilerIncluded: false,
    productRendererContract: 'webgpu-only-unchanged',
    canonicalHash: typed.ir.canonicalHash,
    graph: Object.freeze({ nodes: COMPOSITION_NODES, edges: COMPOSITION_EDGES }),
    ir: typed.ir,
    wgsl: Object.freeze({
      code: wgsl.code,
      compositionHash: wgsl.irHash,
      variantKey: wgsl.variantKey,
      reflection: wgsl.reflection,
      sourceMap: wgsl.sourceMap,
    }),
    glsl: Object.freeze(stableGlslArtifact),
    pbr: pbrArtifact,
    character: characterArtifact,
    metrics: Object.freeze({
      entryCount: typed.ir.entries.length,
      nodeCount: typed.ir.entries.reduce((total, entry) => total + entry.nodes.length, 0),
      irNodeCountBeforeOptimization: glslCompilationCost.irNodeCountBeforeOptimization,
      irNodeCountAfterOptimization: glslCompilationCost.irNodeCountAfterOptimization,
      optimizedNodeCount: glslCompilationCost.irNodeCountAfterOptimization,
      sourceBytes: new TextEncoder().encode(wgsl.code).byteLength + glslCompilationCost.sourceBytes,
      resourceCount: typed.ir.resources.length,
      pipelineCount: 2,
      variantCount: 1,
      staticVariantCount: 1,
      pbrGraphNodeCount: pbr.graph.nodes.length,
      pbrReachableSpecializationVariants: pbr.variantPolicy.reachableSpecializationVariants,
      pbrMaximumSpecializationVariants: pbr.variantPolicy.maximumSpecializationVariants,
      pbrReachablePilotFamilyVariants: pbr.variantPolicy.reachablePilotFamilyVariants,
      pbrMaximumPilotFamilyVariants: pbr.variantPolicy.maximumPilotFamilyVariants,
      characterPassCount: DEFORMATION_PASS_KINDS.length,
    }),
  });
}

export async function generateShaderLanguageShowcaseExample({ write = false } = {}) {
  const bundle = createShaderLanguageShowcaseBundle();
  const expected = renderGeneratedModule(bundle);
  if (write) {
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, expected, 'utf8');
  } else {
    let actual = null;
    try { actual = await readFile(outputPath, 'utf8'); } catch { /* reported below */ }
    if (actual !== expected) {
      throw new Error('Shader Language Lab generated artifact is stale. Run npm run shader-language:generate:showcase.');
    }
  }
  return Object.freeze({
    canonicalHash: bundle.canonicalHash,
    glslBackendHash: bundle.glsl.backendHash,
    nodeCount: bundle.metrics.nodeCount,
    metrics: bundle.metrics,
    outputPath,
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const write = process.argv.includes('--write');
  const result = await generateShaderLanguageShowcaseExample({ write });
  console.log(`[shader-language:showcase] ${write ? 'wrote' : 'verified'} canonical=${result.canonicalHash.slice(0, 12)}, glsl=${result.glslBackendHash.slice(0, 12)}, nodes=${result.nodeCount}.`);
}

function source(id, line) {
  return Object.freeze({
    sourceId: `showcase.${id}`,
    sourceName: 'shader-language-lab.typed.ts',
    line,
  });
}

function assertCompatibleLayouts(wgsl, glsl) {
  const comparable = block => ({
    byteSize: block.byteSize,
    fields: block.fields.map(field => ({ name: field.name, type: field.type, offset: field.offset, size: field.size, matrixStride: field.matrixStride ?? null })),
  });
  if (JSON.stringify(comparable(wgsl)) !== JSON.stringify(comparable(glsl))) {
    throw new Error('Showcase uniform layout is not portable between WGSL host layout and std140.');
  }
}

function renderGeneratedModule(bundle) {
  return `// Generated by shader-language/scripts/generate-showcase-example.mjs. Do not edit.\n`
    + `export const SHADER_LANGUAGE_SHOWCASE = ${JSON.stringify(bundle, null, 2)} as const;\n`;
}
