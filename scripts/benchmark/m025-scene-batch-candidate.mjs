/**
 * Benchmark-only TypedArray SceneBatch candidate retained to reproduce the
 * M2.5 G07 admission no-go. This file is not part of any production package.
 */
export class SceneBatchCandidate {
  _capacity = 0;
  _count = 0;
  _indexByEntityId = new Map();
  _visit = new Uint8Array(0);
  _topology = new Uint32Array(0);
  _entityIds = new Uint32Array(0);
  _parentEntityIds = new Uint32Array(0);
  _parentIndices = new Int32Array(0);
  _localVersions = new Float64Array(0);
  _worldVersions = new Float64Array(0);
  _localMatrices = new Float32Array(0);
  _worldMatrices = new Float32Array(0);
  _spheres = new Float32Array(0);
  _hasSphere = new Uint8Array(0);
  _visibleMask = new Uint8Array(0);
  _visibleIndices = new Uint32Array(0);
  _depth = new Float32Array(0);
  _structuralRevision = 0;
  _numericRevision = 0;
  _visibleCount = 0;

  get count() { return this._count; }
  get capacity() { return this._capacity; }
  get structuralRevision() { return this._structuralRevision; }
  get numericRevision() { return this._numericRevision; }
  get visibleCount() { return this._visibleCount; }
  get entityIds() { return this._entityIds.subarray(0, this._count); }
  get parentIndices() { return this._parentIndices.subarray(0, this._count); }
  get worldMatrices() { return this._worldMatrices.subarray(0, this._count * 16); }
  get visibleIndices() { return this._visibleIndices.subarray(0, this._visibleCount); }
  get depth() { return this._depth.subarray(0, this._count); }

  visibleIndexAt(index) {
    if (index < 0 || index >= this._visibleCount) throw new RangeError(`Visible SceneBatch index ${index} is outside [0, ${this._visibleCount}).`);
    return this._visibleIndices[index] ?? 0;
  }

  entityIdAt(batchIndex) {
    if (batchIndex < 0 || batchIndex >= this._count) throw new RangeError(`SceneBatch index ${batchIndex} is outside [0, ${this._count}).`);
    return this._entityIds[batchIndex] ?? 0;
  }

  depthAt(batchIndex) {
    if (batchIndex < 0 || batchIndex >= this._count) throw new RangeError(`SceneBatch index ${batchIndex} is outside [0, ${this._count}).`);
    return this._depth[batchIndex] ?? 0;
  }

  sync(state, access) {
    const renderables = state.renderables;
    const structuralChange = this._structureChanged(renderables);
    if (structuralChange) this._rebuildStructure(renderables);
    let numericChange = structuralChange;
    for (const renderable of renderables) {
      const batchIndex = this._indexByEntityId.get(renderable.entityId);
      if (batchIndex === undefined) throw new RangeError(`Missing SceneBatch index for entity ${renderable.entityId}.`);
      const localVersion = access.getLocalVersion(renderable);
      const matrixOffset = batchIndex * 16;
      if (structuralChange || this._localVersions[batchIndex] !== localVersion) {
        this._localMatrices.set(access.getLocalMatrix(renderable), matrixOffset);
        this._localVersions[batchIndex] = localVersion;
        numericChange = true;
      }
      if (structuralChange || this._worldVersions[batchIndex] !== renderable.worldVersion) {
        this._worldMatrices.set(renderable.worldMatrix, matrixOffset);
        this._worldVersions[batchIndex] = renderable.worldVersion;
        numericChange = true;
      }
      const sphere = renderable.worldSphere;
      const sphereOffset = batchIndex * 4;
      const hasSphere = sphere ? 1 : 0;
      if (this._hasSphere[batchIndex] !== hasSphere) {
        this._hasSphere[batchIndex] = hasSphere;
        numericChange = true;
      }
      if (sphere) {
        if (this._spheres[sphereOffset] !== sphere.center[0]
          || this._spheres[sphereOffset + 1] !== sphere.center[1]
          || this._spheres[sphereOffset + 2] !== sphere.center[2]
          || this._spheres[sphereOffset + 3] !== sphere.radius) {
          this._spheres[sphereOffset] = sphere.center[0];
          this._spheres[sphereOffset + 1] = sphere.center[1];
          this._spheres[sphereOffset + 2] = sphere.center[2];
          this._spheres[sphereOffset + 3] = sphere.radius;
          numericChange = true;
        }
        access.bindSphere?.(sphere, batchIndex);
      }
    }
    if (numericChange) this._numericRevision++;
    return this;
  }

