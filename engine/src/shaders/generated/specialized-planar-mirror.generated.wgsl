// haiyue:specialized-rendering-pass planar-mirror
// haiyue:specialized-rendering-abi 1
// haiyue:specialized-rendering-module e58254ced41b58d62be3b93804a7633bcaa270d03d1064a773f62a4db8af1e3d
// source: shader-language/builtin-specialized-rendering-family.json

struct FogUniforms {
  color : vec4<f32>,
  distanceParams : vec4<f32>,
  heightParams : vec4<f32>,
}

fn fogAmount(fog : FogUniforms, eyePosition : vec3<f32>, worldPosition : vec3<f32>) -> f32 {
  let mode = fog.distanceParams.x;
  if (mode < 0.5) { return 0.0; }

  let ray = worldPosition - eyePosition;
  let viewDistance = length(ray);
  var amount = 0.0;

  if (mode < 1.5) {
    let start = fog.distanceParams.y;
    let end = max(fog.distanceParams.z, start + 0.0001);
    amount = clamp((viewDistance - start) / (end - start), 0.0, 1.0);
  } else {
    let baseHeight = fog.heightParams.x;
    let density = max(fog.heightParams.y, 0.0);
    let falloff = max(fog.heightParams.z, 0.0);
    let cameraDensity = exp(clamp(-falloff * (eyePosition.y - baseHeight), -40.0, 40.0));
    let heightDelta = worldPosition.y - eyePosition.y;
    let scaledDelta = falloff * heightDelta;
    var averageDensity = cameraDensity;
    if (abs(scaledDelta) > 0.0001) {
      averageDensity *= (1.0 - exp(clamp(-scaledDelta, -40.0, 40.0))) / scaledDelta;
    }
    let opticalDepth = density * viewDistance * max(averageDensity, 0.0);
    amount = 1.0 - exp(-min(opticalDepth, 40.0));
  }

  return min(clamp(amount, 0.0, 1.0), clamp(fog.distanceParams.w, 0.0, 1.0));
}

fn applyFog(color : vec3<f32>, fog : FogUniforms, eyePosition : vec3<f32>, worldPosition : vec3<f32>) -> vec3<f32> {
  return mix(color, fog.color.rgb, fogAmount(fog, eyePosition, worldPosition));
}


struct SceneFrameUniforms {
  viewProjection : mat4x4<f32>,
  view : mat4x4<f32>,
  inverseViewProjection : mat4x4<f32>,
  eyePosition : vec4<f32>,
  viewport : vec4<f32>,
  fog : FogUniforms,
}


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
