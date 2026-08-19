// Authoritative G05 path-tracing module. Artifact V2 is generated at build time;
// runtime code never concatenates or reflects WGSL.

const LEAF_BIT: u32 = 0x80000000u;
const INDEX_MASK: u32 = 0x7fffffffu;
const MISSING: u32 = 0xffffffffu;
const STACK_CAPACITY: u32 = 64u;
const MAX_DISTANCE: f32 = 3.402823466e+38;
const PI: f32 = 3.141592653589793;

struct PathParams {
  image: vec4u,
  scene: vec4u,
  cameraOrigin: vec4f,
  cameraRight: vec4f,
  cameraUp: vec4f,
  cameraForward: vec4f,
  environment: vec4f,
  render: vec4f,
}
struct LightData { kindFlags: vec4u, colorIntensity: vec4f, vectorRange: vec4f, position: vec4f }
struct LightBlock { values: array<LightData, 8> }
struct PathDiagnostics {
  pixels: atomic<u32>, rays: atomic<u32>, bounces: atomic<u32>, hits: atomic<u32>,
  misses: atomic<u32>, shadowRays: atomic<u32>, emissiveHits: atomic<u32>, stackOverflows: atomic<u32>,
  invalidAccesses: atomic<u32>, reserved0: atomic<u32>, reserved1: atomic<u32>, reserved2: atomic<u32>,
}
struct Candidate {
  status: u32, t: f32, barycentric: vec3f, kind: u32, geometryIndex: u32,
  sourcePrimitiveIndex: u32, packedPrimitiveIndex: u32, instanceIndex: u32,
  materialIndex: u32, frontFace: u32, position: vec3f, geometricNormal: vec3f,
}
struct Surface {
  normal: vec3f, baseColor: vec4f, emissive: vec3f, metallic: f32,
  roughness: f32, ior: f32, specularFactor: f32, specularColor: vec3f,
  occlusion: f32,
}
struct BsdfSample { direction: vec3f, weight: vec3f }

@group(0) @binding(0) var<uniform> params: PathParams;
@group(0) @binding(1) var<storage, read> blasNodes: array<u32>;
@group(0) @binding(2) var<storage, read> blasTable: array<u32>;
@group(0) @binding(3) var<storage, read> tlasNodes: array<u32>;
@group(0) @binding(4) var<storage, read> primitives: array<u32>;
@group(0) @binding(5) var<storage, read> instances: array<u32>;
@group(0) @binding(6) var<storage, read> materials: array<u32>;
@group(0) @binding(7) var<storage, read> surfaces: array<u32>;
@group(0) @binding(8) var<uniform> lights: LightBlock;
@group(0) @binding(9) var<storage, read_write> diagnostics: PathDiagnostics;
@group(0) @binding(10) var materialTextures: texture_2d_array<f32>;
@group(0) @binding(11) var materialSampler: sampler;
@group(0) @binding(12) var environmentTexture: texture_cube<f32>;
@group(0) @binding(13) var environmentSampler: sampler;
@group(0) @binding(14) var hdrOutput: texture_storage_2d<rgba16float, write>;

fn instance_f32(instanceIndex: u32, word: u32) -> f32 { return bitcast<f32>(instances[instanceIndex * 36u + word]); }
fn material_f32(materialIndex: u32, word: u32) -> f32 { return bitcast<f32>(materials[materialIndex * 32u + word]); }
fn surface_f32(primitiveIndex: u32, word: u32) -> f32 { return bitcast<f32>(surfaces[primitiveIndex * 32u + word]); }

