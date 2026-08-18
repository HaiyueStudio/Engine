import type { Frustum } from '../culling/Frustum';
import { EngineError, EngineErrorCode } from '../core/EngineError';

export type SpatialIndexKey = number | string | symbol | object;

export interface SpatialIndexStats {
  readonly entryCount: number;
  readonly nodeCount: number;
  readonly rebuildCount: number;
  readonly refitCount: number;
  readonly insertionCount: number;
  readonly removalCount: number;
  readonly rotationCount: number;
}

interface SpatialEntry<T> {
  key: SpatialIndexKey;
  value: T;
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
  centerX: number;
  centerY: number;
  centerZ: number;
  seenGeneration: number;
  leafNode: number;
  dirtyGeneration: number;
}

interface SpatialNode {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
  start: number;
  end: number;
  left: number;
  right: number;
  parent: number;
  refitGeneration: number;
}

/**
 * Allocation-stable broad-phase BVH for world-space AABBs.
 *
 * Updates are transactional: call beginUpdate(), upsert every live entry, then
 * endUpdate(). Entries omitted from a transaction are removed automatically.
 * Query methods append into caller-owned containers and allocate no temporary
 * arrays after the index has warmed up.
 */
export class SpatialIndex<T> {
  private readonly _entriesByKey = new Map<SpatialIndexKey, SpatialEntry<T>>();
  private readonly _entries: SpatialEntry<T>[] = [];
  private readonly _entryPool: SpatialEntry<T>[] = [];
  private readonly _nodes: SpatialNode[] = [];
  private readonly _nodePool: SpatialNode[] = [];
  private readonly _freeNodeIndices: number[] = [];
  private readonly _stack: number[] = [];
  private readonly _frustumPlanes = new Float32Array(24);
  private _root = -1;
  private _generation = 0;
  private _leafSize: number;
  private _updating = false;
  private _incrementalUpdating = false;
  private _dirty = false;
  private _rebuildCount = 0;
  private _refitCount = 0;
  private _incrementalGeneration = 0;
  private _incrementalStructuralDirty = false;
  private _incrementalStructuralCount = 0;
  private readonly _incrementalDirtyEntries: SpatialEntry<T>[] = [];
  private readonly _incrementalDirtyNodes: number[] = [];
  private _treeSurfaceArea = 0;
  private _baselineTreeSurfaceArea = 0;
  private _activeNodeCount = 0;
  private _insertionCount = 0;
  private _removalCount = 0;
  private _rotationCount = 0;

  constructor(leafSize = 8) {
    this._leafSize = normalizeLeafSize(leafSize);
  }

  get entryCount(): number { return this._entriesByKey.size; }
  get nodeCount(): number { return this._activeNodeCount; }
  get rebuildCount(): number { return this._rebuildCount; }
  get refitCount(): number { return this._refitCount; }
  get insertionCount(): number { return this._insertionCount; }
  get removalCount(): number { return this._removalCount; }
  get rotationCount(): number { return this._rotationCount; }
  get leafSize(): number { return this._leafSize; }
  get stats(): SpatialIndexStats {
    return {
      entryCount: this.entryCount,
      nodeCount: this.nodeCount,
      rebuildCount: this.rebuildCount,
      refitCount: this.refitCount,
      insertionCount: this.insertionCount,
      removalCount: this.removalCount,
      rotationCount: this.rotationCount,
    };
  }

  beginUpdate(leafSize = this._leafSize): this {
    if (this._updating || this._incrementalUpdating) throw spatialStateError('SpatialIndex.beginUpdate() cannot be nested.');
    const normalizedLeafSize = normalizeLeafSize(leafSize);
    if (normalizedLeafSize !== this._leafSize) {
      this._leafSize = normalizedLeafSize;
      this._dirty = true;
    }
    this._generation = (this._generation + 1) >>> 0;
    if (this._generation === 0) {
      this._generation = 1;
      for (const entry of this._entriesByKey.values()) entry.seenGeneration = 0;
    }
    this._updating = true;
    return this;
  }

