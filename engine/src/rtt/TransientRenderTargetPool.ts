import { getEngineGPUResourceTracker } from '../core/EngineDiagnosticsAccess';
import { estimateTextureBytes, type GPUResourceScope } from '../core/GPUResourceTracker';
import type { IEngine } from '../core/IEngine';
import type { RenderSampleCount } from '../core/RenderView';
import { RttEngine } from './RttEngine';

export interface TransientRenderTargetDescriptor {
  readonly width: number;
  readonly height: number;
  readonly sampleCount: RenderSampleCount;
  readonly reverseZ: boolean;
}

export interface TransientRenderTargetRequest<T> {
  readonly id: number;
  readonly scope: string;
  readonly descriptor: TransientRenderTargetDescriptor;
  readonly firstUse: number;
  readonly lastUse: number;
  readonly payload: T;
}

export interface TransientRenderTargetAssignment<T> extends TransientRenderTargetRequest<T> {
  readonly target: RttEngine;
  readonly physicalId: number;
  readonly aliased: boolean;
  readonly estimatedBytes: number;
}

export interface TransientRenderTargetScopeStats {
  readonly scope: string;
  readonly physicalId: number;
  readonly firstUse: number;
  readonly lastUse: number;
  readonly estimatedBytes: number;
  readonly aliased: boolean;
}

export interface TransientRenderTargetPoolStats {
  readonly logicalTargetCount: number;
  readonly physicalTargetCount: number;
  readonly allocationCount: number;
  readonly reuseCount: number;
  readonly aliasCount: number;
  readonly estimatedPhysicalBytes: number;
  readonly estimatedLogicalBytes: number;
  readonly savedBytes: number;
  readonly scopes: readonly TransientRenderTargetScopeStats[];
}

interface PhysicalTarget {
  id: number;
  key: string;
  target: RttEngine;
  scope: GPUResourceScope | null;
  estimatedBytes: number;
  lastUse: number;
  usedGeneration: number;
}

/** Frame-lifetime RTT allocator with interval aliasing. */
export class TransientRenderTargetPool {
  private readonly _targets: PhysicalTarget[] = [];
  private readonly _assignments: TransientRenderTargetAssignment<unknown>[] = [];
  private readonly _scopeStats: TransientRenderTargetScopeStats[] = [];
  private _generation = 0;
  private _nextPhysicalId = 0;
  private _allocationCount = 0;
  private readonly _stats: TransientRenderTargetPoolStats = {
    logicalTargetCount: 0,
    physicalTargetCount: 0,
    allocationCount: 0,
    reuseCount: 0,
    aliasCount: 0,
    estimatedPhysicalBytes: 0,
    estimatedLogicalBytes: 0,
    savedBytes: 0,
    scopes: this._scopeStats,
  };

  constructor(private readonly _engine: IEngine) {}

  get stats(): TransientRenderTargetPoolStats { return this._stats; }

  assign<T>(requests: readonly TransientRenderTargetRequest<T>[]): readonly TransientRenderTargetAssignment<T>[] {
    this._generation = nextGeneration(this._generation);
    this._assignments.length = 0;
    this._scopeStats.length = 0;
    for (const target of this._targets) target.lastUse = -1;
    const ordered = [...requests].sort(compareRequests);
    let aliases = 0;
    let reuses = 0;
    let logicalBytes = 0;
    for (const request of ordered) {
      const key = descriptorKey(request.descriptor);
      let physical = this._findAvailable(key, request.firstUse);
      const existing = physical !== null;
      const aliased = physical !== null && physical.lastUse >= 0;
      if (!physical) physical = this._createPhysical(request.descriptor, key, request.scope);
      else reuses++;
      if (aliased) aliases++;
      physical.lastUse = request.lastUse;
      physical.usedGeneration = this._generation;
      const estimatedBytes = estimateTransientRenderTargetBytes(this._engine, request.descriptor);
      logicalBytes += estimatedBytes;
      const assignment: TransientRenderTargetAssignment<T> = {
        ...request,
        target: physical.target,
        physicalId: physical.id,
        aliased,
        estimatedBytes,
      };
      this._assignments.push(assignment as TransientRenderTargetAssignment<unknown>);
      this._scopeStats.push({
        scope: request.scope,
        physicalId: physical.id,
        firstUse: request.firstUse,
        lastUse: request.lastUse,
        estimatedBytes,
        aliased,
      });
      void existing;
    }
    this._retireUnused();
    let physicalBytes = 0;
    let physicalCount = 0;
    for (const target of this._targets) {
      if (target.usedGeneration !== this._generation) continue;
      physicalBytes += target.estimatedBytes;
      physicalCount++;
    }
    Object.assign(this._stats, {
      logicalTargetCount: requests.length,
      physicalTargetCount: physicalCount,
      allocationCount: this._allocationCount,
      reuseCount: reuses,
      aliasCount: aliases,
      estimatedPhysicalBytes: physicalBytes,
      estimatedLogicalBytes: logicalBytes,
      savedBytes: Math.max(0, logicalBytes - physicalBytes),
    });
    return this._assignments as readonly TransientRenderTargetAssignment<T>[];
  }

