// haiyue:specialized-rendering-pass instanced-mesh3d
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


const PI : f32 = 3.14159265359;

fn distributionGGX(nDotH: f32, roughness: f32) -> f32 {
  let a = roughness * roughness;
  let a2 = a * a;
  let d = nDotH * nDotH * (a2 - 1.0) + 1.0;
  return a2 / max(PI * d * d, 0.00001);
}

fn geometrySchlickGGX(nDotV: f32, roughness: f32) -> f32 {
  let r = roughness + 1.0;
  let k = (r * r) / 8.0;
  return nDotV / max(nDotV * (1.0 - k) + k, 0.00001);
}

fn geometrySmith(nDotV: f32, nDotL: f32, roughness: f32) -> f32 {
  return geometrySchlickGGX(nDotV, roughness) * geometrySchlickGGX(nDotL, roughness);
}

fn fresnelSchlick(cosTheta: f32, f0: vec3<f32>) -> vec3<f32> {
  return f0 + (vec3<f32>(1.0) - f0) * pow(clamp(1.0 - cosTheta, 0.0, 1.0), 5.0);
}

fn fresnelSchlickF90(cosTheta: f32, f0: vec3<f32>, f90: vec3<f32>) -> vec3<f32> {
  return f0 + (f90 - f0) * pow(clamp(1.0 - cosTheta, 0.0, 1.0), 5.0);
}

fn fresnelSchlickRoughness(cosTheta: f32, f0: vec3<f32>, roughness: f32) -> vec3<f32> {
  return f0 + (max(vec3<f32>(1.0 - roughness), f0) - f0) * pow(clamp(1.0 - cosTheta, 0.0, 1.0), 5.0);
}

fn fresnelSchlickRoughnessF90(
  cosTheta: f32,
  f0: vec3<f32>,
  f90: vec3<f32>,
  roughness: f32,
) -> vec3<f32> {
  let roughF90 = max(f90 * (1.0 - roughness), f0);
  return f0 + (roughF90 - f0) * pow(clamp(1.0 - cosTheta, 0.0, 1.0), 5.0);
}


struct InstancedMaterialUniforms {
  // x: PBR enabled, y: metallic, z: roughness
  factors : vec4<f32>,
}
struct LightData {
  typeVec : vec4<u32>,
  color : vec4<f32>,
  direction : vec4<f32>,
  position : vec4<f32>,
}
struct LightsUniforms {
  countVec : vec4<u32>,
  lights : array<LightData, 8>,
}
struct EnvironmentUniforms {
  diffuseColor : vec4<f32>,
  specularColor : vec4<f32>,
  params : vec4<f32>,
}

@group(0) @binding(0) var<uniform>          sceneFrame : SceneFrameUniforms;
@group(1) @binding(0) var<storage, read>    transforms : array<mat4x4<f32>>;
@group(1) @binding(1) var<storage, read>    colors     : array<vec4<f32>>;
@group(1) @binding(2) var<storage, read>    visible    : array<u32>;
@group(1) @binding(3) var<uniform>          material   : InstancedMaterialUniforms;
@group(1) @binding(4) var<uniform>          lights     : LightsUniforms;
@group(1) @binding(5) var<uniform>          environment : EnvironmentUniforms;

struct VIn {
  @location(0) position : vec3<f32>,
  @location(1) normal   : vec3<f32>,
  @location(2) uv       : vec2<f32>,
};

struct VOut {
  @builtin(position) pos   : vec4<f32>,
  @location(0)       color : vec4<f32>,
  @location(1)       uv    : vec2<f32>,
  @location(2)       worldPos : vec3<f32>,
  @location(3)       worldNormal : vec3<f32>,
};

@vertex
fn vs_main(in: VIn, @builtin(instance_index) instanceIdx: u32) -> VOut {
  let sourceIdx = visible[instanceIdx];
  let model = transforms[sourceIdx];
  let worldPosition = model * vec4<f32>(in.position, 1.0);
  var out: VOut;
  out.pos = sceneFrame.viewProjection * worldPosition;
  out.color = colors[sourceIdx];
  out.uv = in.uv;
  out.worldPos = worldPosition.xyz;
  out.worldNormal = normalize((model * vec4<f32>(in.normal, 0.0)).xyz);
  return out;
}

fn evaluatePbr(in: VOut) -> vec3<f32> {
  let baseColor = in.color.rgb;
  let metallic = clamp(material.factors.y, 0.0, 1.0);
  let roughness = clamp(material.factors.z, 0.04, 1.0);
  let n = normalize(in.worldNormal);
  let v = normalize(sceneFrame.eyePosition.xyz - in.worldPos);
  let nDotV = max(dot(n, v), 0.0001);
  let f0 = mix(vec3<f32>(0.04), baseColor, metallic);
  var direct = vec3<f32>(0.0);

  for (var index = 0u; index < min(lights.countVec.x, 8u); index++) {
    let light = lights.lights[index];
    if (light.typeVec.x == 0u) {
      direct += light.color.rgb * light.color.a * baseColor * (1.0 - metallic);
      continue;
    }
    var l = normalize(-light.direction.xyz);
    var radiance = light.color.rgb * light.color.a;
    if (light.typeVec.x == 2u) {
      let toLight = light.position.xyz - in.worldPos;
      let distance = length(toLight);
      l = toLight / max(distance, 0.0001);
      let attenuation = pow(clamp(1.0 - distance / max(light.position.w, 0.0001), 0.0, 1.0), 2.0);
      radiance *= attenuation;
    }
    let h = normalize(v + l);
    let nDotL = max(dot(n, l), 0.0);
    let nDotH = max(dot(n, h), 0.0);
    let hDotV = max(dot(h, v), 0.0);
    let d = distributionGGX(nDotH, roughness);
    let g = geometrySmith(nDotV, nDotL, roughness);
    let f = fresnelSchlick(hDotV, f0);
    let specular = (d * g * f) / max(4.0 * nDotV * nDotL, 0.0001);
    let kd = (vec3<f32>(1.0) - f) * (1.0 - metallic);
    direct += (kd * baseColor / PI + specular) * radiance * nDotL;
  }

  let environmentF = fresnelSchlickRoughness(nDotV, f0, roughness);
  let environmentKd = (vec3<f32>(1.0) - environmentF) * (1.0 - metallic);
  let diffuseIbl = environmentKd * environment.diffuseColor.rgb * baseColor / PI;
  let specularIbl = environment.specularColor.rgb * environmentF * (1.0 - roughness * 0.65);
  let color = direct + (diffuseIbl + specularIbl) * environment.params.x;
  let mapped = color / (color + vec3<f32>(1.0));
  return pow(mapped, vec3<f32>(1.0 / 2.2));
}

@fragment
fn fs_main(in: VOut) -> @location(0) vec4<f32> {
  var color = in.color.rgb;
  if (material.factors.x > 0.5) { color = evaluatePbr(in); }
  return vec4<f32>(applyFog(color, sceneFrame.fog, sceneFrame.eyePosition.xyz, in.worldPos), in.color.a);
}
