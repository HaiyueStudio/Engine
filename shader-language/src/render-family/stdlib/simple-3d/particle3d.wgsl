struct CameraUniforms {
  viewProj : mat4x4<f32>,
  right : vec4<f32>,
  up : vec4<f32>,
}

struct ObjectUniforms {
  model : mat4x4<f32>,
  params : vec4<f32>, // x opacity, y radial coverage, z world-size scale
}

@group(0) @binding(0) var<uniform> camera : CameraUniforms;
@group(1) @binding(0) var<uniform> object : ObjectUniforms;
@group(2) @binding(0) var particleTexture : texture_2d<f32>;
@group(2) @binding(1) var particleSampler : sampler;

struct VertexInput {
  @location(0) corner : vec2<f32>,
  @location(1) uv : vec2<f32>,
  @location(2) center : vec3<f32>,
  @location(3) size : f32,
  @location(4) rotation : f32,
  @location(5) color : vec4<f32>,
}

struct VertexOutput {
  @builtin(position) position : vec4<f32>,
  @location(0) uv : vec2<f32>,
  @location(1) color : vec4<f32>,
}

@vertex
fn vs_main(input : VertexInput) -> VertexOutput {
  let c = cos(input.rotation);
  let s = sin(input.rotation);
  let local = input.corner * input.size * object.params.z;
  let rotated = vec2<f32>(local.x * c - local.y * s, local.x * s + local.y * c);
  let center = (object.model * vec4<f32>(input.center, 1.0)).xyz;
  let worldPosition = center + camera.right.xyz * rotated.x + camera.up.xyz * rotated.y;
  var out : VertexOutput;
  out.position = camera.viewProj * vec4<f32>(worldPosition, 1.0);
  out.uv = input.uv;
  out.color = vec4<f32>(input.color.rgb, input.color.a * object.params.x);
  return out;
}

@fragment
fn fs_main(input : VertexOutput) -> @location(0) vec4<f32> {
  var sampled = textureSample(particleTexture, particleSampler, input.uv);
  if (object.params.y > 0.5) {
    sampled.a *= 1.0 - smoothstep(0.42, 0.5, distance(input.uv, vec2<f32>(0.5)));
  }
  return sampled * input.color;
}
