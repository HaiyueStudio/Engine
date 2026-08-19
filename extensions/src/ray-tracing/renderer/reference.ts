import { vec3n } from 'wgpu-matrix';
import type { RayVec3 } from '../reference/index.js';
import type { RayPathCamera, RayToneMapping } from './types.js';

export interface RayPbrSurfaceReference {
  readonly baseColor: RayVec3;
  readonly metallic: number;
  readonly roughness: number;
  readonly ior: number;
  readonly specularFactor: number;
  readonly specularColor: RayVec3;
  readonly normal: RayVec3;
}

export function createRayPathPrimaryRay(
  camera: RayPathCamera,
  width: number,
  height: number,
  x: number,
  y: number,
): Readonly<{ origin: RayVec3; direction: RayVec3 }> {
  if (![width, height, x, y].every(Number.isFinite) || width <= 0 || height <= 0) throw new RangeError('Invalid primary-ray pixel extent.');
  const ndcX = ((x + 0.5) / width) * 2 - 1;
  const ndcY = ((y + 0.5) / height) * 2 - 1;
  const aspect = width / height;
  if (camera.projection === 'orthographic') {
    const origin = add(add(camera.origin, scale(camera.right, ndcX * camera.orthographicHeight * aspect * 0.5)), scale(camera.up, -ndcY * camera.orthographicHeight * 0.5));
    return Object.freeze({ origin, direction: camera.forward });
  }
  const tangent = Math.tan(camera.verticalFov / 2);
  const direction = normalize(add(add(camera.forward, scale(camera.right, ndcX * tangent * aspect)), scale(camera.up, -ndcY * tangent)));
  return Object.freeze({ origin: camera.origin, direction });
}

export function evaluateRayPbrDirectReference(
  surface: RayPbrSurfaceReference,
  viewDirection: RayVec3,
  lightDirection: RayVec3,
  radiance: RayVec3,
): RayVec3 {
  const n = normalize(surface.normal); const v = normalize(viewDirection); const l = normalize(lightDirection);
  const h = normalize(add(v, l)); const nDotL = Math.max(dot(n, l), 0); const nDotV = Math.max(dot(n, v), 0);
  if (nDotL === 0 || nDotV === 0) return vec3(0, 0, 0);
  const nDotH = Math.max(dot(n, h), 0); const vDotH = Math.max(dot(v, h), 0);
  const alpha = surface.roughness * surface.roughness; const alpha2 = alpha * alpha;
  const denominator = nDotH * nDotH * (alpha2 - 1) + 1;
  const distribution = alpha2 / Math.max(Math.PI * denominator * denominator, 1e-6);
  const k = (surface.roughness + 1) ** 2 / 8;
  const geometry = (nDotV / Math.max(nDotV * (1 - k) + k, 1e-6)) * (nDotL / Math.max(nDotL * (1 - k) + k, 1e-6));
  const scalarF0 = ((surface.ior - 1) / Math.max(surface.ior + 1, 1e-4)) ** 2 * surface.specularFactor;
  const dielectric = multiply(surface.specularColor, vec3(scalarF0, scalarF0, scalarF0));
  const f0 = mix(dielectric, surface.baseColor, surface.metallic);
  const fresnelFactor = (1 - Math.min(1, Math.max(0, vDotH))) ** 5;
  const fresnel = add(f0, scale(subtract(vec3(1, 1, 1), f0), fresnelFactor));
  const specular = scale(fresnel, distribution * geometry / Math.max(4 * nDotV * nDotL, 1e-5));
  const diffuse = scale(multiply(subtract(vec3(1, 1, 1), fresnel), surface.baseColor), (1 - surface.metallic) / Math.PI);
  return scale(multiply(add(diffuse, specular), radiance), nDotL);
}

export function toneMapRayColor(linear: RayVec3, exposure = 1, operator: RayToneMapping = 'aces'): RayVec3 {
  const exposed = scale(linear, exposure);
  const mapped = operator === 'linear' ? clamp3(exposed)
    : operator === 'reinhard' ? vec3(...exposed.map(value => value / (1 + value)) as [number, number, number])
      : vec3(...exposed.map(value => Math.min(1, Math.max(0, value * (2.51 * value + 0.03) / (value * (2.43 * value + 0.59) + 0.14)))) as [number, number, number]);
  return vec3(...mapped.map(linearToSrgb) as [number, number, number]);
}

function add(a: RayVec3, b: RayVec3): RayVec3 { return fromArray(vec3n.add(a, b)); }
function subtract(a: RayVec3, b: RayVec3): RayVec3 { return fromArray(vec3n.subtract(a, b)); }
function multiply(a: RayVec3, b: RayVec3): RayVec3 { return fromArray(vec3n.mul(a, b)); }
function scale(a: RayVec3, value: number): RayVec3 { return fromArray(vec3n.mulScalar(a, value)); }
function normalize(a: RayVec3): RayVec3 { return fromArray(vec3n.normalize(a)); }
function dot(a: RayVec3, b: RayVec3): number { return vec3n.dot(a, b); }
function mix(a: RayVec3, b: RayVec3, amount: number): RayVec3 { return add(scale(a, 1 - amount), scale(b, amount)); }
function clamp3(value: RayVec3): RayVec3 { return vec3(Math.min(1, Math.max(0, value[0])), Math.min(1, Math.max(0, value[1])), Math.min(1, Math.max(0, value[2]))); }
function linearToSrgb(value: number): number { return value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055; }
function fromArray(value: ArrayLike<number>): RayVec3 { return vec3(value[0]!, value[1]!, value[2]!); }
function vec3(x: number, y: number, z: number): RayVec3 { return Object.freeze([x, y, z]); }