  upsert(
    key: SpatialIndexKey,
    value: T,
    minX: number,
    minY: number,
    minZ: number,
    maxX: number,
    maxY: number,
    maxZ: number,
  ): this {
    if (!this._updating) throw spatialStateError('SpatialIndex.upsert() requires an active update transaction.');
    validateBounds(minX, minY, minZ, maxX, maxY, maxZ);
    let entry = this._entriesByKey.get(key);
    if (!entry) {
      entry = this._entryPool.pop() ?? createSpatialEntry<T>();
      entry.key = key;
      this._entriesByKey.set(key, entry);
      this._dirty = true;
    }
    if (
      entry.value !== value
      || entry.minX !== minX || entry.minY !== minY || entry.minZ !== minZ
      || entry.maxX !== maxX || entry.maxY !== maxY || entry.maxZ !== maxZ
    ) {
      entry.value = value;
      entry.minX = minX;
      entry.minY = minY;
      entry.minZ = minZ;
      entry.maxX = maxX;
      entry.maxY = maxY;
      entry.maxZ = maxZ;
      entry.centerX = (minX + maxX) * 0.5;
      entry.centerY = (minY + maxY) * 0.5;
      entry.centerZ = (minZ + maxZ) * 0.5;
      this._dirty = true;
    }
    entry.seenGeneration = this._generation;
    return this;
  }

  endUpdate(): boolean {
    if (!this._updating) throw spatialStateError('SpatialIndex.endUpdate() requires an active update transaction.');
    this._updating = false;
    for (const [key, entry] of this._entriesByKey) {
      if (entry.seenGeneration === this._generation) continue;
      this._entriesByKey.delete(key);
      releaseSpatialEntry(entry);
      this._entryPool.push(entry);
      this._dirty = true;
    }
    if (!this._dirty) return false;
    this._rebuild();
    this._dirty = false;
    return true;
  }

  cancelUpdate(): this {
    this._updating = false;
    if (this._dirty) {
      this._rebuild();
      this._dirty = false;
    }
    return this;
  }

  /** Starts a sparse update that preserves tree topology when only bounds change. */
  beginIncrementalUpdate(leafSize = this._leafSize): this {
    if (this._updating || this._incrementalUpdating) {
      throw spatialStateError('SpatialIndex.beginIncrementalUpdate() cannot be nested.');
    }
    const normalizedLeafSize = normalizeLeafSize(leafSize);
    this._incrementalStructuralDirty = normalizedLeafSize !== this._leafSize;
    this._leafSize = normalizedLeafSize;
    this._incrementalGeneration = (this._incrementalGeneration + 1) >>> 0;
    if (this._incrementalGeneration === 0) {
      this._incrementalGeneration = 1;
      for (const entry of this._entriesByKey.values()) entry.dirtyGeneration = 0;
      for (const node of this._nodes) node.refitGeneration = 0;
    }
    this._incrementalDirtyEntries.length = 0;
    this._incrementalStructuralCount = 0;
    this._incrementalUpdating = true;
    return this;
  }

  /** Adds or updates one sparse entry without sweeping unrelated entries. */
  upsertIncremental(
    key: SpatialIndexKey,
    value: T,
    minX: number,
    minY: number,
    minZ: number,
    maxX: number,
    maxY: number,
    maxZ: number,
  ): this {
    if (!this._incrementalUpdating) {
      throw spatialStateError('SpatialIndex.upsertIncremental() requires an active incremental update.');
    }
    validateBounds(minX, minY, minZ, maxX, maxY, maxZ);
    let entry = this._entriesByKey.get(key);
    const inserted = !entry;
    if (!entry) {
      entry = this._entryPool.pop() ?? createSpatialEntry<T>();
      entry.key = key;
      this._entriesByKey.set(key, entry);
    }
    if (
      !inserted
      && entry.value === value
      && entry.minX === minX && entry.minY === minY && entry.minZ === minZ
      && entry.maxX === maxX && entry.maxY === maxY && entry.maxZ === maxZ
    ) return this;
    entry.value = value;
    entry.minX = minX;
    entry.minY = minY;
    entry.minZ = minZ;
    entry.maxX = maxX;
    entry.maxY = maxY;
    entry.maxZ = maxZ;
    entry.centerX = (minX + maxX) * 0.5;
    entry.centerY = (minY + maxY) * 0.5;
    entry.centerZ = (minZ + maxZ) * 0.5;
    if (inserted) {
      this._insertEntry(entry);
      this._incrementalStructuralCount++;
      this._insertionCount++;
      return this;
    }
    this._markIncrementalDirty(entry);
    return this;
  }

  /** Removes one sparse entry and repairs only the affected leaf ancestry. */
  removeIncremental(key: SpatialIndexKey): boolean {
    if (!this._incrementalUpdating) {
      throw spatialStateError('SpatialIndex.removeIncremental() requires an active incremental update.');
    }
    const entry = this._entriesByKey.get(key);
    if (!entry) return false;
    this._removeEntry(entry);
    this._entriesByKey.delete(key);
    releaseSpatialEntry(entry);
    this._entryPool.push(entry);
    this._incrementalStructuralCount++;
    this._removalCount++;
    return true;
  }

