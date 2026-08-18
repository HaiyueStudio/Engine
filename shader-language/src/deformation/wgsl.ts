import type {
  ShaderResourceReflection,
  ShaderUniformBlockReflection,
  ShaderVaryingReflection,
} from '../contracts';
import { sha256Hex } from '../hash';
import type {
  CompiledDeformationPassFamilyV1,
  CompiledDeformationPassV1,
  DeformationPassKind,
  DeformationPassReflection,
  DeformationProgramV1,
  DeformationVertexAttributeReflection,
  DeformationVertexFormat,
} from './contracts';
import { DEFORMATION_PASS_KINDS } from './contracts';

const RESOURCES: readonly ShaderResourceReflection[] = Object.freeze([
  Object.freeze({
    id: 'object.deformationState',
    space: 'object' as const,
    group: 1,
    binding: 0,
    kind: 'uniform-buffer' as const,
    visibility: Object.freeze(['vertex', 'fragment'] as const),
  }),
  Object.freeze({
    id: 'object.currentJointMatrices',
    space: 'object' as const,
    group: 1,
    binding: 1,
    kind: 'storage-buffer-read' as const,
    visibility: Object.freeze(['vertex'] as const),
  }),
  Object.freeze({
    id: 'object.previousJointMatrices',
    space: 'object' as const,
    group: 1,
    binding: 2,
    kind: 'storage-buffer-read' as const,
    visibility: Object.freeze(['vertex'] as const),
  }),
]);

const OBJECT_UNIFORM_BLOCK: ShaderUniformBlockReflection = Object.freeze({
  id: 'object.deformationState',
  alignment: 16,
  byteSize: 416,
  fields: Object.freeze([
    field('currentModel', 'mat4x4<f32>', 0, 64, 16),
    field('previousModel', 'mat4x4<f32>', 64, 64, 16),
    field('currentViewProjection', 'mat4x4<f32>', 128, 64, 16),
    field('previousViewProjection', 'mat4x4<f32>', 192, 64, 16),
    field('shadowViewProjection', 'mat4x4<f32>', 256, 64, 16),
    field('currentMorphWeights', 'vec4<f32>', 320, 16),
    field('previousMorphWeights', 'vec4<f32>', 336, 16),
    field('currentDisplacement', 'vec4<f32>', 352, 16),
    field('previousDisplacement', 'vec4<f32>', 368, 16),
    field('forwardColor', 'vec4<f32>', 384, 16),
    field('outlineColor', 'vec4<f32>', 400, 16),
  ]),
});

export function compileDeformationPassFamilyV1(
  program: DeformationProgramV1,
): CompiledDeformationPassFamilyV1 {
  const sharedBody = emitSharedDeformation(program);
  const deformationModuleHash = sha256Hex(sharedBody);
  const sharedDeformationSource = [
    `// haiyue:deformation-ir ${program.canonicalHash}`,
    `// haiyue:deformation-module ${deformationModuleHash}`,
    sharedBody,
  ].join('\n');
  const compiled = DEFORMATION_PASS_KINDS.map(pass =>
    compilePass(program, pass, sharedDeformationSource, deformationModuleHash));
  const passes = Object.fromEntries(compiled.map(pass => [pass.pass, pass])) as
    Record<DeformationPassKind, CompiledDeformationPassV1>;
  return Object.freeze({
    program,
    deformationModuleHash,
    passes: Object.freeze(passes),
  });
}

