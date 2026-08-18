export const PILOT_VERTEX_WGSL = /* wgsl */ `
struct PilotVertexOutput {
  @builtin(position) position : vec4<f32>,
  @location(0) uv0 : vec2<f32>,
  @location(1) worldPosition : vec3<f32>,
  @location(2) worldNormal : vec3<f32>,
  @location(3) worldTangent : vec3<f32>,
  @location(4) tangentSign : f32,
}

@vertex fn pilotVertex(@builtin(vertex_index) vertexIndex : u32) -> PilotVertexOutput {
  let positions = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>(3.0, -1.0),
    vec2<f32>(-1.0, 3.0),
  );
  let position = positions[vertexIndex];
  var output : PilotVertexOutput;
  output.position = vec4<f32>(position, 0.0, 1.0);
  output.uv0 = position * 0.5 + vec2<f32>(0.5);
  output.worldPosition = vec3<f32>(position.x * 0.75, position.y * 0.5, 0.2 + position.x * 0.05);
  output.worldNormal = vec3<f32>(0.0, 0.0, 1.0);
  output.worldTangent = vec3<f32>(1.0, 0.0, 0.0);
  output.tangentSign = 1.0;
  return output;
}
`;

export const HANDWRITTEN_PBR_REFERENCE_WGSL = /* wgsl */ `
struct PilotFrameUniforms {
  @align(16) cameraPosition : vec3<f32>,
  lightDirection : vec3<f32>,
  lightColor : vec3<f32>,
  ambientColor : vec3<f32>,
  fogColor : vec3<f32>,
  fogStart : f32,
  fogEnd : f32,
}

struct PilotMaterialUniforms {
  @align(16) metallic : f32,
  noiseScale : f32,
  noiseStrength : f32,
  roughness : f32,
}

@group(0) @binding(0) var<uniform> pilotFrame : PilotFrameUniforms;
@group(2) @binding(0) var<uniform> pilotMaterial : PilotMaterialUniforms;
@group(2) @binding(1) var pilotAlbedo : texture_2d<f32>;
@group(2) @binding(2) var pilotNormal : texture_2d<f32>;
@group(2) @binding(3) var pilotSampler : sampler;

fn pilotSrgbToLinear(value : vec3<f32>) -> vec3<f32> {
  return select(
    value / vec3<f32>(12.92),
    pow((value + vec3<f32>(0.055)) / vec3<f32>(1.055), vec3<f32>(2.4)),
    value > vec3<f32>(0.04045),
  );
}

fn pilotSaturate(value : f32) -> f32 {
  return clamp(value, 0.0, 1.0);
}

fn pilotGeometrySchlick(nDot : f32, k : f32) -> f32 {
  return nDot / (nDot * (1.0 - k) + k);
}

@fragment fn referenceFragment(
  @location(0) uv0 : vec2<f32>,
  @location(1) worldPosition : vec3<f32>,
  @location(2) worldNormal : vec3<f32>,
  @location(3) worldTangent : vec3<f32>,
  @location(4) tangentSign : f32,
) -> @location(0) vec4<f32> {
  let noise = sin(worldPosition.y * pilotMaterial.noiseScale) * pilotMaterial.noiseStrength;
  let distortedUv = uv0 + vec2<f32>(noise);
  let albedoSample = textureSample(pilotAlbedo, pilotSampler, distortedUv);
  let albedoLinear = pilotSrgbToLinear(albedoSample.rgb);
  let heightFactor = clamp((worldPosition.y - -1.0) / (1.0 - -1.0), 0.0, 1.0);
  let heightColor = mix(vec3<f32>(0.12, 0.32, 0.92), vec3<f32>(1.0, 0.62, 0.12), heightFactor);
  let baseColor = albedoLinear * heightColor;

  let normalSample = textureSample(pilotNormal, pilotSampler, distortedUv);
  let normalTS = normalize(vec3<f32>(normalSample.xy * vec2<f32>(1.0) * vec2<f32>(2.0) - vec2<f32>(1.0), normalSample.z * 2.0 - 1.0));
  let tangent = normalize(worldTangent);
  let bitangent = normalize(cross(worldNormal, tangent)) * tangentSign;
  let normal = normalize(tangent * normalTS.x + bitangent * normalTS.y + worldNormal * normalTS.z);

  let viewDirection = normalize(pilotFrame.cameraPosition - worldPosition);
  let lightDirection = normalize(pilotFrame.lightDirection);
  let halfDirection = normalize(viewDirection + lightDirection);
  let nDotL = pilotSaturate(dot(normal, lightDirection));
  let nDotV = pilotSaturate(dot(normal, viewDirection));
  let nDotH = pilotSaturate(dot(normal, halfDirection));
  let vDotH = pilotSaturate(dot(viewDirection, halfDirection));

  let metallic = clamp(pilotMaterial.metallic, 0.0, 1.0);
  let roughness = clamp(pilotMaterial.roughness, 0.0, 1.0);
  let roughnessSquared = roughness * roughness;
  let alphaSquared = roughnessSquared * roughnessSquared;
  let distributionBase = nDotH * nDotH * (alphaSquared - 1.0) + 1.0;
  let distribution = alphaSquared / (3.141592653589793 * distributionBase * distributionBase);
  let geometryK = (roughness + 1.0) * (roughness + 1.0) / 8.0;
  let geometryTerm = pilotGeometrySchlick(nDotV, geometryK) * pilotGeometrySchlick(nDotL, geometryK);

  let f0 = mix(vec3<f32>(0.04), baseColor, metallic);
  let fresnel = f0 + (vec3<f32>(1.0) - f0) * pow(1.0 - vDotH, 5.0);
  let specular = fresnel * (distribution * geometryTerm) / clamp(4.0 * nDotV * nDotL, 0.001, 4.0);
  let diffuseWeight = (vec3<f32>(1.0) - fresnel) * (1.0 - metallic);
  let diffuse = diffuseWeight * baseColor * nDotL / 3.141592653589793;
  let direct = (diffuse + specular * nDotL) * pilotFrame.lightColor;
  let ambient = baseColor * pilotFrame.ambientColor;
  let lit = direct + ambient;

  let cameraVector = pilotFrame.cameraPosition - worldPosition;
  let distanceToCamera = sqrt(dot(cameraVector, cameraVector));
  let fogFactor = clamp((pilotFrame.fogEnd - distanceToCamera) / (pilotFrame.fogEnd - pilotFrame.fogStart), 0.0, 1.0);
  let fogged = mix(pilotFrame.fogColor, lit, fogFactor);
  return vec4<f32>(fogged, clamp(albedoSample.a, 0.0, 1.0));
}
`;

export const FULL_HANDWRITTEN_PBR_REFERENCE_WGSL = `${PILOT_VERTEX_WGSL}\n${HANDWRITTEN_PBR_REFERENCE_WGSL}`;