fn transform_point(instanceIndex: u32, value: vec3f, inverse: bool) -> vec3f {
  let base = select(0u, 16u, inverse);
  let result = vec4f(
    instance_f32(instanceIndex, base) * value.x + instance_f32(instanceIndex, base + 4u) * value.y + instance_f32(instanceIndex, base + 8u) * value.z + instance_f32(instanceIndex, base + 12u),
    instance_f32(instanceIndex, base + 1u) * value.x + instance_f32(instanceIndex, base + 5u) * value.y + instance_f32(instanceIndex, base + 9u) * value.z + instance_f32(instanceIndex, base + 13u),
    instance_f32(instanceIndex, base + 2u) * value.x + instance_f32(instanceIndex, base + 6u) * value.y + instance_f32(instanceIndex, base + 10u) * value.z + instance_f32(instanceIndex, base + 14u),
    instance_f32(instanceIndex, base + 3u) * value.x + instance_f32(instanceIndex, base + 7u) * value.y + instance_f32(instanceIndex, base + 11u) * value.z + instance_f32(instanceIndex, base + 15u));
  return result.xyz / select(result.w, 1.0, result.w == 0.0);
}
fn transform_vector(instanceIndex: u32, value: vec3f, inverse: bool) -> vec3f {
  let base = select(0u, 16u, inverse);
  return vec3f(
    instance_f32(instanceIndex, base) * value.x + instance_f32(instanceIndex, base + 4u) * value.y + instance_f32(instanceIndex, base + 8u) * value.z,
    instance_f32(instanceIndex, base + 1u) * value.x + instance_f32(instanceIndex, base + 5u) * value.y + instance_f32(instanceIndex, base + 9u) * value.z,
    instance_f32(instanceIndex, base + 2u) * value.x + instance_f32(instanceIndex, base + 6u) * value.y + instance_f32(instanceIndex, base + 10u) * value.z);
}
fn transform_normal(instanceIndex: u32, value: vec3f) -> vec3f {
  return normalize(vec3f(
    instance_f32(instanceIndex, 16u) * value.x + instance_f32(instanceIndex, 17u) * value.y + instance_f32(instanceIndex, 18u) * value.z,
    instance_f32(instanceIndex, 20u) * value.x + instance_f32(instanceIndex, 21u) * value.y + instance_f32(instanceIndex, 22u) * value.z,
    instance_f32(instanceIndex, 24u) * value.x + instance_f32(instanceIndex, 25u) * value.y + instance_f32(instanceIndex, 26u) * value.z));
}
fn intersects_bounds(origin: vec3f, direction: vec3f, tMin: f32, tMax: f32, minimum: vec3f, maximum: vec3f) -> bool {
  var low = tMin; var high = tMax;
  for (var axis = 0u; axis < 3u; axis++) {
    let component = direction[axis];
    if (abs(component) <= 1e-20) {
      if (origin[axis] < minimum[axis] || origin[axis] > maximum[axis]) { return false; }
    } else {
      let inverse = 1.0 / component;
      let first = (minimum[axis] - origin[axis]) * inverse;
      let second = (maximum[axis] - origin[axis]) * inverse;
      low = max(low, min(first, second)); high = min(high, max(first, second));
      if (low > high) { return false; }
    }
  }
  return true;
}
fn node_hit(nodes: ptr<storage, array<u32>, read>, nodeIndex: u32, origin: vec3f, direction: vec3f, tMin: f32, tMax: f32) -> bool {
  let base = nodeIndex * 8u;
  return intersects_bounds(origin, direction, tMin, tMax,
    vec3f(bitcast<f32>((*nodes)[base]), bitcast<f32>((*nodes)[base + 1u]), bitcast<f32>((*nodes)[base + 2u])),
    vec3f(bitcast<f32>((*nodes)[base + 4u]), bitcast<f32>((*nodes)[base + 5u]), bitcast<f32>((*nodes)[base + 6u])));
}
fn empty_candidate(status: u32) -> Candidate {
  return Candidate(status, MAX_DISTANCE, vec3f(0.0), MISSING, MISSING, MISSING, MISSING, MISSING, MISSING, 0u, vec3f(0.0), vec3f(0.0));
}
fn triangle_candidate(primitiveIndex: u32, instanceIndex: u32, origin: vec3f, direction: vec3f, tMin: f32, tMax: f32) -> Candidate {
  let base = primitiveIndex * 16u;
  let p0 = transform_point(instanceIndex, vec3f(bitcast<f32>(primitives[base]), bitcast<f32>(primitives[base + 1u]), bitcast<f32>(primitives[base + 2u])), false);
  let p1 = transform_point(instanceIndex, vec3f(bitcast<f32>(primitives[base + 3u]), bitcast<f32>(primitives[base + 4u]), bitcast<f32>(primitives[base + 5u])), false);
  let p2 = transform_point(instanceIndex, vec3f(bitcast<f32>(primitives[base + 6u]), bitcast<f32>(primitives[base + 7u]), bitcast<f32>(primitives[base + 8u])), false);
  let e1 = p1 - p0; let e2 = p2 - p0; let winding = cross(e1, e2);
  if (dot(winding, winding) <= 1e-24 * max(dot(e1, e1) * dot(e2, e2), 1.0)) { return empty_candidate(0u); }
  let pvec = cross(direction, e2); let determinant = dot(e1, pvec);
  if (abs(determinant) <= 1e-12 * max(length(e1) * length(e2), 1.0)) { return empty_candidate(0u); }
  let inverseDeterminant = 1.0 / determinant; let tvec = origin - p0;
  let u = dot(tvec, pvec) * inverseDeterminant;
  if (u < -1e-6 || u > 1.0 + 1e-6) { return empty_candidate(0u); }
  let qvec = cross(tvec, e1); let v = dot(direction, qvec) * inverseDeterminant;
  if (v < -1e-6 || u + v > 1.0 + 1e-6) { return empty_candidate(0u); }
  let t = dot(e2, qvec) * inverseDeterminant; let epsilon = 1e-6 * max(1.0, abs(t));
  if (t < tMin - epsilon || t > tMax + epsilon) { return empty_candidate(0u); }
  let normal = normalize(winding); let frontFace = select(0u, 1u, dot(direction, normal) < 0.0);
  return Candidate(1u, t, vec3f(1.0 - u - v, u, v), 0u, primitives[base + 14u], primitives[base + 13u], primitiveIndex,
    instanceIndex, instances[instanceIndex * 36u + 33u], frontFace, origin + direction * t, normal);
}
fn sphere_candidate(primitiveIndex: u32, instanceIndex: u32, origin: vec3f, direction: vec3f, tMin: f32, tMax: f32) -> Candidate {
  let base = primitiveIndex * 16u; let localOrigin = transform_point(instanceIndex, origin, true); let localDirection = transform_vector(instanceIndex, direction, true);
  let center = vec3f(bitcast<f32>(primitives[base]), bitcast<f32>(primitives[base + 1u]), bitcast<f32>(primitives[base + 2u]));
  let radius = bitcast<f32>(primitives[base + 3u]); let offset = localOrigin - center;
  let a = dot(localDirection, localDirection); let halfB = dot(offset, localDirection); let c = dot(offset, offset) - radius * radius;
  let discriminant = halfB * halfB - a * c;
  if (discriminant < 0.0 || a <= 1e-12) { return empty_candidate(0u); }
  let root = sqrt(max(0.0, discriminant)); var t = (-halfB - root) / a;
  if (t < tMin || t > tMax) { t = (-halfB + root) / a; if (t < tMin || t > tMax) { return empty_candidate(0u); } }
  let normal = transform_normal(instanceIndex, normalize(localOrigin + localDirection * t - center));
  let frontFace = select(0u, 1u, dot(direction, normal) < 0.0);
  return Candidate(1u, t, vec3f(0.0), 1u, primitives[base + 14u], primitives[base + 13u], primitiveIndex,
    instanceIndex, instances[instanceIndex * 36u + 33u], frontFace, origin + direction * t, normal);
}
fn trace_scene(origin: vec3f, direction: vec3f, tMin: f32, tMax: f32, anyHit: bool) -> Candidate {
  atomicAdd(&diagnostics.rays, 1u);
  if (params.scene.x == MISSING) { return empty_candidate(0u); }
  var stack: array<u32, 64>; var stackSize = 1u; stack[0] = params.scene.x; var best = empty_candidate(0u); var bestIdentity = MISSING;
  loop {
    if (stackSize == 0u) { break; } stackSize--; let tlasNodeIndex = stack[stackSize];
    if (tlasNodeIndex * 8u + 7u >= arrayLength(&tlasNodes)) { atomicAdd(&diagnostics.invalidAccesses, 1u); return empty_candidate(3u); }
    if (!node_hit(&tlasNodes, tlasNodeIndex, origin, direction, tMin, min(tMax, best.t))) { continue; }
    let tlasBase = tlasNodeIndex * 8u; let leftFirst = tlasNodes[tlasBase + 3u]; let nodeMeta = tlasNodes[tlasBase + 7u];
    if ((nodeMeta & LEAF_BIT) == 0u) {
      if (stackSize + 2u > STACK_CAPACITY) { atomicAdd(&diagnostics.stackOverflows, 1u); return empty_candidate(2u); }
      stack[stackSize] = nodeMeta & INDEX_MASK; stack[stackSize + 1u] = leftFirst; stackSize += 2u; continue;
    }
    let instanceEnd = leftFirst + (nodeMeta & INDEX_MASK);
    for (var instanceIndex = leftFirst; instanceIndex < instanceEnd; instanceIndex++) {
      if (instanceIndex >= params.scene.y || instanceIndex * 36u + 35u >= arrayLength(&instances)) { atomicAdd(&diagnostics.invalidAccesses, 1u); return empty_candidate(3u); }
      let instanceBase = instanceIndex * 36u; let tableIndex = instances[instanceBase + 32u];
      if (tableIndex * 4u + 3u >= arrayLength(&blasTable)) { atomicAdd(&diagnostics.invalidAccesses, 1u); return empty_candidate(3u); }
      let blasRoot = blasTable[tableIndex * 4u]; if (blasRoot == MISSING) { continue; }
      let localOrigin = transform_point(instanceIndex, origin, true); let localDirection = transform_vector(instanceIndex, direction, true);
      let blasStackBase = stackSize;
      if (stackSize + 1u > STACK_CAPACITY) { atomicAdd(&diagnostics.stackOverflows, 1u); return empty_candidate(2u); }
      stack[stackSize] = blasRoot | LEAF_BIT; stackSize++;
      loop {
        if (stackSize == blasStackBase) { break; } stackSize--; let blasNodeIndex = stack[stackSize] & INDEX_MASK;
        if (blasNodeIndex * 8u + 7u >= arrayLength(&blasNodes)) { atomicAdd(&diagnostics.invalidAccesses, 1u); return empty_candidate(3u); }
        if (!node_hit(&blasNodes, blasNodeIndex, localOrigin, localDirection, tMin, min(tMax, best.t))) { continue; }
        let blasBase = blasNodeIndex * 8u; let primitiveFirst = blasNodes[blasBase + 3u]; let blasMeta = blasNodes[blasBase + 7u];
        if ((blasMeta & LEAF_BIT) == 0u) {
          if (stackSize + 2u > STACK_CAPACITY) { atomicAdd(&diagnostics.stackOverflows, 1u); return empty_candidate(2u); }
          stack[stackSize] = (blasMeta & INDEX_MASK) | LEAF_BIT; stack[stackSize + 1u] = primitiveFirst | LEAF_BIT; stackSize += 2u; continue;
        }
        let primitiveEnd = primitiveFirst + (blasMeta & INDEX_MASK);
        for (var primitiveIndex = primitiveFirst; primitiveIndex < primitiveEnd; primitiveIndex++) {
          if (primitiveIndex * 16u + 15u >= arrayLength(&primitives)) { atomicAdd(&diagnostics.invalidAccesses, 1u); return empty_candidate(3u); }
          var candidate = empty_candidate(0u); let kind = primitives[primitiveIndex * 16u + 12u];
          if (kind == 0u) { candidate = triangle_candidate(primitiveIndex, instanceIndex, origin, direction, tMin, tMax); }
          else if (kind == 1u) { candidate = sphere_candidate(primitiveIndex, instanceIndex, origin, direction, tMin, tMax); }
          if (candidate.status != 1u) { continue; }
          let identity = instances[instanceBase + 34u]; let tie = 1e-6 * max(max(1.0, abs(candidate.t)), abs(best.t));
          if (candidate.t < best.t - tie || (abs(candidate.t - best.t) <= tie && (identity < bestIdentity || (identity == bestIdentity && candidate.sourcePrimitiveIndex < best.sourcePrimitiveIndex)))) {
            best = candidate; bestIdentity = identity; if (anyHit) { return best; }
          }
        }
      }
    }
  }
  return best;
}

