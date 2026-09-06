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
  lights   : array<LightData, BLINN_PHONG_MAX_LIGHTS>,
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

  return vec4<f32>(applyFog(outColor, sceneFrame.fog, sceneFrame.eyePosition.xyz, in.worldPos), material.diffuse.a);
}