  destroy(): void {
    for (const physical of this._targets) this._destroyPhysical(physical);
    this._targets.length = 0;
    this._assignments.length = 0;
    this._scopeStats.length = 0;
    Object.assign(this._stats, {
      logicalTargetCount: 0,
      physicalTargetCount: 0,
      reuseCount: 0,
      aliasCount: 0,
      estimatedPhysicalBytes: 0,
      estimatedLogicalBytes: 0,
      savedBytes: 0,
    });
  }

  private _findAvailable(key: string, firstUse: number): PhysicalTarget | null {
    for (const target of this._targets) {
      if (target.key === key && target.lastUse < firstUse) return target;
    }
    return null;
  }

  private _createPhysical(descriptor: TransientRenderTargetDescriptor, key: string, logicalScope: string): PhysicalTarget {
    const id = ++this._nextPhysicalId;
    const tracker = getEngineGPUResourceTracker(this._engine);
    const scope = tracker?.createScope('system', `TransientRTT:${id}:${logicalScope}`) ?? null;
    const previousOwner = scope ? tracker?.enterOwner(scope.owner) ?? null : null;
    let target: RttEngine;
    try {
      target = new RttEngine(
        this._engine,
        descriptor.width,
        descriptor.height,
        undefined,
        `TransientRTT:${id}`,
        scope?.owner ?? null,
      );
      target.msaaSamples = descriptor.sampleCount;
      target.reverseZ = descriptor.reverseZ;
    } finally {
      if (scope && tracker) tracker.leaveOwner(previousOwner);
    }
    const physical: PhysicalTarget = {
      id,
      key,
      target: target!,
      scope,
      estimatedBytes: estimateTransientRenderTargetBytes(this._engine, descriptor),
      lastUse: -1,
      usedGeneration: this._generation,
    };
    this._targets.push(physical);
    this._allocationCount++;
    return physical;
  }

  private _retireUnused(): void {
    for (let index = this._targets.length - 1; index >= 0; index--) {
      const physical = this._targets[index]!;
      if (physical.usedGeneration === this._generation) continue;
      this._destroyPhysical(physical);
      this._targets.splice(index, 1);
    }
  }

  private _destroyPhysical(physical: PhysicalTarget): void {
    physical.target.destroy();
    physical.scope?.release();
  }
}

function compareRequests<T>(a: TransientRenderTargetRequest<T>, b: TransientRenderTargetRequest<T>): number {
  return (a.firstUse - b.firstUse) || (a.lastUse - b.lastUse) || (a.id - b.id);
}

function descriptorKey(descriptor: TransientRenderTargetDescriptor): string {
  return `${descriptor.width}x${descriptor.height}:${descriptor.sampleCount}:${descriptor.reverseZ ? 1 : 0}`;
}

export function estimateTransientRenderTargetBytes(
  engine: IEngine,
  descriptor: TransientRenderTargetDescriptor,
): number {
  const size: GPUExtent3DStrict = [descriptor.width, descriptor.height];
  const color = estimateTextureBytes(size, engine.format, 1);
  const depth = estimateTextureBytes(size, engine.getDepthFormat(descriptor.reverseZ), descriptor.sampleCount);
  const msaa = descriptor.sampleCount > 1
    ? estimateTextureBytes(size, engine.format, descriptor.sampleCount)
    : 0;
  return color + depth + msaa;
}

function nextGeneration(value: number): number {
  const next = (value + 1) >>> 0;
  return next === 0 ? 1 : next;
}
