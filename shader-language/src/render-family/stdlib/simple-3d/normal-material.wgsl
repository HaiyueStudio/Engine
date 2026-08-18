struct ObjectUniforms {
  model        : mat4x4<f32>,
  normalMatrix : mat4x4<f32>,
}

struct NormalParams {
  space : u32,
  _pad0 : u32,
  _pad1 : u32,
  _pad2 : u32,
}

@group(0) @binding(0) var<uniform> sceneFrame : SceneFrameUniforms;
@group(1) @binding(0) var<storage, read> objects : array<ObjectUniforms>;
@group(2) @binding(0) var<uniform> params : NormalParams;

struct VertexInput {
  @location(0) position : vec3<f32>,
  @location(1) normal   : vec3<f32>,
  @builtin(instance_index) instanceIndex : u32,
}

struct VertexOutput {
  @builtin(position) clipPos : vec4<f32>,
  @location(0) normal        : vec3<f32>,
  @location(1) worldPos      : vec3<f32>,
  @location(2) @interpolate(flat) objectIndex : u32,
}

@vertex
fn vs_main(input: VertexInput) -> VertexOutput {
  var out: VertexOutput;
  let object = objects[input.instanceIndex];
  let worldPosition = object.model * vec4<f32>(input.position, 1.0);
  out.clipPos = sceneFrame.viewProjection * worldPosition;
  out.worldPos = worldPosition.xyz;
  out.objectIndex = input.instanceIndex;

  var n = input.normal;
  if (params.space == 0u) {
    n = normalize(input.normal);
  } else if (params.space == 1u) {
    n = normalize((object.normalMatrix * vec4<f32>(input.normal, 0.0)).xyz);
  } else {
    // A mat4 inverse-transpose can carry translation in its bottom row. Drop
    // that homogeneous component before the camera transform so translation
    // can never leak into a direction vector.
    let worldNormal = normalize((object.normalMatrix * vec4<f32>(input.normal, 0.0)).xyz);
    n = normalize((sceneFrame.view * vec4<f32>(worldNormal, 0.0)).xyz);
  }

  out.normal = n;
  return out;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  let object = objects[input.objectIndex];
  if (hy_is_clipped(input.worldPos, input.objectIndex)) { discard; }
  let n = normalize(input.normal);
  return vec4<f32>(n * 0.5 + vec3<f32>(0.5, 0.5, 0.5), 1.0);
}
