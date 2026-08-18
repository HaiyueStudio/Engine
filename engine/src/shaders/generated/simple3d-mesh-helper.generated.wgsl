// haiyue:builtin-render mesh-helper
// source: shader-language/builtin-simple-3d-runtime-family.json

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


struct ObjectUniforms {
  model : mat4x4<f32>,
  color : vec4<f32>,
  line : vec4<f32>,
}

@group(0) @binding(0) var<uniform> sceneFrame : SceneFrameUniforms;
@group(1) @binding(0) var<uniform> object : ObjectUniforms;

struct VertexOutput {
  @builtin(position) clipPos : vec4<f32>,
}

@vertex
fn vs_main(
  @builtin(vertex_index) vertexIndex : u32,
  @location(0) start : vec3<f32>,
  @location(1) end : vec3<f32>,
) -> VertexOutput {
  var out : VertexOutput;
  let positions = array<vec2<f32>, 8>(
    vec2<f32>(-1.0,  2.0), vec2<f32>( 1.0,  2.0),
    vec2<f32>(-1.0,  1.0), vec2<f32>( 1.0,  1.0),
    vec2<f32>(-1.0,  0.0), vec2<f32>( 1.0,  0.0),
    vec2<f32>(-1.0, -1.0), vec2<f32>( 1.0, -1.0),
  );
  let indices = array<u32, 18>(
    0u, 2u, 1u,
    2u, 3u, 1u,
    2u, 4u, 3u,
    4u, 5u, 3u,
    4u, 6u, 5u,
    6u, 7u, 5u,
  );
  let p = positions[indices[vertexIndex % 18u]];
  let clipStart = sceneFrame.viewProjection * object.model * vec4<f32>(start, 1.0);
  let clipEnd = sceneFrame.viewProjection * object.model * vec4<f32>(end, 1.0);
  let ndcStart = clipStart.xy / clipStart.w;
  let ndcEnd = clipEnd.xy / clipEnd.w;

  let aspect = sceneFrame.viewport.x / sceneFrame.viewport.y;
  var dir = ndcEnd - ndcStart;
  dir.x *= aspect;
  dir = normalize(select(vec2<f32>(1.0, 0.0), dir, length(dir) > 0.00001));

  var offset = vec2<f32>(dir.y, -dir.x);
  dir.x /= aspect;
  offset.x /= aspect;

  if (p.x < 0.0) {
    offset *= -1.0;
  }

  if (p.y < 0.0) {
    offset += -dir;
  } else if (p.y > 1.0) {
    offset += dir;
  }

  let clip = select(clipStart, clipEnd, p.y >= 0.5);
  let width = max(object.line.x, 1.0);
  offset *= width / sceneFrame.viewport.y;
  out.clipPos = vec4<f32>(clip.xy + offset * clip.w, clip.z, clip.w);
  return out;
}

@fragment
fn fs_main(in : VertexOutput) -> @location(0) vec4<f32> {
  return object.color;
}
