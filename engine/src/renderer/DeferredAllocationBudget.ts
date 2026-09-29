import { DeferredLightingCapabilityError } from '../frame/DeferredLightTable';
import type { RenderCommandContext } from '../core/RenderCommandContext';

/** Counts live descriptor bytes, including retired but still referenced generations.
 * Shared across profiles on the same device so profile replacement cannot double the ceiling. */
export class DeferredAllocationBudget {
  private _bytes = 0;
  private _peak = 0;
  constructor(readonly maximumBytes = 512 * 1024 * 1024) {}
  get bytes(): number { return this._bytes; }
  get peakBytes(): number { return this._peak; }
  reserve(bytes: number): () => void {
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new RangeError('Invalid Deferred allocation estimate.');
    const next = this._bytes + bytes;
    if (next > this.maximumBytes) throw new DeferredLightingCapabilityError('deferred-target-bytes', next, this.maximumBytes);
    this._bytes = next; this._peak = Math.max(this._peak, next);
    let released = false;
    return () => { if (!released) { released = true; this._bytes -= bytes; } };
  }
}
const budgets = new WeakMap<GPUDevice, DeferredAllocationBudget>();
export function getDeferredAllocationBudget(device: GPUDevice): DeferredAllocationBudget {
  let budget = budgets.get(device);
  if (!budget) { budget = new DeferredAllocationBudget(); budgets.set(device, budget); }
  return budget;
}

/** Conservative shared source/view/parameter reservation follows unsubmitted work too. */
export class DeferredSharedAllocationLease {
  private readonly _release: () => void;
  private readonly _encoders = new Set<GPUCommandEncoder>();
  private _retired = false;
  constructor(budget: DeferredAllocationBudget, bytes: number) { this._release = budget.reserve(bytes); }
  retain(context: RenderCommandContext): void {
    if (this._retired) throw new Error('Deferred shared reservation is retired.');
    if (!context.afterSubmit) throw new Error('Deferred shared reservation requires afterSubmit.');
    if (this._encoders.has(context.encoder)) return;
    this._encoders.add(context.encoder);
    context.afterSubmit(queue => {
      const done = () => { this._encoders.delete(context.encoder); this._settle(); };
      void queue.onSubmittedWorkDone().then(done, done);
    });
  }
  destroy(abandon = false): void {
    this._retired = true;
    if (abandon) this._encoders.clear();
    this._settle();
  }
  private _settle(): void { if (this._retired && !this._encoders.size) this._release(); }
}