  /** Refit sparse leaves, rebuilding only for structural, high-churn, or degraded updates. */
  endIncrementalUpdate(rebuildRatio = 0.25, degradationRatio = 2): boolean {
    if (!this._incrementalUpdating) {
      throw spatialStateError('SpatialIndex.endIncrementalUpdate() requires an active incremental update.');
    }
    this._incrementalUpdating = false;
    const dirtyCount = this._incrementalDirtyEntries.length;
    const changedCount = dirtyCount + this._incrementalStructuralCount;
    if (!this._incrementalStructuralDirty && changedCount === 0) return false;
    const normalizedRebuildRatio = Math.min(1, Math.max(0, Number.isFinite(rebuildRatio) ? rebuildRatio : 0.25));
    if (
      this._incrementalStructuralDirty
      || (
        this.entryCount >= this._leafSize * 4
        && changedCount / Math.max(1, this.entryCount) >= normalizedRebuildRatio
      )
    ) {
      this._rebuild();
      this._incrementalStructuralDirty = false;
      return true;
    }
    this._refitDirtyEntries();
    this._refitCount++;
    if (this._incrementalStructuralCount > 0) {
      this._treeSurfaceArea = this._computeTreeSurfaceArea();
      this._baselineTreeSurfaceArea = this._treeSurfaceArea;
    }
    const normalizedDegradationRatio = Math.max(1, Number.isFinite(degradationRatio) ? degradationRatio : 2);
    if (
      this._baselineTreeSurfaceArea > 0
      && this._treeSurfaceArea > this._baselineTreeSurfaceArea * normalizedDegradationRatio
    ) {
      this._rebuild();
    }
    this._incrementalStructuralDirty = false;
    this._incrementalStructuralCount = 0;
    return true;
  }

  cancelIncrementalUpdate(): this {
    if (!this._incrementalUpdating) return this;
    this._incrementalUpdating = false;
    if (this._incrementalStructuralDirty || this._incrementalDirtyEntries.length > 0) this._rebuild();
    this._incrementalStructuralDirty = false;
    this._incrementalStructuralCount = 0;
    this._incrementalDirtyEntries.length = 0;
    this._incrementalDirtyNodes.length = 0;
    return this;
  }

  queryPoint(x: number, y: number, z: number, out: Set<T>): Set<T> {
    this._assertQueryable();
    if (this._root < 0) return out;
    const stack = this._stack;
    stack.length = 0;
    stack.push(this._root);
    while (stack.length > 0) {
      const nodeIndex = stack.pop();
      if (nodeIndex === undefined) continue;
      const node = this._nodes[nodeIndex];
      if (!node || !containsPoint(node, x, y, z)) continue;
      if (node.left >= 0) {
        stack.push(node.left, node.right);
        continue;
      }
      for (let i = node.start; i < node.end; i++) {
        const entry = this._entries[i];
        if (entry && containsPoint(entry, x, y, z)) out.add(entry.value);
      }
    }
    stack.length = 0;
    return out;
  }

  queryRay(
    origin: ArrayLike<number>,
    direction: ArrayLike<number>,
    maxDistance: number,
    out: T[],
  ): T[] {
    this._assertQueryable();
    if (this._root < 0) return out;
    const ox = origin[0] ?? 0, oy = origin[1] ?? 0, oz = origin[2] ?? 0;
    const dx = direction[0] ?? 0, dy = direction[1] ?? 0, dz = direction[2] ?? 0;
    const stack = this._stack;
    stack.length = 0;
    stack.push(this._root);
    while (stack.length > 0) {
      const nodeIndex = stack.pop();
      if (nodeIndex === undefined) continue;
      const node = this._nodes[nodeIndex];
      if (!node || !rayIntersectsBounds(node, ox, oy, oz, dx, dy, dz, maxDistance)) continue;
      if (node.left >= 0) {
        stack.push(node.left, node.right);
        continue;
      }
      for (let i = node.start; i < node.end; i++) {
        const entry = this._entries[i];
        if (entry && rayIntersectsBounds(entry, ox, oy, oz, dx, dy, dz, maxDistance)) out.push(entry.value);
      }
    }
    stack.length = 0;
    return out;
  }

  queryFrustum(frustum: Frustum, out: T[]): T[] {
    this._assertQueryable();
    if (this._root < 0) return out;
    const planes = frustum.copyPlanesTo(this._frustumPlanes);
    const stack = this._stack;
    stack.length = 0;
    stack.push(this._root);
    while (stack.length > 0) {
      const nodeIndex = stack.pop();
      if (nodeIndex === undefined) continue;
      const node = this._nodes[nodeIndex];
      if (!node || !frustumIntersectsBounds(node, planes)) continue;
      if (node.left >= 0) {
        stack.push(node.left, node.right);
        continue;
      }
      for (let i = node.start; i < node.end; i++) {
        const entry = this._entries[i];
        if (entry && frustumIntersectsBounds(entry, planes)) out.push(entry.value);
      }
    }
    stack.length = 0;
    return out;
  }

