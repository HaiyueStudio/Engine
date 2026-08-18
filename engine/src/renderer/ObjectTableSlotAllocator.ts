export class ObjectTableSlotAllocator {
  private _nextSlot = 0;
  private readonly _freeSlots: number[] = [];
  private readonly _freeSlotSet = new Set<number>();

  allocate(): number {
    const slot = this._freeSlots.pop();
    if (slot !== undefined) {
      this._freeSlotSet.delete(slot);
      return slot;
    }
    return this._nextSlot++;
  }

  release(slot: number): void {
    if (!Number.isInteger(slot) || slot < 0 || slot >= this._nextSlot) return;
    if (this._freeSlotSet.has(slot)) return;
    this._freeSlotSet.add(slot);
    this._freeSlots.push(slot);
  }

  reset(): void {
    this._nextSlot = 0;
    this._freeSlots.length = 0;
    this._freeSlotSet.clear();
  }

  get allocatedSlotCount(): number {
    return this._nextSlot - this._freeSlots.length;
  }

  get highWaterMark(): number {
    return this._nextSlot;
  }

  get freeSlotCount(): number {
    return this._freeSlots.length;
  }
}