function compilePass(
  program: DeformationProgramV1,
  pass: DeformationPassKind,
  sharedDeformationSource: string,
  deformationModuleHash: string,
): CompiledDeformationPassV1 {
  const vertexAttributes = createVertexAttributes(program.morphTargetCount);
  const varyings = createVaryings(pass);
  const vertexEntryPoint = `hy_vertex_${identifier(pass)}`;
  const fragmentEntryPoint = `hy_fragment_${identifier(pass)}`;
  const wrapper = emitPassWrapper(program, pass, vertexEntryPoint, fragmentEntryPoint);
  const code = `${sharedDeformationSource}\n\n${wrapper}\n`;
  const canonicalHash = sha256Hex(`${program.canonicalHash}|${pass}|${code}`);
  const reflection: DeformationPassReflection = Object.freeze({
    pass,
    vertexEntryPoint,
    fragmentEntryPoint,
    vertexAttributes,
    varyings,
    resources: RESOURCES,
    uniformBlocks: Object.freeze([OBJECT_UNIFORM_BLOCK]),
    historySemantics: pass === 'motion-vector' ? 'current-and-previous-same-ir' : 'current-only',
    alphaCoverage: 'opaque',
  });
  return Object.freeze({
    pass,
    code,
    sharedDeformationSource,
    deformationModuleHash,
    canonicalHash,
    reflection,
  });
}

function emitSharedDeformation(program: DeformationProgramV1): string {
  const morphParameters = Array.from({ length: program.morphTargetCount }, (_, index) =>
    `morphPosition${index} : vec3<f32>, morphNormal${index} : vec3<f32>`).join(',\n  ');
  const morphLines = Array.from({ length: program.morphTargetCount }, (_, index) => {
    const component = ['x', 'y', 'z', 'w'][index] ?? 'x';
    return [
      `  position += morphPosition${index} * morphWeights.${component};`,
      `  normal += morphNormal${index} * morphWeights.${component};`,
    ].join('\n');
  }).join('\n');
  return `struct HyDeformationObjectState {
  currentModel : mat4x4<f32>,
  previousModel : mat4x4<f32>,
  currentViewProjection : mat4x4<f32>,
  previousViewProjection : mat4x4<f32>,
  shadowViewProjection : mat4x4<f32>,
  currentMorphWeights : vec4<f32>,
  previousMorphWeights : vec4<f32>,
  currentDisplacement : vec4<f32>,
  previousDisplacement : vec4<f32>,
  forwardColor : vec4<f32>,
  outlineColor : vec4<f32>,
}

struct HyJointMatrices {
  values : array<mat4x4<f32>>,
}

@group(1) @binding(0) var<uniform> hy_deformation_object : HyDeformationObjectState;
@group(1) @binding(1) var<storage, read> hy_current_joints : HyJointMatrices;
@group(1) @binding(2) var<storage, read> hy_previous_joints : HyJointMatrices;

struct HyDeformedVertex {
  positionObject : vec3<f32>,
  normalObject : vec3<f32>,
}

fn hy_deformation_joint(index : u32, state : u32) -> mat4x4<f32> {
  if (state == 0u) {
    return hy_current_joints.values[index];
  }
  return hy_previous_joints.values[index];
}

fn hy_deform_vertex(
  basePosition : vec3<f32>,
  baseNormal : vec3<f32>,
  joints : vec4<f32>,
  weights : vec4<f32>,
  ${morphParameters},
  state : u32,
) -> HyDeformedVertex {
  let morphWeights = select(
    hy_deformation_object.currentMorphWeights,
    hy_deformation_object.previousMorphWeights,
    state == 1u,
  );
  var position = basePosition;
  var normal = baseNormal;
  // IR node 0: morph-target-blend
${morphLines}
  // IR node 1: linear-blend-skinning
  let skin =
      hy_deformation_joint(u32(joints.x), state) * weights.x
    + hy_deformation_joint(u32(joints.y), state) * weights.y
    + hy_deformation_joint(u32(joints.z), state) * weights.z
    + hy_deformation_joint(u32(joints.w), state) * weights.w;
  position = (skin * vec4<f32>(position, 1.0)).xyz;
  normal = normalize((skin * vec4<f32>(normal, 0.0)).xyz);
  // IR node 2: object-normal-sine-displacement
  let displacement = select(
    hy_deformation_object.currentDisplacement,
    hy_deformation_object.previousDisplacement,
    state == 1u,
  );
  position += normal * displacement.x * sin(position.y * displacement.y + displacement.z);
  return HyDeformedVertex(position, normal);
}`;
}