  clear(): this {
    for (const entry of this._entriesByKey.values()) {
      releaseSpatialEntry(entry);
      this._entryPool.push(entry);
    }
    this._entriesByKey.clear();
    this._entries.length = 0;
    for (const node of this._nodes) this._nodePool.push(node);
    this._nodes.length = 0;
    this._freeNodeIndices.length = 0;
    this._stack.length = 0;
    this._root = -1;
    this._updating = false;
    this._incrementalUpdating = false;
    this._dirty = false;
    this._incrementalStructuralDirty = false;
    this._incrementalStructuralCount = 0;
    this._incrementalDirtyEntries.length = 0;
    this._incrementalDirtyNodes.length = 0;
    this._treeSurfaceArea = 0;
    this._baselineTreeSurfaceArea = 0;
    this._activeNodeCount = 0;
    return this;
  }

  dispose(): void {
    this.clear();
    this._entryPool.length = 0;
    this._nodePool.length = 0;
  }

  private _assertQueryable(): void {
    if (this._updating || this._incrementalUpdating) throw spatialStateError('SpatialIndex cannot be queried before endUpdate() or endIncrementalUpdate().');
  }

  private _rebuild(): void {
    this._entries.length = 0;
    for (const entry of this._entriesByKey.values()) this._entries.push(entry);
    for (const node of this._nodes) this._nodePool.push(node);
    this._nodes.length = 0;
    this._freeNodeIndices.length = 0;
    this._activeNodeCount = 0;
    this._root = this._entries.length > 0 ? this._buildNode(0, this._entries.length) : -1;
    this._treeSurfaceArea = this._computeTreeSurfaceArea();
    this._baselineTreeSurfaceArea = this._treeSurfaceArea;
    this._rebuildCount++;
  }

  private _buildNode(start: number, end: number, parent = -1): number {
    const nodeIndex = this._allocateNode(parent);
    const node = this._nodes[nodeIndex]!;
    node.start = start;
    node.end = end;
    node.left = -1;
    node.right = -1;
    node.refitGeneration = 0;
    writeNodeBounds(node, this._entries, start, end);
    if (end - start <= this._leafSize) {
      for (let i = start; i < end; i++) {
        const entry = this._entries[i];
        if (entry) entry.leafNode = nodeIndex;
      }
      return nodeIndex;
    }

    const extentX = node.maxX - node.minX;
    const extentY = node.maxY - node.minY;
    const extentZ = node.maxZ - node.minZ;
    const axis = extentX >= extentY && extentX >= extentZ ? 0 : extentY >= extentZ ? 1 : 2;
    sortEntriesRangeByAxis(this._entries, start, end - 1, axis);
    const middle = start + ((end - start) >> 1);
    node.left = this._buildNode(start, middle, nodeIndex);
    node.right = this._buildNode(middle, end, nodeIndex);
    return nodeIndex;
  }

  private _allocateNode(parent: number): number {
    const freeIndex = this._freeNodeIndices.pop();
    const node = freeIndex === undefined
      ? this._nodePool.pop() ?? createSpatialNode()
      : this._nodes[freeIndex]!;
    node.parent = parent;
    node.left = -1;
    node.right = -1;
    node.refitGeneration = 0;
    this._activeNodeCount++;
    if (freeIndex === undefined) {
      const nodeIndex = this._nodes.length;
      this._nodes.push(node);
      return nodeIndex;
    }
    return freeIndex;
  }

  private _releaseNode(nodeIndex: number): void {
    const node = this._nodes[nodeIndex];
    if (!node || node.parent === FREE_NODE_PARENT) return;
    node.parent = FREE_NODE_PARENT;
    node.left = -1;
    node.right = -1;
    node.start = 0;
    node.end = 0;
    this._freeNodeIndices.push(nodeIndex);
    this._activeNodeCount--;
  }

  private _computeTreeSurfaceArea(): number {
    let surfaceArea = 0;
    for (const node of this._nodes) {
      if (node.parent !== FREE_NODE_PARENT) surfaceArea += boundsSurfaceArea(node);
    }
    return surfaceArea;
  }

