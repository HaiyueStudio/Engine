/** G01's retained color limit includes both active allocations and safe-retirement overlap. */
export const REGION_CACHE_LIMITS = Object.freeze({maxRegions: 8, maxRetainedColorBytes: 64 * 1024 * 1024});
export interface RegionColorReservation {readonly bytes: number; release(): void;}
export type RegionColorReservationResult =
  | {readonly accepted: true; readonly reservation: RegionColorReservation}
  | {readonly accepted: false; readonly reason: 'region-count' | 'color-bytes'; readonly retainedBytes: number; readonly retainedRegions: number};

/** A reservation stays live until the GPU owner confirms retirement, not until logical replacement. */
export class RegionCacheBudget {
  private bytes = 0;
  private readonly regions = new Map<string, number>();
  snapshot(): Readonly<{retainedBytes: number; retainedRegions: number}> {return Object.freeze({retainedBytes: this.bytes, retainedRegions: this.regions.size});}
  reserve(id: string, colorBytes: number, countRegion = true): RegionColorReservationResult {
    if (typeof id !== 'string' || !id || !Number.isSafeInteger(colorBytes) || colorBytes <= 0) throw new Error('Invalid region color reservation.');
    const retained = this.snapshot();
    if (countRegion && !this.regions.has(id) && this.regions.size >= REGION_CACHE_LIMITS.maxRegions) return Object.freeze({accepted: false, reason: 'region-count', ...retained});
    if (colorBytes > REGION_CACHE_LIMITS.maxRetainedColorBytes - this.bytes) return Object.freeze({accepted: false, reason: 'color-bytes', ...retained});
    this.bytes += colorBytes; if (countRegion) this.regions.set(id, (this.regions.get(id) ?? 0) + 1);
    let released = false;
    return Object.freeze({accepted: true, reservation: Object.freeze({bytes: colorBytes, release: () => {
      if (released) return; released = true;
      this.bytes -= colorBytes;
      if (countRegion) {const count = this.regions.get(id)! - 1; if (count) this.regions.set(id, count); else this.regions.delete(id);}
    }})});
  }
}

// All view/scene owners sharing a device consume the same retained-color allowance.
const budgets = new WeakMap<GPUDevice, RegionCacheBudget>();
export function getRegionCacheBudget(device: GPUDevice): RegionCacheBudget {
  let budget = budgets.get(device);
  if (!budget) {budget = new RegionCacheBudget(); budgets.set(device, budget);}
  return budget;
}