function emitPassWrapper(
  program: DeformationProgramV1,
  pass: DeformationPassKind,
  vertexEntryPoint: string,
  fragmentEntryPoint: string,
): string {
  const attributes = [
    '  @location(0) position : vec3<f32>,',
    '  @location(1) normal : vec3<f32>,',
    '  @location(2) joints : vec4<f32>,',
    '  @location(3) weights : vec4<f32>,',
  ];
  for (let index = 0; index < program.morphTargetCount; index++) {
    attributes.push(`  @location(${4 + index}) morphPosition${index} : vec3<f32>,`);
  }
  for (let index = 0; index < program.morphTargetCount; index++) {
    attributes.push(`  @location(${4 + program.morphTargetCount + index}) morphNormal${index} : vec3<f32>,`);
  }
  const argumentsList = [
    'input.position',
    'input.normal',
    'input.joints',
    'input.weights',
  ];
  for (let index = 0; index < program.morphTargetCount; index++) {
    argumentsList.push(`input.morphPosition${index}`, `input.morphNormal${index}`);
  }
  const inputStruct = `struct HyVertexInput {
${attributes.join('\n')}
}`;
  const currentCall = `hy_deform_vertex(
    ${argumentsList.join(',\n    ')},
    0u,
  )`;
  const previousCall = `hy_deform_vertex(
    ${argumentsList.join(',\n    ')},
    1u,
  )`;

  if (pass === 'forward') {
    return `${inputStruct}

struct HyForwardVertexOutput {
  @builtin(position) position : vec4<f32>,
  @location(0) positionWorld : vec3<f32>,
  @location(1) normalWorld : vec3<f32>,
}

@vertex fn ${vertexEntryPoint}(input : HyVertexInput) -> HyForwardVertexOutput {
  let deformed = ${currentCall};
  let world = hy_deformation_object.currentModel * vec4<f32>(deformed.positionObject, 1.0);
  var output : HyForwardVertexOutput;
  output.position = hy_deformation_object.currentViewProjection * world;
  output.positionWorld = world.xyz;
  output.normalWorld = normalize((hy_deformation_object.currentModel * vec4<f32>(deformed.normalObject, 0.0)).xyz);
  return output;
}

@fragment fn ${fragmentEntryPoint}(input : HyForwardVertexOutput) -> @location(0) vec4<f32> {
  // Pilot surface/lighting work exists only in forward and is DCE'd from auxiliary passes.
  let hy_surface_lighting = 0.3 + 0.7 * max(dot(normalize(input.normalWorld), normalize(vec3<f32>(0.4, 0.7, 1.0))), 0.0);
  return vec4<f32>(hy_deformation_object.forwardColor.rgb * hy_surface_lighting, hy_deformation_object.forwardColor.a);
}`;
  }
  if (pass === 'motion-vector') {
    return `${inputStruct}

struct HyMotionVertexOutput {
  @builtin(position) position : vec4<f32>,
  @location(0) currentClip : vec4<f32>,
  @location(1) previousClip : vec4<f32>,
}

@vertex fn ${vertexEntryPoint}(input : HyVertexInput) -> HyMotionVertexOutput {
  let currentDeformed = ${currentCall};
  let previousDeformed = ${previousCall};
  let currentClip = hy_deformation_object.currentViewProjection
    * hy_deformation_object.currentModel * vec4<f32>(currentDeformed.positionObject, 1.0);
  let previousClip = hy_deformation_object.previousViewProjection
    * hy_deformation_object.previousModel * vec4<f32>(previousDeformed.positionObject, 1.0);
  var output : HyMotionVertexOutput;
  output.position = currentClip;
  output.currentClip = currentClip;
  output.previousClip = previousClip;
  return output;
}

@fragment fn ${fragmentEntryPoint}(input : HyMotionVertexOutput) -> @location(0) vec4<f32> {
  let currentNdc = input.currentClip.xy / max(abs(input.currentClip.w), 0.00001);
  let previousNdc = input.previousClip.xy / max(abs(input.previousClip.w), 0.00001);
  let velocityUv = (currentNdc - previousNdc) * vec2<f32>(0.5, -0.5);
  return vec4<f32>(clamp(velocityUv * 0.5 + vec2<f32>(0.5), vec2<f32>(0.0), vec2<f32>(1.0)), 0.0, 1.0);
}`;
  }
  const color = pass === 'outline-selection'
    ? 'hy_deformation_object.outlineColor'
    : 'vec4<f32>(1.0, 1.0, 1.0, 1.0)';
  const projection = pass === 'shadow'
    ? 'hy_deformation_object.shadowViewProjection'
    : 'hy_deformation_object.currentViewProjection';
  const fragmentParameter = pass === 'depth'
    ? `(input : Hy${pascal(identifier(pass))}VertexOutput)`
    : '()';
  const fragmentColor = pass === 'depth'
    ? 'vec4<f32>(vec3<f32>(clamp(input.position.z, 0.0, 1.0)), 1.0)'
    : color;
  const suffix = identifier(pass);
  return `${inputStruct}

struct Hy${pascal(suffix)}VertexOutput {
  @builtin(position) position : vec4<f32>,
}

@vertex fn ${vertexEntryPoint}(input : HyVertexInput) -> Hy${pascal(suffix)}VertexOutput {
  let deformed = ${currentCall};
  let world = hy_deformation_object.currentModel * vec4<f32>(deformed.positionObject, 1.0);
  var output : Hy${pascal(suffix)}VertexOutput;
  output.position = ${projection} * world;
  return output;
}

@fragment fn ${fragmentEntryPoint}${fragmentParameter} -> @location(0) vec4<f32> {
  return ${fragmentColor};
}`;
}