  private _insertEntry(entry: SpatialEntry<T>): void {
    if (this._root < 0) {
      this._entries.push(entry);
      this._root = this._buildNode(0, 1);
      return;
    }
    const leafIndex = this._findBestLeaf(entry);
    const leaf = this._nodes[leafIndex]!;
    const insertionIndex = leaf.end;
    for (const node of this._nodes) {
      if (node.parent === FREE_NODE_PARENT || node.start < insertionIndex) continue;
      node.start++;
      node.end++;
    }
    let ancestorIndex = leafIndex;
    while (ancestorIndex >= 0) {
      const ancestor = this._nodes[ancestorIndex];
      if (!ancestor) break;
      ancestor.end++;
      ancestorIndex = ancestor.parent;
    }
    this._entries.splice(insertionIndex, 0, entry);
    entry.leafNode = leafIndex;
    if (leaf.end - leaf.start > this._leafSize) this._splitLeaf(leafIndex);
    this._refitAncestors(leafIndex);
  }

  private _findBestLeaf(entry: SpatialEntry<T>): number {
    let nodeIndex = this._root;
    while (nodeIndex >= 0) {
      const node = this._nodes[nodeIndex]!;
      if (node.left < 0) return nodeIndex;
      const left = this._nodes[node.left]!;
      const right = this._nodes[node.right]!;
      const leftCost = combinedSurfaceArea(left, entry) - boundsSurfaceArea(left);
      const rightCost = combinedSurfaceArea(right, entry) - boundsSurfaceArea(right);
      nodeIndex = leftCost <= rightCost ? node.left : node.right;
    }
    return this._root;
  }

  private _splitLeaf(leafIndex: number): void {
    const leaf = this._nodes[leafIndex];
    if (!leaf || leaf.left >= 0 || leaf.end - leaf.start <= this._leafSize) return;
    const extentX = leaf.maxX - leaf.minX;
    const extentY = leaf.maxY - leaf.minY;
    const extentZ = leaf.maxZ - leaf.minZ;
    const axis = extentX >= extentY && extentX >= extentZ ? 0 : extentY >= extentZ ? 1 : 2;
    sortEntriesRangeByAxis(this._entries, leaf.start, leaf.end - 1, axis);
    const middle = leaf.start + ((leaf.end - leaf.start) >> 1);
    leaf.left = this._buildNode(leaf.start, middle, leafIndex);
    leaf.right = this._buildNode(middle, leaf.end, leafIndex);
  }

  private _removeEntry(entry: SpatialEntry<T>): void {
    const leafIndex = entry.leafNode;
    const leaf = this._nodes[leafIndex];
    if (!leaf || leaf.parent === FREE_NODE_PARENT) return;
    let removalIndex = -1;
    for (let i = leaf.start; i < leaf.end; i++) {
      if (this._entries[i] === entry) {
        removalIndex = i;
        break;
      }
    }
    if (removalIndex < 0) return;
    this._entries.splice(removalIndex, 1);
    for (const node of this._nodes) {
      if (node.parent === FREE_NODE_PARENT || node.start <= removalIndex) continue;
      node.start--;
      node.end--;
    }
    let ancestorIndex = leafIndex;
    while (ancestorIndex >= 0) {
      const ancestor = this._nodes[ancestorIndex];
      if (!ancestor) break;
      ancestor.end--;
      ancestorIndex = ancestor.parent;
    }
    if (leaf.start < leaf.end) {
      const parentIndex = leaf.parent;
      if (parentIndex >= 0 && this._mergeLeafChildren(parentIndex)) this._refitAncestors(parentIndex);
      else this._refitAncestors(leafIndex);
      return;
    }
    if (leafIndex === this._root) {
      this._releaseNode(leafIndex);
      this._root = -1;
      return;
    }
    const parentIndex = leaf.parent;
    const parent = this._nodes[parentIndex]!;
    const grandParentIndex = parent.parent;
    const siblingIndex = parent.left === leafIndex ? parent.right : parent.left;
    const sibling = this._nodes[siblingIndex]!;
    copySpatialNode(parent, sibling);
    parent.parent = grandParentIndex;
    if (parent.left >= 0) {
      this._nodes[parent.left]!.parent = parentIndex;
      this._nodes[parent.right]!.parent = parentIndex;
    } else {
      for (let i = parent.start; i < parent.end; i++) {
        const childEntry = this._entries[i];
        if (childEntry) childEntry.leafNode = parentIndex;
      }
    }
    this._releaseNode(leafIndex);
    this._releaseNode(siblingIndex);
    this._refitAncestors(parentIndex);
  }

