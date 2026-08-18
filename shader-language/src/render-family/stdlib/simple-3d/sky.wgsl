struct SkyUniforms {
  sunDirection   : vec4<f32>,
  params         : vec4<f32>,
  params2        : vec4<f32>,
}

@group(0) @binding(0) var<uniform> sceneFrame : SceneFrameUniforms;
@group(1) @binding(0) var<uniform> sky : SkyUniforms;

struct VertexOutput {
  @builtin(position) clipPos : vec4<f32>,
  @location(0) clipXY        : vec2<f32>,
}

@vertex
fn vs_main(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
  var positions = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>( 3.0, -1.0),
    vec2<f32>(-1.0,  3.0)
  );

  var out: VertexOutput;
  out.clipXY = positions[vertexIndex];
  out.clipPos = vec4<f32>(out.clipXY, 1.0, 1.0);
  return out;
}

fn toneMap(color: vec3<f32>, exposure: f32) -> vec3<f32> {
  return vec3<f32>(1.0) - exp(-max(color, vec3<f32>(0.0)) * exposure);
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  let worldH = sceneFrame.inverseViewProjection * vec4<f32>(input.clipXY, 1.0, 1.0);
  let worldPos = worldH.xyz / worldH.w;
  let viewDir = normalize(worldPos - sceneFrame.eyePosition.xyz);
  let sunDir = normalize(sky.sunDirection.xyz);

  let turbidity = max(sky.params.x, 0.0);
  let rayleigh = max(sky.params.y, 0.0);
  let mieCoefficient = max(sky.params.z, 0.0);
  let mieDirectionalG = clamp(sky.params.w, 0.0, 0.98);
  let exposure = max(sky.params2.x, 0.0);

  let skyUp = clamp(viewDir.y * 0.5 + 0.5, 0.0, 1.0);
  let horizon = pow(1.0 - skyUp, 1.65);
  let sunHeight = clamp(sunDir.y * 0.5 + 0.5, 0.0, 1.0);
  let haze = clamp((turbidity - 1.0) / 20.0, 0.0, 1.0);

  let nightZenith = vec3<f32>(0.012, 0.018, 0.045);
  let dayZenith = vec3<f32>(0.055, 0.23, 0.78) * (0.55 + rayleigh * 0.18);
  let zenith = mix(nightZenith, dayZenith, sunHeight);

  let coolHorizon = vec3<f32>(0.38, 0.48, 0.62);
  let warmHorizon = vec3<f32>(1.0, 0.61, 0.30);
  let horizonWarmth = clamp((1.0 - sunHeight) * 0.7 + haze * 0.35, 0.0, 1.0);
  let horizonColor = mix(coolHorizon, warmHorizon, horizonWarmth);

  var color = mix(zenith, horizonColor, horizon);
  color += vec3<f32>(0.22, 0.42, 1.0) * rayleigh * 0.045 * pow(max(viewDir.y, 0.0), 0.35);

  let mu = max(dot(viewDir, sunDir), 0.0);
  let g = mieDirectionalG;
  let miePhase = (1.0 - g * g) / max(0.001, pow(1.0 + g * g - 2.0 * g * mu, 1.5));
  let sunDisc = smoothstep(0.9992, 0.99985, mu);
  let sunGlow = pow(mu, mix(10.0, 90.0, g));
  let sunsetTint = mix(vec3<f32>(1.0, 0.93, 0.72), vec3<f32>(1.0, 0.50, 0.22), 1.0 - sunHeight);
  color += sunsetTint * (sunDisc * 15.0 + sunGlow * mieCoefficient * 24.0 * miePhase);

  let belowHorizon = 1.0 - smoothstep(-0.08, 0.04, viewDir.y);
  color = mix(color, vec3<f32>(0.025, 0.028, 0.04), belowHorizon * 0.8);

  return vec4<f32>(toneMap(color, exposure), 1.0);
}