function createVertexAttributes(morphTargetCount: number): readonly DeformationVertexAttributeReflection[] {
  const attributes: DeformationVertexAttributeReflection[] = [
    attribute('POSITION', 0, 'float32x3', 'vec3<f32>'),
    attribute('NORMAL', 1, 'float32x3', 'vec3<f32>'),
    attribute('JOINTS_0', 2, 'float32x4', 'vec4<f32>'),
    attribute('WEIGHTS_0', 3, 'float32x4', 'vec4<f32>'),
  ];
  for (let index = 0; index < morphTargetCount; index++) {
    attributes.push(attribute(`MORPH_POSITION_${index}`, 4 + index, 'float32x3', 'vec3<f32>'));
  }
  for (let index = 0; index < morphTargetCount; index++) {
    attributes.push(attribute(
      `MORPH_NORMAL_${index}`,
      4 + morphTargetCount + index,
      'float32x3',
      'vec3<f32>',
    ));
  }
  return Object.freeze(attributes);
}

function createVaryings(pass: DeformationPassKind): readonly ShaderVaryingReflection[] {
  if (pass === 'forward') {
    return Object.freeze([
      varying('POSITION_WORLD', 0, 'vec3<f32>'),
      varying('NORMAL_WORLD', 1, 'vec3<f32>'),
    ]);
  }
  if (pass === 'motion-vector') {
    return Object.freeze([
      varying('CURRENT_CLIP_POSITION', 0, 'vec4<f32>'),
      varying('PREVIOUS_CLIP_POSITION', 1, 'vec4<f32>'),
    ]);
  }
  return Object.freeze([]);
}

function attribute(
  semantic: string,
  location: number,
  format: DeformationVertexFormat,
  shaderType: string,
): DeformationVertexAttributeReflection {
  return Object.freeze({ semantic, location, format, shaderType });
}

function varying(semantic: string, location: number, type: string): ShaderVaryingReflection {
  return Object.freeze({ semantic, location, type, interpolation: 'perspective' });
}

function field(
  name: string,
  type: string,
  offset: number,
  size: number,
  matrixStride?: number,
): ShaderUniformBlockReflection['fields'][number] {
  return Object.freeze({
    name,
    type,
    offset,
    size,
    ...(matrixStride === undefined ? {} : { matrixStride }),
  });
}

function identifier(pass: DeformationPassKind): string {
  return pass.replaceAll('-', '_');
}

function pascal(value: string): string {
  return value.split('_').map(part => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`).join('');
}
