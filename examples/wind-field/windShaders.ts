export const WIND_UPDATE_SHADER = /* wgsl */ `
struct Particle {
  position : vec2<f32>,
  previous : vec2<f32>,
}

struct Params {
  windMinMax : vec4<f32>,
  windSizeDeltaSpeed : vec4<f32>,
  dropSeedFade : vec4<f32>,
  viewportCount : vec4<f32>,
}

@group(0) @binding(0) var windTexture : texture_2d<f32>;
@group(0) @binding(1) var windSampler : sampler;
@group(0) @binding(2) var<storage, read> particlesIn : array<Particle>;
@group(0) @binding(3) var<storage, read_write> particlesOut : array<Particle>;
@group(0) @binding(4) var<uniform> params : Params;

fn random(seed : vec2<f32>) -> f32 {
  let t = dot(seed, vec2<f32>(12.9898, 78.233));
  return fract(sin(t) * (4375.85453 + t));
}

fn lookupWind(position : vec2<f32>) -> vec2<f32> {
  let encoded = textureSampleLevel(windTexture, windSampler, position, 0.0).rg;
  return mix(params.windMinMax.xy, params.windMinMax.zw, encoded);
}

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  let particleCount = u32(params.viewportCount.z);
  if (gid.x >= particleCount) { return; }

  let oldPosition = particlesIn[gid.x].position;
  let frameScale = params.windSizeDeltaSpeed.z;
  if (frameScale <= 0.0) {
    particlesOut[gid.x] = Particle(oldPosition, oldPosition);
    return;
  }

  let velocity = lookupWind(oldPosition);
  let maximumSpeed = max(length(params.windMinMax.zw), 0.0001);
  let normalizedSpeed = clamp(length(velocity) / maximumSpeed, 0.0, 1.0);
  let latitudeDistortion = max(abs(cos(radians(oldPosition.y * 180.0 - 90.0))), 0.15);
  let offset = vec2<f32>(velocity.x / latitudeDistortion, -velocity.y)
    * 0.0001 * params.windSizeDeltaSpeed.w * frameScale;
  var nextPosition = fract(oldPosition + offset + vec2<f32>(1.0));
  var previousPosition = oldPosition;

  let seed = nextPosition
    + vec2<f32>(f32(gid.x) * 0.000013, f32(gid.x) * 0.000029)
    + params.dropSeedFade.zz;
  let dropProbability = clamp(
    (params.dropSeedFade.x + normalizedSpeed * params.dropSeedFade.y) * frameScale,
    0.0,
    0.35,
  );
  if (random(seed) < dropProbability) {
    nextPosition = vec2<f32>(random(seed + 1.3), random(seed + 2.1));
    previousPosition = nextPosition;
  }

  particlesOut[gid.x] = Particle(nextPosition, previousPosition);
}
`;

