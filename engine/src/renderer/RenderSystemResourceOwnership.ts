import { createGPUResourceOwner, type GPUResourceOwner, type GPUResourceTracker } from '../core/GPUResourceTracker';
import type { RenderPipelineExecutionBoundary, RenderPipelineSystem } from './RenderPipeline';

interface SystemOwnerLease {readonly owner: GPUResourceOwner; registrations: number;}
// Pipeline registrations borrow the same original owner. No GPU handles live here.
const sharedOwners = new WeakMap<GPUResourceTracker, WeakMap<RenderPipelineSystem, SystemOwnerLease>>();

/** Concrete GPU ownership policy kept outside the scheduling/pass core. */
export class RenderSystemResourceOwnership implements RenderPipelineExecutionBoundary {
  private readonly _owners = new Map<RenderPipelineSystem, SystemOwnerLease>();

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
    const lease = this._owners.get(system);
    if (!lease) return;
    this._owners.delete(system);
    if (--lease.registrations === 0) {
      sharedOwners.get(this._tracker)?.delete(system);
      this._tracker.releaseOwner(lease.owner);
    }
  }

  clear(): void {
    for (const system of this._owners.keys()) this.remove(system);
  }

  private _requireOwner(system: RenderPipelineSystem): GPUResourceOwner {
    let lease = this._owners.get(system);
    if (!lease) {
      let owners = sharedOwners.get(this._tracker);
      if (!owners) {owners = new WeakMap(); sharedOwners.set(this._tracker, owners);}
      lease = owners.get(system);
      if (!lease) {
        lease = {owner: createGPUResourceOwner('system', getSystemResourceLabel(system)), registrations: 0};
        owners.set(system, lease);
      }
      lease.registrations++;
      this._owners.set(system, lease);
    }
    return lease.owner;
  }
}

function getSystemResourceLabel(system: RenderPipelineSystem): string {
  const value = system as { name?: unknown; id?: unknown; constructor?: { name?: string } };
  const name = typeof value.name === 'string' && value.name ? value.name : value.constructor?.name ?? 'RenderSystem';
  return typeof value.id === 'number' ? `${name}:${value.id}` : name;
}