fn srgb_to_linear(value: vec3f) -> vec3f {
  let low = value / 12.92; let high = pow((value + vec3f(0.055)) / 1.055, vec3f(2.4));
  return select(high, low, value <= vec3f(0.04045));
}
fn surface_uv(candidate: Candidate, channel: u32) -> vec2f {
  if (candidate.kind == 1u) {
    let local = normalize(transform_point(candidate.instanceIndex, candidate.position, true));
    return vec2f(0.5 + atan2(local.z, local.x) / (2.0 * PI), acos(clamp(local.y, -1.0, 1.0)) / PI);
  }
  let base = candidate.packedPrimitiveIndex * 32u; let has = surfaces[base + 24u];
  if ((has & (1u << channel)) == 0u) { return vec2f(0.0); }
  let offset = select(12u, 18u, channel == 1u);
  let uv0 = vec2f(surface_f32(candidate.packedPrimitiveIndex, offset), surface_f32(candidate.packedPrimitiveIndex, offset + 1u));
  let uv1 = vec2f(surface_f32(candidate.packedPrimitiveIndex, offset + 2u), surface_f32(candidate.packedPrimitiveIndex, offset + 3u));
  let uv2 = vec2f(surface_f32(candidate.packedPrimitiveIndex, offset + 4u), surface_f32(candidate.packedPrimitiveIndex, offset + 5u));
  return uv0 * candidate.barycentric.x + uv1 * candidate.barycentric.y + uv2 * candidate.barycentric.z;
}
fn sample_material(layer: u32, uv: vec2f, srgb: bool) -> vec4f {
  if (layer == MISSING) { return vec4f(1.0); }
  let value = textureSampleLevel(materialTextures, materialSampler, fract(uv), i32(layer), 0.0);
  return vec4f(select(value.rgb, srgb_to_linear(value.rgb), srgb), value.a);
}
fn resolve_normal(candidate: Candidate, materialIndex: u32, uvChannel: u32, normalLayer: u32, scale: f32) -> vec3f {
  var normal = candidate.geometricNormal;
  if (candidate.kind == 0u && surfaces[candidate.packedPrimitiveIndex * 32u + 3u] != 0u) {
    let n0 = vec3f(surface_f32(candidate.packedPrimitiveIndex, 0u), surface_f32(candidate.packedPrimitiveIndex, 1u), surface_f32(candidate.packedPrimitiveIndex, 2u));
    let n1 = vec3f(surface_f32(candidate.packedPrimitiveIndex, 4u), surface_f32(candidate.packedPrimitiveIndex, 5u), surface_f32(candidate.packedPrimitiveIndex, 6u));
    let n2 = vec3f(surface_f32(candidate.packedPrimitiveIndex, 8u), surface_f32(candidate.packedPrimitiveIndex, 9u), surface_f32(candidate.packedPrimitiveIndex, 10u));
    normal = transform_normal(candidate.instanceIndex, normalize(n0 * candidate.barycentric.x + n1 * candidate.barycentric.y + n2 * candidate.barycentric.z));
    if (dot(normal, candidate.geometricNormal) < 0.0) { normal = -normal; }
  }
  if (normalLayer == MISSING) { return select(-normal, normal, candidate.frontFace != 0u); }
  let uv = surface_uv(candidate, uvChannel); var sampled = sample_material(normalLayer, uv, false).xyz * 2.0 - 1.0;
  sampled = normalize(vec3f(sampled.xy * scale, sampled.z));
  var tangent = normalize(cross(select(vec3f(0.0, 0.0, 1.0), vec3f(0.0, 1.0, 0.0), abs(normal.z) > 0.9), normal));
  if (candidate.kind == 0u) {
    let base = candidate.packedPrimitiveIndex * 16u;
    let p0 = transform_point(candidate.instanceIndex, vec3f(bitcast<f32>(primitives[base]), bitcast<f32>(primitives[base + 1u]), bitcast<f32>(primitives[base + 2u])), false);
    let p1 = transform_point(candidate.instanceIndex, vec3f(bitcast<f32>(primitives[base + 3u]), bitcast<f32>(primitives[base + 4u]), bitcast<f32>(primitives[base + 5u])), false);
    let p2 = transform_point(candidate.instanceIndex, vec3f(bitcast<f32>(primitives[base + 6u]), bitcast<f32>(primitives[base + 7u]), bitcast<f32>(primitives[base + 8u])), false);
    let uv0 = surface_uv(Candidate(candidate.status, candidate.t, vec3f(1.0, 0.0, 0.0), candidate.kind, candidate.geometryIndex, candidate.sourcePrimitiveIndex, candidate.packedPrimitiveIndex, candidate.instanceIndex, candidate.materialIndex, candidate.frontFace, candidate.position, candidate.geometricNormal), uvChannel);
    let uv1 = surface_uv(Candidate(candidate.status, candidate.t, vec3f(0.0, 1.0, 0.0), candidate.kind, candidate.geometryIndex, candidate.sourcePrimitiveIndex, candidate.packedPrimitiveIndex, candidate.instanceIndex, candidate.materialIndex, candidate.frontFace, candidate.position, candidate.geometricNormal), uvChannel);
    let uv2 = surface_uv(Candidate(candidate.status, candidate.t, vec3f(0.0, 0.0, 1.0), candidate.kind, candidate.geometryIndex, candidate.sourcePrimitiveIndex, candidate.packedPrimitiveIndex, candidate.instanceIndex, candidate.materialIndex, candidate.frontFace, candidate.position, candidate.geometricNormal), uvChannel);
    let duv1 = uv1 - uv0; let duv2 = uv2 - uv0; let determinant = duv1.x * duv2.y - duv1.y * duv2.x;
    if (abs(determinant) > 1e-8) { tangent = normalize(((p1 - p0) * duv2.y - (p2 - p0) * duv1.y) / determinant); }
  }
  let facing = select(-normal, normal, candidate.frontFace != 0u); let bitangent = normalize(cross(facing, tangent)); tangent = normalize(cross(bitangent, facing));
  return normalize(tangent * sampled.x + bitangent * sampled.y + facing * sampled.z);
}
fn resolve_surface(candidate: Candidate) -> Surface {
  let index = candidate.materialIndex; let baseLayer = materials[index * 32u + 16u]; let mrLayer = materials[index * 32u + 17u];
  let normalLayer = materials[index * 32u + 18u]; let occlusionLayer = materials[index * 32u + 19u]; let emissiveLayer = materials[index * 32u + 20u];
  let baseUv = surface_uv(candidate, materials[index * 32u + 22u]); let mrUv = surface_uv(candidate, materials[index * 32u + 23u]);
  let normalUvChannel = materials[index * 32u + 24u]; let occlusionUv = surface_uv(candidate, materials[index * 32u + 25u]); let emissiveUv = surface_uv(candidate, materials[index * 32u + 26u]);
  let baseSample = sample_material(baseLayer, baseUv, true); let mrSample = sample_material(mrLayer, mrUv, false);
  let emissiveSample = sample_material(emissiveLayer, emissiveUv, true); let occlusionSample = sample_material(occlusionLayer, occlusionUv, false);
  let baseColor = vec4f(material_f32(index, 0u), material_f32(index, 1u), material_f32(index, 2u), material_f32(index, 3u)) * baseSample;
  let emissive = vec3f(material_f32(index, 4u), material_f32(index, 5u), material_f32(index, 6u)) * emissiveSample.rgb;
  let metallic = material_f32(index, 7u) * mrSample.b; let roughness = clamp(material_f32(index, 8u) * mrSample.g, 0.04, 1.0);
  let normal = resolve_normal(candidate, index, normalUvChannel, normalLayer, material_f32(index, 11u));
  let occlusion = mix(1.0, occlusionSample.r, material_f32(index, 15u));
  return Surface(normal, baseColor, emissive, metallic, roughness, material_f32(index, 9u), material_f32(index, 10u),
    vec3f(material_f32(index, 12u), material_f32(index, 13u), material_f32(index, 14u)), occlusion);
}
fn fresnel_schlick(cosine: f32, f0: vec3f) -> vec3f { return f0 + (vec3f(1.0) - f0) * pow(1.0 - clamp(cosine, 0.0, 1.0), 5.0); }
fn evaluate_brdf(surface: Surface, view: vec3f, light: vec3f) -> vec3f {
  let n = surface.normal; let h = normalize(view + light); let nDotL = max(dot(n, light), 0.0); let nDotV = max(dot(n, view), 0.0);
  let nDotH = max(dot(n, h), 0.0); let vDotH = max(dot(view, h), 0.0); let alpha = surface.roughness * surface.roughness; let alpha2 = alpha * alpha;
  let denominator = nDotH * nDotH * (alpha2 - 1.0) + 1.0; let distribution = alpha2 / max(PI * denominator * denominator, 1e-6);
  let k = (surface.roughness + 1.0) * (surface.roughness + 1.0) / 8.0;
  let geometryV = nDotV / max(nDotV * (1.0 - k) + k, 1e-6); let geometryL = nDotL / max(nDotL * (1.0 - k) + k, 1e-6);
  let dielectric = pow((surface.ior - 1.0) / max(surface.ior + 1.0, 1e-4), 2.0) * surface.specularFactor * surface.specularColor;
  let f0 = mix(dielectric, surface.baseColor.rgb, surface.metallic); let fresnel = fresnel_schlick(vDotH, f0);
  let specular = distribution * geometryV * geometryL * fresnel / max(4.0 * nDotV * nDotL, 1e-5);
  let diffuse = (vec3f(1.0) - fresnel) * (1.0 - surface.metallic) * surface.baseColor.rgb / PI;
  return (diffuse + specular) * nDotL;
}
fn environment_radiance(direction: vec3f) -> vec3f {
  if ((params.scene.w & 1u) != 0u) {
    let angle = params.render.z; let rotated = vec3f(cos(angle) * direction.x - sin(angle) * direction.z, direction.y, sin(angle) * direction.x + cos(angle) * direction.z);
    return textureSampleLevel(environmentTexture, environmentSampler, rotated, 0.0).rgb * params.environment.w;
  }
  return params.environment.rgb * params.environment.w;
}
fn direct_lighting(candidate: Candidate, surface: Surface, view: vec3f) -> vec3f {
  var result = vec3f(0.0);
  for (var index = 0u; index < params.scene.z; index++) {
    let light = lights.values[index]; let kind = light.kindFlags.x;
    if (kind == 0u) { result += surface.baseColor.rgb * (1.0 - surface.metallic) * light.colorIntensity.rgb * light.colorIntensity.w * surface.occlusion; continue; }
    var direction = vec3f(0.0); var distance = MAX_DISTANCE; var attenuation = 1.0;
    if (kind == 1u) { direction = normalize(-light.vectorRange.xyz); }
    else {
      let offset = light.position.xyz - candidate.position; distance = length(offset); direction = offset / max(distance, 1e-8);
      if (distance >= light.vectorRange.w) { continue; }
      let rangeFactor = max(0.0, 1.0 - distance / max(light.vectorRange.w, 1e-6)); attenuation = rangeFactor * rangeFactor / max(distance * distance, 1.0);
    }
    if (dot(surface.normal, direction) <= 0.0) { continue; }
    atomicAdd(&diagnostics.shadowRays, 1u);
    let shadowMax = select(max(1e-4, distance - 1e-4), MAX_DISTANCE, distance == MAX_DISTANCE);
    let shadow = trace_scene(candidate.position + surface.normal * 1e-4, direction, 1e-4, shadowMax, true);
    if (shadow.status == 1u) { continue; }
    result += evaluate_brdf(surface, view, direction) * light.colorIntensity.rgb * light.colorIntensity.w * attenuation;
  }
  return result;
}
fn hash_rng(state: ptr<function, u32>) -> f32 {
  var value = (*state) + 0x9e3779b9u; value = (value ^ (value >> 16u)) * 0x21f0aaadu; value = (value ^ (value >> 15u)) * 0x735a2d97u; value ^= value >> 15u; (*state) = value;
  return f32(value) / 4294967296.0;
}
fn cosine_direction(normal: vec3f, state: ptr<function, u32>) -> vec3f {
  let u1 = hash_rng(state); let u2 = hash_rng(state); let radius = sqrt(u1); let phi = 2.0 * PI * u2;
  let tangent = normalize(cross(select(vec3f(0.0, 0.0, 1.0), vec3f(0.0, 1.0, 0.0), abs(normal.z) > 0.9), normal)); let bitangent = cross(normal, tangent);
  return normalize(tangent * (radius * cos(phi)) + bitangent * (radius * sin(phi)) + normal * sqrt(max(0.0, 1.0 - u1)));
}
fn sample_bsdf(surface: Surface, incoming: vec3f, state: ptr<function, u32>) -> BsdfSample {
  let dielectric = pow((surface.ior - 1.0) / max(surface.ior + 1.0, 1e-4), 2.0) * surface.specularFactor * surface.specularColor;
  let f0 = mix(dielectric, surface.baseColor.rgb, surface.metallic); let probability = clamp(0.25 + 0.65 * surface.metallic, 0.1, 0.9);
  if (hash_rng(state) < probability) {
    let perfect = reflect(incoming, surface.normal); let diffuse = cosine_direction(surface.normal, state); let direction = normalize(mix(perfect, diffuse, surface.roughness * surface.roughness));
    return BsdfSample(direction, fresnel_schlick(max(dot(-incoming, surface.normal), 0.0), f0) / probability);
  }
  return BsdfSample(cosine_direction(surface.normal, state), surface.baseColor.rgb * (1.0 - surface.metallic) / max(1.0 - probability, 0.1));
}
fn primary_ray(pixel: vec2u) -> mat2x3f {
  let uv = (vec2f(pixel) + vec2f(0.5)) / vec2f(params.image.xy); let ndc = uv * 2.0 - 1.0; let aspect = params.render.x;
  if ((params.scene.w & 2u) != 0u) {
    let height = params.cameraRight.w; let origin = params.cameraOrigin.xyz + params.cameraRight.xyz * (ndc.x * height * aspect * 0.5) - params.cameraUp.xyz * (ndc.y * height * 0.5);
    return mat2x3f(origin, normalize(params.cameraForward.xyz));
  }
  let direction = normalize(params.cameraForward.xyz + params.cameraRight.xyz * (ndc.x * params.cameraRight.w * aspect) - params.cameraUp.xyz * (ndc.y * params.cameraRight.w));
  return mat2x3f(params.cameraOrigin.xyz, direction);
}