export const WIND_PARTICLE_SHADER = /* wgsl */ `
struct Particle {
  position : vec2<f32>,
  previous : vec2<f32>,
}

struct Params {
  windMinMax : vec4<f32>,
  windSizeDeltaSpeed : vec4<f32>,
  dropSeedFade : vec4<f32>,
  viewportCount : vec4<f32>,
}

@group(0) @binding(0) var<storage, read> particles : array<Particle>;
@group(0) @binding(1) var windTexture : texture_2d<f32>;
@group(0) @binding(2) var windSampler : sampler;
@group(0) @binding(3) var<uniform> params : Params;

struct VertexOutput {
  @builtin(position) position : vec4<f32>,
  @location(0) speed : f32,
  @location(1) visible : f32,
}

@vertex
fn vertexMain(
  @builtin(vertex_index) _vertexIndex : u32,
  @builtin(instance_index) instanceIndex : u32,
) -> VertexOutput {
  let particle = particles[instanceIndex];
  let point = particle.position;
  let velocityEncoded = textureSampleLevel(windTexture, windSampler, particle.position, 0.0).rg;
  let velocity = mix(params.windMinMax.xy, params.windMinMax.zw, velocityEncoded);
  let maximumSpeed = max(length(params.windMinMax.zw), 0.0001);

  var output : VertexOutput;
  output.position = vec4<f32>(point.x * 2.0 - 1.0, 1.0 - point.y * 2.0, 0.0, 1.0);
  output.speed = clamp(length(velocity) / maximumSpeed, 0.0, 1.0);
  output.visible = 1.0;
  return output;
}

fn rampColor(t : f32) -> vec3<f32> {
  let blue = vec3<f32>(0.196, 0.533, 0.741);
  let teal = vec3<f32>(0.400, 0.761, 0.647);
  let green = vec3<f32>(0.671, 0.867, 0.643);
  let yellow = vec3<f32>(0.996, 0.878, 0.545);
  let orange = vec3<f32>(0.992, 0.682, 0.380);
  let red = vec3<f32>(0.957, 0.427, 0.263);
  let deepRed = vec3<f32>(0.835, 0.243, 0.310);
  if (t < 0.16) { return mix(blue, teal, t / 0.16); }
  if (t < 0.32) { return mix(teal, green, (t - 0.16) / 0.16); }
  if (t < 0.50) { return mix(green, yellow, (t - 0.32) / 0.18); }
  if (t < 0.68) { return mix(yellow, orange, (t - 0.50) / 0.18); }
  if (t < 0.84) { return mix(orange, red, (t - 0.68) / 0.16); }
  return mix(red, deepRed, (t - 0.84) / 0.16);
}

@fragment
fn fragmentMain(input : VertexOutput) -> @location(0) vec4<f32> {
  return vec4<f32>(rampColor(input.speed), 0.24 * input.visible);
}
`;

export const TRAIL_FADE_SHADER = /* wgsl */ `
struct Params {
  windMinMax : vec4<f32>,
  windSizeDeltaSpeed : vec4<f32>,
  dropSeedFade : vec4<f32>,
  viewportCount : vec4<f32>,
}

@group(0) @binding(0) var sourceTexture : texture_2d<f32>;
@group(0) @binding(1) var sourceSampler : sampler;
@group(0) @binding(2) var<uniform> params : Params;

struct VertexOutput {
  @builtin(position) position : vec4<f32>,
  @location(0) uv : vec2<f32>,
}

@vertex
fn vertexMain(@builtin(vertex_index) vertexIndex : u32) -> VertexOutput {
  let positions = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>(3.0, -1.0),
    vec2<f32>(-1.0, 3.0),
  );
  let point = positions[vertexIndex];
  var output : VertexOutput;
  output.position = vec4<f32>(point, 0.0, 1.0);
  output.uv = vec2<f32>(point.x * 0.5 + 0.5, 0.5 - point.y * 0.5);
  return output;
}

@fragment
fn fragmentMain(input : VertexOutput) -> @location(0) vec4<f32> {
  let previous = textureSampleLevel(sourceTexture, sourceSampler, input.uv, 0.0);
  let fade = params.dropSeedFade.w;
  return floor(previous * fade * 255.0) / 255.0;
}
`;