  private _mergeLeafChildren(parentIndex: number): boolean {
    const parent = this._nodes[parentIndex];
    if (!parent || parent.left < 0) return false;
    const left = this._nodes[parent.left];
    const right = this._nodes[parent.right];
    if (!left || !right || left.left >= 0 || right.left >= 0 || parent.end - parent.start > this._leafSize) return false;
    const leftIndex = parent.left;
    const rightIndex = parent.right;
    parent.left = -1;
    parent.right = -1;
    for (let i = parent.start; i < parent.end; i++) {
      const entry = this._entries[i];
      if (entry) entry.leafNode = parentIndex;
    }
    this._releaseNode(leftIndex);
    this._releaseNode(rightIndex);
    writeNodeBounds(parent, this._entries, parent.start, parent.end);
    return true;
  }

  private _refitAncestors(startIndex: number): void {
    let nodeIndex = startIndex;
    while (nodeIndex >= 0) {
      const node = this._nodes[nodeIndex];
      if (!node) break;
      if (node.left >= 0) writeInternalNodeBounds(node, this._nodes);
      else writeNodeBounds(node, this._entries, node.start, node.end);
      this._tryRotateNode(nodeIndex);
      nodeIndex = node.parent;
    }
  }

  private _tryRotateNode(nodeIndex: number): boolean {
    const node = this._nodes[nodeIndex];
    if (!node || node.left < 0) return false;
    const leftIndex = node.left;
    const rightIndex = node.right;
    const left = this._nodes[leftIndex]!;
    const right = this._nodes[rightIndex]!;
    const oldCost = boundsSurfaceArea(left) + boundsSurfaceArea(right);
    let bestKind = 0;
    let bestCost = oldCost;
    if (left.left >= 0) {
      const a = this._nodes[left.left]!;
      const b = this._nodes[left.right]!;
      const cost = boundsSurfaceArea(a) + combinedSurfaceArea(b, right);
      if (cost + ROTATION_EPSILON < bestCost) {
        bestCost = cost;
        bestKind = 1;
      }
    }
    if (right.left >= 0) {
      const b = this._nodes[right.left]!;
      const c = this._nodes[right.right]!;
      const cost = combinedSurfaceArea(left, b) + boundsSurfaceArea(c);
      if (cost + ROTATION_EPSILON < bestCost) {
        bestCost = cost;
        bestKind = 2;
      }
    }
    if (bestKind === 0) return false;
    if (bestKind === 1) {
      const aIndex = left.left;
      const bIndex = left.right;
      node.left = aIndex;
      node.right = leftIndex;
      left.left = bIndex;
      left.right = rightIndex;
      this._nodes[aIndex]!.parent = nodeIndex;
      left.parent = nodeIndex;
      this._nodes[bIndex]!.parent = leftIndex;
      right.parent = leftIndex;
      left.start = this._nodes[bIndex]!.start;
      left.end = right.end;
      node.start = this._nodes[aIndex]!.start;
      node.end = left.end;
      writeInternalNodeBounds(left, this._nodes);
    } else {
      const bIndex = right.left;
      const cIndex = right.right;
      node.left = rightIndex;
      node.right = cIndex;
      right.left = leftIndex;
      right.right = bIndex;
      right.parent = nodeIndex;
      this._nodes[cIndex]!.parent = nodeIndex;
      left.parent = rightIndex;
      this._nodes[bIndex]!.parent = rightIndex;
      right.start = left.start;
      right.end = this._nodes[bIndex]!.end;
      node.start = right.start;
      node.end = this._nodes[cIndex]!.end;
      writeInternalNodeBounds(right, this._nodes);
    }
    writeInternalNodeBounds(node, this._nodes);
    this._treeSurfaceArea += bestCost - oldCost;
    this._rotationCount++;
    return true;
  }

  private _markIncrementalDirty(entry: SpatialEntry<T>): void {
    if (entry.dirtyGeneration === this._incrementalGeneration) return;
    entry.dirtyGeneration = this._incrementalGeneration;
    this._incrementalDirtyEntries.push(entry);
  }

  private _refitDirtyEntries(): void {
    const generation = this._incrementalGeneration;
    const dirtyNodes = this._incrementalDirtyNodes;
    dirtyNodes.length = 0;
    for (const entry of this._incrementalDirtyEntries) {
      let nodeIndex = entry.leafNode;
      while (nodeIndex >= 0) {
        const node = this._nodes[nodeIndex];
        if (!node) break;
        if (node.refitGeneration !== generation) {
          node.refitGeneration = generation;
          dirtyNodes.push(nodeIndex);
        }
        nodeIndex = node.parent;
      }
    }
    dirtyNodes.sort((a, b) => this._nodeDepth(b) - this._nodeDepth(a));
    for (let i = 0; i < dirtyNodes.length; i++) {
      const node = this._nodes[dirtyNodes[i] ?? -1];
      if (!node) continue;
      const previousArea = boundsSurfaceArea(node);
      if (node.left >= 0) writeInternalNodeBounds(node, this._nodes);
      else writeNodeBounds(node, this._entries, node.start, node.end);
      this._treeSurfaceArea += boundsSurfaceArea(node) - previousArea;
      this._tryRotateNode(dirtyNodes[i] ?? -1);
    }
    this._incrementalDirtyEntries.length = 0;
    dirtyNodes.length = 0;
  }

