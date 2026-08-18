struct MirrorObjectUniforms {
  model : mat4x4<f32>,
}

struct MirrorMaterialUniforms {
  reflectionViewProjection : mat4x4<f32>,
  tintReflectivity : vec4<f32>,
}

@group(0) @binding(0) var<uniform> sceneFrame : SceneFrameUniforms;
@group(1) @binding(0) var<uniform> object : MirrorObjectUniforms;
@group(2) @binding(0) var<uniform> material : MirrorMaterialUniforms;
@group(2) @binding(1) var reflectionTexture : texture_2d<f32>;
@group(2) @binding(2) var reflectionSampler : sampler;

struct VertexOutput {
  @builtin(position) position : vec4<f32>,
  @location(0) reflectionClip : vec4<f32>,
}

@vertex
fn vs_main(@location(0) position : vec3<f32>) -> VertexOutput {
  let worldPosition = object.model * vec4<f32>(position, 1.0);
  var output : VertexOutput;
  output.position = sceneFrame.viewProjection * worldPosition;
  output.reflectionClip = material.reflectionViewProjection * worldPosition;
  return output;
}

@fragment
fn fs_main(input : VertexOutput) -> @location(0) vec4<f32> {
  var reflected = vec3<f32>(0.0);
  if (input.reflectionClip.w > 0.00001) {
    let ndc = input.reflectionClip.xy / input.reflectionClip.w;
    let uv = vec2<f32>(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5);
    if (all(uv >= vec2<f32>(0.0)) && all(uv <= vec2<f32>(1.0))) {
      // The bounds check is fragment-varying, so an implicit-derivative
      // sampling here with implicit derivatives violates WGSL uniformity on
      // conforming implementations. Reflection targets have one mip level;
      // explicit LOD is both correct and valid inside this branch.
      reflected = textureSampleLevel(reflectionTexture, reflectionSampler, uv, 0.0).rgb;
    }
  }
  let tint = material.tintReflectivity.rgb;
  let reflectivity = material.tintReflectivity.a;
  return vec4<f32>(mix(tint, reflected * tint, reflectivity), 1.0);
}