@compute @workgroup_size(8, 8, 1)
fn path_main(@builtin(global_invocation_id) globalId: vec3u) {
  if (globalId.x >= params.image.x || globalId.y >= params.image.y) { return; }
  atomicAdd(&diagnostics.pixels, 1u); var random = params.image.w ^ ((globalId.y * params.image.x + globalId.x) * 0x9e3779b9u);
  let primary = primary_ray(globalId.xy); var origin = primary[0]; var direction = primary[1]; var throughput = vec3f(1.0); var radiance = vec3f(0.0);
  for (var bounce = 0u; bounce < params.image.z; bounce++) {
    atomicAdd(&diagnostics.bounces, 1u); let candidate = trace_scene(origin, direction, params.cameraOrigin.w, params.cameraForward.w, false);
    if (candidate.status == 0u) { atomicAdd(&diagnostics.misses, 1u); radiance += throughput * environment_radiance(direction); break; }
    if (candidate.status != 1u) { break; }
    atomicAdd(&diagnostics.hits, 1u);
    if (candidate.materialIndex == MISSING || candidate.materialIndex * 32u + 31u >= arrayLength(&materials)) { atomicAdd(&diagnostics.invalidAccesses, 1u); break; }
    let surface = resolve_surface(candidate); let view = -direction;
    if (max(max(surface.emissive.x, surface.emissive.y), surface.emissive.z) > 0.0) { atomicAdd(&diagnostics.emissiveHits, 1u); radiance += throughput * surface.emissive; }
    radiance += throughput * direct_lighting(candidate, surface, view);
    let sampled = sample_bsdf(surface, direction, &random); throughput *= sampled.weight; direction = normalize(sampled.direction); origin = candidate.position + surface.normal * 1e-4;
    if (max(max(throughput.x, throughput.y), throughput.z) < 1e-4) { break; }
  }
  textureStore(hdrOutput, vec2i(globalId.xy), vec4f(max(radiance, vec3f(0.0)), 1.0));
}