  private _nodeDepth(nodeIndex: number): number {
    let depth = 0;
    let current = this._nodes[nodeIndex]?.parent ?? -1;
    while (current >= 0) {
      depth++;
      current = this._nodes[current]?.parent ?? -1;
    }
    return depth;
  }
}

const FREE_NODE_PARENT = -2;
const ROTATION_EPSILON = 1e-6;

function normalizeLeafSize(value: number): number {
  return Math.max(1, Math.floor(Number.isFinite(value) ? value : 8));
}

function validateBounds(minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number): void {
  if (
    !Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(minZ)
    || !Number.isFinite(maxX) || !Number.isFinite(maxY) || !Number.isFinite(maxZ)
    || minX > maxX || minY > maxY || minZ > maxZ
  ) {
    throw new EngineError(
      EngineErrorCode.GeometryInvalidParameter,
      'SpatialIndex bounds must be finite and min must not exceed max.',
      { docsPath: 'errors/E_GEOMETRY_INVALID_PARAMETER' },
    );
  }
}

function spatialStateError(message: string): EngineError {
  return new EngineError(EngineErrorCode.EngineInvalidState, message, {
    hint: 'Complete or cancel the current SpatialIndex update transaction before starting another operation.',
  });
}

function createSpatialEntry<T>(): SpatialEntry<T> {
  return {
    key: 0,
    value: undefined as T,
    minX: 0, minY: 0, minZ: 0,
    maxX: 0, maxY: 0, maxZ: 0,
    centerX: 0, centerY: 0, centerZ: 0,
    seenGeneration: 0,
    leafNode: -1,
    dirtyGeneration: 0,
  };
}

function releaseSpatialEntry<T>(entry: SpatialEntry<T>): void {
  entry.key = 0;
  entry.value = undefined as T;
  entry.seenGeneration = 0;
  entry.leafNode = -1;
  entry.dirtyGeneration = 0;
}

function createSpatialNode(): SpatialNode {
  return {
    minX: 0, minY: 0, minZ: 0,
    maxX: 0, maxY: 0, maxZ: 0,
    start: 0, end: 0, left: -1, right: -1, parent: -1, refitGeneration: 0,
  };
}

function writeInternalNodeBounds(node: SpatialNode, nodes: readonly SpatialNode[]): void {
  const left = nodes[node.left];
  const right = nodes[node.right];
  if (!left || !right) return;
  node.minX = Math.min(left.minX, right.minX);
  node.minY = Math.min(left.minY, right.minY);
  node.minZ = Math.min(left.minZ, right.minZ);
  node.maxX = Math.max(left.maxX, right.maxX);
  node.maxY = Math.max(left.maxY, right.maxY);
  node.maxZ = Math.max(left.maxZ, right.maxZ);
}

function copySpatialNode(target: SpatialNode, source: SpatialNode): void {
  target.minX = source.minX;
  target.minY = source.minY;
  target.minZ = source.minZ;
  target.maxX = source.maxX;
  target.maxY = source.maxY;
  target.maxZ = source.maxZ;
  target.start = source.start;
  target.end = source.end;
  target.left = source.left;
  target.right = source.right;
  target.refitGeneration = source.refitGeneration;
}

function boundsSurfaceArea(bounds: SpatialNode): number {
  const x = Math.max(0, bounds.maxX - bounds.minX);
  const y = Math.max(0, bounds.maxY - bounds.minY);
  const z = Math.max(0, bounds.maxZ - bounds.minZ);
  return 2 * (x * y + x * z + y * z);
}

function combinedSurfaceArea(
  a: SpatialNode | SpatialEntry<unknown>,
  b: SpatialNode | SpatialEntry<unknown>,
): number {
  const x = Math.max(0, Math.max(a.maxX, b.maxX) - Math.min(a.minX, b.minX));
  const y = Math.max(0, Math.max(a.maxY, b.maxY) - Math.min(a.minY, b.minY));
  const z = Math.max(0, Math.max(a.maxZ, b.maxZ) - Math.min(a.minZ, b.minZ));
  return 2 * (x * y + x * z + y * z);
}