  prepareView(planes, viewMatrix, frustumCull) {
    let visibleCount = 0;
    for (let batchIndex = 0; batchIndex < this._count; batchIndex++) {
      const matrixOffset = batchIndex * 16;
      const x = this._worldMatrices[matrixOffset + 12] ?? 0;
      const y = this._worldMatrices[matrixOffset + 13] ?? 0;
      const z = this._worldMatrices[matrixOffset + 14] ?? 0;
      this._depth[batchIndex] = -((viewMatrix[2] ?? 0) * x
        + (viewMatrix[6] ?? 0) * y
        + (viewMatrix[10] ?? 0) * z
        + (viewMatrix[14] ?? 0));
      let visible = true;
      if (frustumCull && this._hasSphere[batchIndex] === 1) {
        const sphereOffset = batchIndex * 4;
        for (let planeOffset = 0; planeOffset < 24; planeOffset += 4) {
          if ((planes[planeOffset] ?? 0) * (this._spheres[sphereOffset] ?? 0)
            + (planes[planeOffset + 1] ?? 0) * (this._spheres[sphereOffset + 1] ?? 0)
            + (planes[planeOffset + 2] ?? 0) * (this._spheres[sphereOffset + 2] ?? 0)
            + (planes[planeOffset + 3] ?? 0) < -(this._spheres[sphereOffset + 3] ?? 0)) {
            visible = false;
            break;
          }
        }
      }
      this._visibleMask[batchIndex] = visible ? 1 : 0;
      if (visible) this._visibleIndices[visibleCount++] = batchIndex;
    }
    this._visibleCount = visibleCount;
    return visibleCount;
  }

  isVisible(index) { return index >= 0 && index < this._count && this._visibleMask[index] === 1; }

  _structureChanged(renderables) {
    if (renderables.length !== this._count) return true;
    return renderables.some(renderable => {
      const index = this._indexByEntityId.get(renderable.entityId);
      return index === undefined || this._parentEntityIds[index] !== (renderable.entity.parent?.id ?? 0);
    });
  }

  _rebuildStructure(renderables) {
    this._ensureCapacity(renderables.length);
    this._indexByEntityId.clear();
    this._count = renderables.length;
    renderables.forEach((renderable, index) => {
      this._entityIds[index] = renderable.entityId;
      this._parentEntityIds[index] = renderable.entity.parent?.id ?? 0;
      this._indexByEntityId.set(renderable.entityId, index);
      this._localVersions[index] = Number.NaN;
      this._worldVersions[index] = Number.NaN;
    });
    for (let index = 0; index < renderables.length; index++) {
      this._parentIndices[index] = this._indexByEntityId.get(this._parentEntityIds[index] ?? 0) ?? -1;
    }
    this._visit.fill(0, 0, this._count);
    let cursor = 0;
    const chain = [];
    for (let start = 0; start < this._count; start++) {
      let index = start;
      while (index >= 0 && this._visit[index] === 0) {
        this._visit[index] = 1;
        chain.push(index);
        index = this._parentIndices[index] ?? -1;
      }
      while (chain.length > 0) {
        const resolved = chain.pop();
        this._visit[resolved] = 2;
        this._topology[cursor++] = resolved;
      }
    }
    this._structuralRevision++;
  }

  _ensureCapacity(count) {
    if (count <= this._capacity) return;
    let capacity = Math.max(64, this._capacity);
    while (capacity < count) capacity *= 2;
    this._capacity = capacity;
    for (const [key, Type, width] of [
      ['_visit', Uint8Array, 1], ['_topology', Uint32Array, 1], ['_entityIds', Uint32Array, 1],
      ['_parentEntityIds', Uint32Array, 1], ['_parentIndices', Int32Array, 1],
      ['_localVersions', Float64Array, 1], ['_worldVersions', Float64Array, 1],
      ['_localMatrices', Float32Array, 16], ['_worldMatrices', Float32Array, 16],
      ['_spheres', Float32Array, 4], ['_hasSphere', Uint8Array, 1],
      ['_visibleMask', Uint8Array, 1], ['_visibleIndices', Uint32Array, 1], ['_depth', Float32Array, 1],
    ]) {
      const next = new Type(capacity * width);
      next.set(this[key]);
      this[key] = next;
    }
  }
}
