// haiyue:specialized-rendering-pass volume
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


struct ObjectData {
  model : mat4x4<f32>,
  invModel : mat4x4<f32>,
  boundsMin : vec4<f32>,
  boundsMax : vec4<f32>,
  params : vec4<f32>,
  color : vec4<f32>,
}

@group(0) @binding(0) var<uniform> sceneFrame : SceneFrameUniforms;
@group(1) @binding(0) var<storage, read> objects : array<ObjectData>;
@group(2) @binding(0) var volumeTexture : texture_3d<f32>;
@group(2) @binding(1) var volumeSampler : sampler;

struct VertexInput {
  @location(0) position : vec3<f32>,
  @builtin(instance_index) objectSlot : u32,
}

struct VertexOutput {
  @builtin(position) clipPos : vec4<f32>,
  @location(0) localPos : vec3<f32>,
  @location(1) @interpolate(flat) objectSlot : u32,
}

@vertex
fn vs_main(input : VertexInput) -> VertexOutput {
  let object = objects[input.objectSlot];
  var out : VertexOutput;
  out.clipPos = sceneFrame.viewProjection * object.model * vec4<f32>(input.position, 1.0);
  out.localPos = input.position;
  out.objectSlot = input.objectSlot;
  return out;
}

fn intersectAabb(origin : vec3<f32>, direction : vec3<f32>, bmin : vec3<f32>, bmax : vec3<f32>) -> vec2<f32> {
  let invDir = 1.0 / direction;
  let t0 = (bmin - origin) * invDir;
  let t1 = (bmax - origin) * invDir;
  let tmin = min(t0, t1);
  let tmax = max(t0, t1);
  return vec2<f32>(max(max(tmin.x, tmin.y), tmin.z), min(min(tmax.x, tmax.y), tmax.z));
}

@fragment
fn fs_main(input : VertexOutput) -> @location(0) vec4<f32> {
  let object = objects[input.objectSlot];
  let bmin = object.boundsMin.xyz;
  let bmax = object.boundsMax.xyz;
  let eyeLocal = (object.invModel * vec4<f32>(sceneFrame.eyePosition.xyz, 1.0)).xyz;
  let rayDir = normalize(input.localPos - eyeLocal);
  let hit = intersectAabb(eyeLocal, rayDir, bmin, bmax);
  if (hit.y <= max(hit.x, 0.0)) {
    discard;
  }

  let steps = max(object.params.z, 1.0);
  let densityScale = object.params.x;
  let opacityScale = object.params.y;
  let startT = max(hit.x, 0.0);
  let endT = hit.y;
  let stepSize = (endT - startT) / steps;
  var accum = vec4<f32>(0.0);

  for (var i = 0; i < 192; i = i + 1) {
    if (f32(i) >= steps || accum.a > 0.985) { break; }
    let pos = eyeLocal + rayDir * (startT + (f32(i) + 0.5) * stepSize);
    let worldPos = (object.model * vec4<f32>(pos, 1.0)).xyz;
    if (hy_is_clipped(worldPos, input.objectSlot)) { continue; }
    let uvw = clamp((pos - bmin) / max(bmax - bmin, vec3<f32>(0.0001)), vec3<f32>(0.0), vec3<f32>(1.0));
    let sample = textureSampleLevel(volumeTexture, volumeSampler, uvw, 0.0);
    let sampleAlpha = clamp(sample.a * densityScale * opacityScale * stepSize, 0.0, 1.0);
    let sampleColor = sample.rgb * object.color.rgb;
    let remainingAlpha = 1.0 - accum.a;
    accum = vec4<f32>(
      accum.rgb + remainingAlpha * sampleColor * sampleAlpha,
      accum.a + remainingAlpha * sampleAlpha,
    );
  }

  let outAlpha = accum.a * object.color.a;
  let outColor = select(vec3<f32>(0.0), accum.rgb / max(accum.a, 0.00001), accum.a > 0.00001);
  return vec4<f32>(outColor, outAlpha);
}