function writeNodeBounds<T>(node: SpatialNode, entries: readonly SpatialEntry<T>[], start: number, end: number): void {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = start; i < end; i++) {
    const entry = entries[i];
    if (!entry) continue;
    if (entry.minX < minX) minX = entry.minX;
    if (entry.minY < minY) minY = entry.minY;
    if (entry.minZ < minZ) minZ = entry.minZ;
    if (entry.maxX > maxX) maxX = entry.maxX;
    if (entry.maxY > maxY) maxY = entry.maxY;
    if (entry.maxZ > maxZ) maxZ = entry.maxZ;
  }
  node.minX = minX; node.minY = minY; node.minZ = minZ;
  node.maxX = maxX; node.maxY = maxY; node.maxZ = maxZ;
}

function containsPoint(bounds: SpatialNode | SpatialEntry<unknown>, x: number, y: number, z: number): boolean {
  return x >= bounds.minX && x <= bounds.maxX
    && y >= bounds.minY && y <= bounds.maxY
    && z >= bounds.minZ && z <= bounds.maxZ;
}

function rayIntersectsBounds(
  bounds: SpatialNode | SpatialEntry<unknown>,
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  maxDistance: number,
): boolean {
  let tmin = 0;
  let tmax = maxDistance;
  if (Math.abs(dx) < 1e-8) {
    if (ox < bounds.minX || ox > bounds.maxX) return false;
  } else {
    const inverse = 1 / dx;
    let first = (bounds.minX - ox) * inverse;
    let second = (bounds.maxX - ox) * inverse;
    if (first > second) { const swap = first; first = second; second = swap; }
    if (first > tmin) tmin = first;
    if (second < tmax) tmax = second;
    if (tmin > tmax) return false;
  }
  if (Math.abs(dy) < 1e-8) {
    if (oy < bounds.minY || oy > bounds.maxY) return false;
  } else {
    const inverse = 1 / dy;
    let first = (bounds.minY - oy) * inverse;
    let second = (bounds.maxY - oy) * inverse;
    if (first > second) { const swap = first; first = second; second = swap; }
    if (first > tmin) tmin = first;
    if (second < tmax) tmax = second;
    if (tmin > tmax) return false;
  }
  if (Math.abs(dz) < 1e-8) {
    if (oz < bounds.minZ || oz > bounds.maxZ) return false;
  } else {
    const inverse = 1 / dz;
    let first = (bounds.minZ - oz) * inverse;
    let second = (bounds.maxZ - oz) * inverse;
    if (first > second) { const swap = first; first = second; second = swap; }
    if (first > tmin) tmin = first;
    if (second < tmax) tmax = second;
    if (tmin > tmax) return false;
  }
  return tmax >= 0 && tmin <= maxDistance;
}

function frustumIntersectsBounds(bounds: SpatialNode | SpatialEntry<unknown>, planes: Float32Array): boolean {
  for (let i = 0; i < 24; i += 4) {
    const nx = planes[i] ?? 0, ny = planes[i + 1] ?? 0, nz = planes[i + 2] ?? 0, d = planes[i + 3] ?? 0;
    const x = nx >= 0 ? bounds.maxX : bounds.minX;
    const y = ny >= 0 ? bounds.maxY : bounds.minY;
    const z = nz >= 0 ? bounds.maxZ : bounds.minZ;
    if (nx * x + ny * y + nz * z + d < 0) return false;
  }
  return true;
}

function entryCenter<T>(entry: SpatialEntry<T>, axis: number): number {
  return axis === 0 ? entry.centerX : axis === 1 ? entry.centerY : entry.centerZ;
}

function sortEntriesRangeByAxis<T>(entries: SpatialEntry<T>[], left: number, right: number, axis: number): void {
  if (left >= right) return;
  let i = left, j = right;
  const pivotEntry = entries[(left + right) >> 1];
  if (!pivotEntry) return;
  const pivot = entryCenter(pivotEntry, axis);
  while (i <= j) {
    let entry = entries[i];
    while (entry && entryCenter(entry, axis) < pivot) entry = entries[++i];
    entry = entries[j];
    while (entry && entryCenter(entry, axis) > pivot) entry = entries[--j];
    if (i <= j) {
      const leftEntry = entries[i];
      const rightEntry = entries[j];
      if (leftEntry && rightEntry) {
        entries[i] = rightEntry;
        entries[j] = leftEntry;
      }
      i++;
      j--;
    }
  }
  if (left < j) sortEntriesRangeByAxis(entries, left, j, axis);
  if (i < right) sortEntriesRangeByAxis(entries, i, right, axis);
}
