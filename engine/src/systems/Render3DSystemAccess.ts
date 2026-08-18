import type { GpuDrivenBatchBuffer } from '../renderer/GpuDrivenBatchBuffer';
import type { Mesh3DRenderer } from '../renderer/Mesh3DRenderer';

interface ExperimentalRender3DSystemAccess {
  readonly gpuDrivenBatchBuffer: GpuDrivenBatchBuffer | null;
  addRenderer(renderer: Mesh3DRenderer): unknown;
  getGpuDrivenBatchIndexForEntity(entityId: number): number | undefined;
  getGpuDrivenMaterialSlot(materialId: number): number | undefined;
}

function experimentalAccess(system: unknown): ExperimentalRender3DSystemAccess {
  return system as unknown as ExperimentalRender3DSystemAccess;
}

/** Internal implementation behind the public Render3DSystem-typed facade. */
export function installRender3DMeshRenderer(
  system: unknown,
  renderer: Mesh3DRenderer,
): void {
  experimentalAccess(system).addRenderer(renderer);
}

export function readRender3DGpuDrivenBatchBuffer(
  system: unknown,
): GpuDrivenBatchBuffer | null {
  return experimentalAccess(system).gpuDrivenBatchBuffer;
}

export function readRender3DGpuDrivenBatchIndexForEntity(
  system: unknown,
  entityId: number,
): number | undefined {
  return experimentalAccess(system).getGpuDrivenBatchIndexForEntity(entityId);
}

export function readRender3DGpuDrivenMaterialSlot(
  system: unknown,
  materialId: number,
): number | undefined {
  return experimentalAccess(system).getGpuDrivenMaterialSlot(materialId);
}
