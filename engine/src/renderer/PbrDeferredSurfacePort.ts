import type { PbrRenderer } from './PbrRenderer';

export interface PbrDeferredSurfaceShader {
  readonly module: GPUShaderModule;
  readonly key: string;
}
export interface PbrFullLightingState {
  shader(clearcoat: boolean, transmission: boolean): PbrDeferredSurfaceShader & { readonly pipelineLayout: GPUPipelineLayout };
  bindGroup(base: GPUBindGroup, entries: readonly GPUBindGroupEntry[]): GPUBindGroup;
}
export interface PbrDeferredSurfacePort {
  readonly layouts: readonly GPUBindGroupLayout[];
  setSurface(shader: PbrDeferredSurfaceShader | null): void;
  setFullLighting(state: PbrFullLightingState | null): void;
  lightingBindings(): readonly GPUBindGroupEntry[];
}
const ports = new WeakMap<PbrRenderer, PbrDeferredSurfacePort>();
/** Private port; no Deferred shader or provider is imported by the default PBR renderer. */
export function registerPbrDeferredSurfacePort(renderer: PbrRenderer, port: PbrDeferredSurfacePort): void { ports.set(renderer, port); }
export function deletePbrDeferredSurfacePort(renderer: PbrRenderer): void { ports.delete(renderer); }
export function getPbrDeferredSurfacePort(renderer: PbrRenderer): PbrDeferredSurfacePort {
  const port = ports.get(renderer);
  if (!port) throw new Error('PBR surface port requires a prepared renderer.');
  return port;
}
