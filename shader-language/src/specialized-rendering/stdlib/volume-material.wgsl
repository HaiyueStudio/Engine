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
