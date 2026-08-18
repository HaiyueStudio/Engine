struct ObjectUniforms {
  model : mat4x4<f32>,
  morphWeights : vec4<f32>,
  deformationFlags : vec4<f32>,
}

struct MaterialUniforms {
  color    : vec4<f32>,
  emissiveFactor : vec4<f32>,
  useTexture : u32,
  useEmissiveTexture : u32,
  _pad1    : u32,
  _pad2    : u32,
}

@group(0) @binding(0) var<uniform> sceneFrame : SceneFrameUniforms;
@group(1) @binding(0) var<storage, read> objects : array<ObjectUniforms>;
@group(2) @binding(0) var<uniform> material : MaterialUniforms;
@group(2) @binding(1) var baseTexture       : texture_2d<f32>;
@group(2) @binding(2) var baseSampler       : sampler;
@group(2) @binding(3) var emissiveTexture   : texture_2d<f32>;

struct VertexInput {
  @location(0) position : vec3<f32>,
  @location(1) normal   : vec3<f32>,
  @location(2) uv       : vec2<f32>,
  @location(3) morphPosition0 : vec3<f32>,
  @location(4) morphPosition1 : vec3<f32>,
  @location(5) morphPosition2 : vec3<f32>,
  @location(6) morphPosition3 : vec3<f32>,
  @builtin(instance_index) instanceIndex : u32,
}

struct VertexOutput {
  @builtin(position) clipPos : vec4<f32>,
  @location(0) uv            : vec2<f32>,
  @location(1) normal        : vec3<f32>,
  @location(2) worldPos      : vec3<f32>,
  @location(3) @interpolate(flat) objectIndex : u32,
}

@vertex
fn vs_main(input: VertexInput) -> VertexOutput {
  var out: VertexOutput;
  let object = objects[input.instanceIndex];
  let position = applyMorphPosition(
    input.position,
    input.morphPosition0,
    input.morphPosition1,
    input.morphPosition2,
    input.morphPosition3,
    object.morphWeights,
  );
  let worldPosition = object.model * vec4<f32>(position, 1.0);
  out.clipPos = sceneFrame.viewProjection * worldPosition;
  out.uv      = input.uv;
  out.normal  = input.normal;
  out.worldPos = worldPosition.xyz;
  out.objectIndex = input.instanceIndex;
  return out;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  let object = objects[input.objectIndex];
  if (hy_is_clipped(input.worldPos, input.objectIndex)) { discard; }
  var texColor = vec4<f32>(1.0, 1.0, 1.0, 1.0);
  if (material.useTexture != 0u) {
    texColor = textureSample(baseTexture, baseSampler, input.uv);
  }
  var outColor = texColor * material.color;
  if (material.useEmissiveTexture != 0u) {
    let emissive = textureSample(emissiveTexture, baseSampler, input.uv).rgb * material.emissiveFactor.rgb;
    outColor = vec4<f32>(outColor.rgb + emissive, outColor.a);
  }
  return vec4<f32>(applyFog(outColor.rgb, sceneFrame.fog, sceneFrame.eyePosition.xyz, input.worldPos), outColor.a);
}
