import type { PostProcessPass } from './PostProcessPass';

/** Private bridge: Deferred owns its AO instances; legacy postprocessing keeps its own lifecycle. */
export interface LightingAmbientOcclusionPort {
  composite(): boolean;
  create(): PostProcessPass;
  recorded?(target: PostProcessPass): void;
  configure(target: PostProcessPass, first: boolean): void;
}
const ports = new WeakMap<PostProcessPass, LightingAmbientOcclusionPort>();
export function registerLightingAmbientOcclusion(pass: PostProcessPass, port: LightingAmbientOcclusionPort): void { ports.set(pass, port); }
export function getLightingAmbientOcclusion(pass: PostProcessPass): LightingAmbientOcclusionPort | undefined {
  const port = ports.get(pass);
  return port?.composite() ? port : undefined;
}
