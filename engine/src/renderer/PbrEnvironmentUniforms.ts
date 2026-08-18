import type { EnvironmentLight } from '../lighting/EnvironmentLight';

export interface PbrEnvironmentUniformOptions {
  readonly maxMipLevel?: number;
  readonly hasTexture?: boolean;
}

/**
 * Writes the shared 12-float PBR environment block.
 *
 * No EnvironmentLight means no image-based lighting. This intentionally differs
 * from an explicit EnvironmentLight without textures, which uses its diffuse and
 * specular colors as an analytic fallback.
 */
export function writePbrEnvironmentUniforms(
  target: Float32Array,
  environment: EnvironmentLight | null,
  options: PbrEnvironmentUniformOptions = {},
): Float32Array {
  target.fill(0);
  target[3] = 1;
  target[7] = 1;

  if (environment) {
    environment.diffuseColor.writeLinear(target, 0);
    environment.specularColor.writeLinear(target, 4);
    target[8] = environment.intensity;
    target[9] = environment.rotation;
  }

  target[10] = Math.max(0, options.maxMipLevel ?? 0);
  target[11] = options.hasTexture ? 1 : 0;
  return target;
}
