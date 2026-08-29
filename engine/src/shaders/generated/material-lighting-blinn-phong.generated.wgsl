// haiyue:material-lighting-pass blinn-phong
// haiyue:material-lighting-abi 1
// haiyue:material-lighting-module 5d97c3daa97c1993c3737129fc6165fcbb694988dea7527b0022e36430b38117
// haiyue:deformation-module 10c43d2008ebba9ec6891c008f57347c11e9e2d86f693a669075cd9c61c2544d
// source: shader-language/builtin-material-lighting-family.json

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


struct HyClip {
  p : array<vec4<f32>, 8>,
  m : vec4<f32>,
}

@group(1) @binding(1) var<storage, read> hyClip : array<HyClip>;

fn hy_is_clipped(p : vec3<f32>, o : u32) -> bool {
  let c = hyClip[o];
  for (var i = 0u; i < min(u32(max(c.m.x, 0.0)), 8u); i += 1u) {
    if (dot(c.p[i].xyz, p) + c.p[i].w < 0.0) { return true; }
  }
  return false;
}


struct ObjectUniforms {
  model        : mat4x4<f32>,
  normalMatrix : mat4x4<f32>,
}

struct MaterialUniforms {
  ambient   : vec4<f32>,
  diffuse   : vec4<f32>,
  specular  : vec4<f32>,
  shininess : f32,
  _p0 : f32, _p1 : f32, _p2 : f32,
}

struct LightData {
  typeVec   : vec4<u32>,  // x = type (0=ambient 1=dir 2=point)
  color     : vec4<f32>,  // rgb = color, a = intensity
  direction : vec4<f32>,  // xyz = direction (directional light)
  position  : vec4<f32>,  // xyz = world pos (point light), w = range
}

struct LightsUniforms {
  countVec : vec4<u32>,
  lights   : array<LightData, 8u>,
}

@group(0) @binding(0) var<uniform> sceneFrame : SceneFrameUniforms;
@group(1) @binding(0) var<storage, read> objects : array<ObjectUniforms>;
@group(2) @binding(0) var<uniform> material : MaterialUniforms;
@group(3) @binding(0) var<uniform> lights   : LightsUniforms;

struct VertexInput {
  @location(0) position : vec3<f32>,
  @location(1) normal   : vec3<f32>,
  @location(2) uv       : vec2<f32>,
  @builtin(instance_index) instanceIndex : u32,
}

struct VertexOutput {
  @builtin(position) clipPos   : vec4<f32>,
  @location(0)       worldPos  : vec3<f32>,
  @location(1)       worldNorm : vec3<f32>,
  @location(2) @interpolate(flat) objectIndex : u32,
}

@vertex
fn vs_main(in: VertexInput) -> VertexOutput {
  let object = objects[in.instanceIndex];
  let worldPos4  = object.model * vec4<f32>(in.position, 1.0);
  let worldNorm  = normalize((object.normalMatrix * vec4<f32>(in.normal, 0.0)).xyz);
  var out: VertexOutput;
  out.clipPos   = sceneFrame.viewProjection * worldPos4;
  out.worldPos  = worldPos4.xyz;
  out.worldNorm = worldNorm;
  out.objectIndex = in.instanceIndex;
  return out;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
  let object = objects[in.objectIndex];
  if (hy_is_clipped(in.worldPos, in.objectIndex)) { discard; }
  let N = normalize(in.worldNorm);
  let V = normalize(sceneFrame.eyePosition.xyz - in.worldPos);

  var outColor = vec3<f32>(0.0);
  let nLights  = lights.countVec.x;

  for (var i = 0u; i < nLights; i++) {
    let light  = lights.lights[i];
    let lType  = light.typeVec.x;
    let lColor = light.color.rgb * light.color.a;  // pre-multiply intensity

    if (lType == 0u) {
      // Ambient
      outColor += lColor * material.ambient.rgb;

    } else if (lType == 1u) {
      // Directional
      let L     = normalize(-light.direction.xyz);
      let H     = normalize(L + V);
      let NdotL = max(dot(N, L), 0.0);
      let NdotH = max(dot(N, H), 0.0);
      let spec  = select(0.0, pow(NdotH, material.shininess), NdotL > 0.0);
      outColor += lColor * (NdotL * material.diffuse.rgb + spec * material.specular.rgb);

    } else if (lType == 2u) {
      // Point
      let toLight = light.position.xyz - in.worldPos;
      let dist    = length(toLight);
      let range   = light.position.w;
      let L       = toLight / max(dist, 0.0001);
      let H       = normalize(L + V);
      let NdotL   = max(dot(N, L), 0.0);
      let NdotH   = max(dot(N, H), 0.0);
      let spec    = select(0.0, pow(NdotH, material.shininess), NdotL > 0.0);
      let t       = clamp(1.0 - (dist / range), 0.0, 1.0);
      let atten   = t * t;
      outColor += lColor * atten * (NdotL * material.diffuse.rgb + spec * material.specular.rgb);
    }
  }

  let mapped = outColor / (outColor + vec3<f32>(1.0));
  let displayColor = pow(mapped, vec3<f32>(1.0 / 2.2));
  return vec4<f32>(applyFog(displayColor, sceneFrame.fog, sceneFrame.eyePosition.xyz, in.worldPos), material.diffuse.a);
}
