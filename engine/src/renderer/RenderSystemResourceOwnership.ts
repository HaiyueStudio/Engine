import { createGPUResourceOwner, type GPUResourceOwner, type GPUResourceTracker } from '../core/GPUResourceTracker';
import type { RenderPipelineExecutionBoundary, RenderPipelineSystem } from './RenderPipeline';

/** Concrete GPU ownership policy kept outside the scheduling/pass core. */
export class RenderSystemResourceOwnership implements RenderPipelineExecutionBoundary {
  private readonly _owners = new Map<RenderPipelineSystem, GPUResourceOwner>();

  constructor(private readonly _tracker: GPUResourceTracker) {}

  add(system: RenderPipelineSystem): void {
    this._requireOwner(system);
  }

  enter(system: RenderPipelineSystem): GPUResourceOwner | null {
    return this._tracker.enterOwner(this._requireOwner(system));
  }

  leave(token: unknown): void {
    this._tracker.leaveOwner(token as GPUResourceOwner | null);
  }

  remove(system: RenderPipelineSystem): void {
    const owner = this._owners.get(system);
    if (!owner) return;
    this._owners.delete(system);
    this._tracker.releaseOwner(owner);
  }

  clear(): void {
    for (const owner of this._owners.values()) this._tracker.releaseOwner(owner);
    this._owners.clear();
  }

  private _requireOwner(system: RenderPipelineSystem): GPUResourceOwner {
    let owner = this._owners.get(system);
    if (!owner) {
      owner = createGPUResourceOwner('system', getSystemResourceLabel(system));
      this._owners.set(system, owner);
    }
    return owner;
  }
}

function getSystemResourceLabel(system: RenderPipelineSystem): string {
  const value = system as { name?: unknown; id?: unknown; constructor?: { name?: string } };
  const name = typeof value.name === 'string' && value.name ? value.name : value.constructor?.name ?? 'RenderSystem';
  return typeof value.id === 'number' ? `${name}:${value.id}` : name;
}