export const WIND_COMPOSITE_SHADER = /* wgsl */ `
@group(0) @binding(0) var trailTexture : texture_2d<f32>;
@group(0) @binding(1) var trailSampler : sampler;

struct VertexOutput {
  @builtin(position) position : vec4<f32>,
  @location(0) uv : vec2<f32>,
}

@vertex
fn vertexMain(@builtin(vertex_index) vertexIndex : u32) -> VertexOutput {
  let positions = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>(3.0, -1.0),
    vec2<f32>(-1.0, 3.0),
  );
  let point = positions[vertexIndex];
  var output : VertexOutput;
  output.position = vec4<f32>(point, 0.0, 1.0);
  output.uv = vec2<f32>(point.x * 0.5 + 0.5, 0.5 - point.y * 0.5);
  return output;
}

fn gridLine(value : f32) -> f32 {
  let width = max(fwidth(value), 0.0001);
  let distance = abs(fract(value - 0.5) - 0.5) / width;
  return 1.0 - smoothstep(0.0, 0.85, distance);
}

@fragment
fn fragmentMain(input : VertexOutput) -> @location(0) vec4<f32> {
  let uv = input.uv;
  let latitude = (0.5 - uv.y) * 180.0;
  let latitudeShade = 0.5 + 0.5 * cos(radians(latitude));
  let edgeShade = 1.0 - 0.28 * smoothstep(0.55, 1.0, length((uv - 0.5) * vec2<f32>(1.25, 1.7)));
  var background = mix(
    vec3<f32>(0.012, 0.032, 0.055),
    vec3<f32>(0.022, 0.075, 0.100),
    latitudeShade,
  ) * edgeShade;

  let longitudeGrid = gridLine(uv.x * 12.0);
  let latitudeGrid = gridLine(uv.y * 6.0);
  let equator = 1.0 - smoothstep(0.0, max(fwidth(uv.y), 0.0001) * 1.4, abs(uv.y - 0.5));
  let grid = max(max(longitudeGrid, latitudeGrid) * 0.20, equator * 0.30);
  background += vec3<f32>(0.10, 0.27, 0.33) * grid;

  let trail = textureSampleLevel(trailTexture, trailSampler, uv, 0.0).rgb;
  let color = background + trail * 1.18;
  return vec4<f32>(color, 1.0);
}
`;

export const COASTLINE_SHADER = /* wgsl */ `
struct Params {
  windMinMax : vec4<f32>,
  windSizeDeltaSpeed : vec4<f32>,
  dropSeedFade : vec4<f32>,
  viewportCount : vec4<f32>,
}

@group(0) @binding(0) var<uniform> params : Params;

struct VertexInput {
  @location(0) start : vec2<f32>,
  @location(1) end : vec2<f32>,
}

struct VertexOutput {
  @builtin(position) position : vec4<f32>,
  @location(0) edge : f32,
}

@vertex
fn vertexMain(input : VertexInput, @builtin(vertex_index) vertexIndex : u32) -> VertexOutput {
  let corners = array<vec2<f32>, 6>(
    vec2<f32>(0.0, -1.0), vec2<f32>(1.0, -1.0), vec2<f32>(0.0, 1.0),
    vec2<f32>(0.0, 1.0), vec2<f32>(1.0, -1.0), vec2<f32>(1.0, 1.0),
  );
  let corner = corners[vertexIndex];
  let viewport = max(params.viewportCount.xy, vec2<f32>(1.0));
  let startPixels = (input.start * 0.5 + vec2<f32>(0.5)) * viewport;
  let endPixels = (input.end * 0.5 + vec2<f32>(0.5)) * viewport;
  let segment = endPixels - startPixels;
  let tangent = segment / max(length(segment), 0.001);
  let normal = vec2<f32>(-tangent.y, tangent.x);
  let halfWidth = 1.25;
  let endpoint = mix(startPixels, endPixels, corner.x)
    + tangent * mix(-halfWidth, halfWidth, corner.x);
  let expanded = endpoint + normal * corner.y * halfWidth;

  var output : VertexOutput;
  output.position = vec4<f32>(expanded / viewport * 2.0 - vec2<f32>(1.0), 0.0, 1.0);
  output.edge = corner.y;
  return output;
}

@fragment
fn fragmentMain(input : VertexOutput) -> @location(0) vec4<f32> {
  let distanceToCenter = abs(input.edge);
  let feather = max(fwidth(distanceToCenter), 0.04);
  let coverage = 1.0 - smoothstep(1.0 - feather, 1.0, distanceToCenter);
  let core = 1.0 - smoothstep(0.18, 0.72, distanceToCenter);
  let color = mix(vec3<f32>(0.16, 0.49, 0.57), vec3<f32>(0.66, 0.91, 0.90), core);
  return vec4<f32>(color, mix(0.32, 0.68, core) * coverage);
}
`;
