import type {
  GltfAccessor,
  GltfAccessorType,
  GltfAsset,
  GltfBufferView,
  GltfComponentType,
} from './GltfSchema';
import { gltfDataError } from './GltfLoaderErrors';

const COMPONENT_BYTE_SIZE: Record<GltfComponentType, number> = {
  5120: 1,
  5121: 1,
  5122: 2,
  5123: 2,
  5125: 4,
  5126: 4,
};

const TYPE_SIZE: Record<GltfAccessorType, number> = {
  SCALAR: 1,
  VEC2: 2,
  VEC3: 3,
  VEC4: 4,
  MAT2: 4,
  MAT3: 9,
  MAT4: 16,
};

export function readAccessorFloat(
  gltf: GltfAsset,
  buffers: ArrayBuffer[],
  accessorIndex: number,
  expectedSize: number,
): Float32Array {
  const accessor = getAccessor(gltf, accessorIndex);
  const itemSize = TYPE_SIZE[accessor.type];
  if (itemSize < expectedSize) throw gltfDataError(`Accessor ${accessorIndex} has ${itemSize} components, expected ${expectedSize}.`);
  const out = new Float32Array(accessor.count * expectedSize);
  readAccessorValues(gltf, buffers, accessor, (values, index) => {
    for (let i = 0; i < expectedSize; i++) out[index * expectedSize + i] = values[i] ?? 0;
  });
  return out;
}

export function readAccessorMat4(gltf: GltfAsset, buffers: ArrayBuffer[], accessorIndex: number): Float32Array[] {
  const accessor = getAccessor(gltf, accessorIndex);
  if (TYPE_SIZE[accessor.type] !== 16) throw gltfDataError(`Accessor ${accessorIndex} is not MAT4.`);
  const out: Float32Array[] = [];
  readAccessorValues(gltf, buffers, accessor, values => {
    const matrix = new Float32Array(16);
    for (let i = 0; i < 16; i++) matrix[i] = values[i] ?? 0;
    out.push(matrix);
  });
  return out;
}

export function readAccessorUnsigned(
  gltf: GltfAsset,
  buffers: ArrayBuffer[],
  accessorIndex: number,
  expectedSize: number,
): Uint16Array | Uint32Array {
  const accessor = getAccessor(gltf, accessorIndex);
  const itemSize = TYPE_SIZE[accessor.type];
  if (itemSize < expectedSize) throw gltfDataError(`Accessor ${accessorIndex} has ${itemSize} components, expected ${expectedSize}.`);
  const out = accessor.componentType === 5125
    ? new Uint32Array(accessor.count * expectedSize)
    : new Uint16Array(accessor.count * expectedSize);
  readAccessorValues(gltf, buffers, accessor, (values, index) => {
    for (let i = 0; i < expectedSize; i++) out[index * expectedSize + i] = values[i] ?? 0;
  });
  return out;
}

export function readAccessorIndices(
  gltf: GltfAsset,
  buffers: ArrayBuffer[],
  accessorIndex: number,
): Uint16Array | Uint32Array {
  const accessor = getAccessor(gltf, accessorIndex);
  const out = accessor.componentType === 5125 ? new Uint32Array(accessor.count) : new Uint16Array(accessor.count);
  readAccessorValues(gltf, buffers, accessor, (values, index) => {
    out[index] = values[0] ?? 0;
  });
  return out;
}

export function generateFlatNormals(
  positions: Float32Array,
  indices: Uint16Array | Uint32Array | null,
): Float32Array {
  const normals = new Float32Array(positions.length);
  const triangleCount = indices ? indices.length / 3 : positions.length / 9;
  for (let tri = 0; tri < triangleCount; tri++) {
    const ia = indices ? indices[tri * 3] : tri * 3;
    const ib = indices ? indices[tri * 3 + 1] : tri * 3 + 1;
    const ic = indices ? indices[tri * 3 + 2] : tri * 3 + 2;
    if (ia === undefined || ib === undefined || ic === undefined) continue;
    const ax = requiredFiniteArrayValue(positions, ia * 3, 'POSITION');
    const ay = requiredFiniteArrayValue(positions, ia * 3 + 1, 'POSITION');
    const az = requiredFiniteArrayValue(positions, ia * 3 + 2, 'POSITION');
    const bx = requiredFiniteArrayValue(positions, ib * 3, 'POSITION');
    const by = requiredFiniteArrayValue(positions, ib * 3 + 1, 'POSITION');
    const bz = requiredFiniteArrayValue(positions, ib * 3 + 2, 'POSITION');
    const cx = requiredFiniteArrayValue(positions, ic * 3, 'POSITION');
    const cy = requiredFiniteArrayValue(positions, ic * 3 + 1, 'POSITION');
    const cz = requiredFiniteArrayValue(positions, ic * 3 + 2, 'POSITION');
    const abx = bx - ax, aby = by - ay, abz = bz - az;
    const acx = cx - ax, acy = cy - ay, acz = cz - az;
    const nx = aby * acz - abz * acy;
    const ny = abz * acx - abx * acz;
    const nz = abx * acy - aby * acx;
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
    const nnx = nx / len;
    const nny = ny / len;
    const nnz = nz / len;
    addNormal(normals, ia, nnx, nny, nnz);
    addNormal(normals, ib, nnx, nny, nnz);
    addNormal(normals, ic, nnx, nny, nnz);
  }
  for (let i = 0; i < normals.length; i += 3) {
    const nx = requiredFiniteArrayValue(normals, i, 'generated normals');
    const ny = requiredFiniteArrayValue(normals, i + 1, 'generated normals');
    const nz = requiredFiniteArrayValue(normals, i + 2, 'generated normals');
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
    normals[i] = nx / len;
    normals[i + 1] = ny / len;
    normals[i + 2] = nz / len;
  }
  return normals;
}

function readAccessorValues(
  gltf: GltfAsset,
  buffers: ArrayBuffer[],
  accessor: GltfAccessor,
  write: (values: ArrayLike<number>, index: number) => void,
): void {
  const itemSize = TYPE_SIZE[accessor.type];
  const componentSize = COMPONENT_BYTE_SIZE[accessor.componentType];
  const values = new Float64Array(itemSize);
  if (accessor.bufferView !== undefined) {
    const view = getBufferView(gltf, accessor.bufferView);
    const dataView = new DataView(getBuffer(buffers, view.buffer));
    const stride = view.byteStride ?? itemSize * componentSize;
    const start = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
    for (let index = 0; index < accessor.count; index++) {
      readAccessorTuple(dataView, start + index * stride, itemSize, componentSize, accessor.componentType, Boolean(accessor.normalized), values);
      write(values, index);
    }
  } else {
    values.fill(0);
    for (let index = 0; index < accessor.count; index++) write(values, index);
  }
  if (accessor.sparse?.count) readSparseAccessorValues(gltf, buffers, accessor, values, write);
}

function readSparseAccessorValues(
  gltf: GltfAsset,
  buffers: ArrayBuffer[],
  accessor: GltfAccessor,
  values: Float64Array,
  write: (values: ArrayLike<number>, index: number) => void,
): void {
  const sparse = accessor.sparse;
  if (!sparse) return;
  const itemSize = TYPE_SIZE[accessor.type];
  const componentSize = COMPONENT_BYTE_SIZE[accessor.componentType];
  const indexComponentSize = COMPONENT_BYTE_SIZE[sparse.indices.componentType];
  const indicesView = getBufferView(gltf, sparse.indices.bufferView);
  const valuesView = getBufferView(gltf, sparse.values.bufferView);
  const indicesData = new DataView(getBuffer(buffers, indicesView.buffer));
  const valuesData = new DataView(getBuffer(buffers, valuesView.buffer));
  const indicesStart = (indicesView.byteOffset ?? 0) + (sparse.indices.byteOffset ?? 0);
  const valuesStart = (valuesView.byteOffset ?? 0) + (sparse.values.byteOffset ?? 0);
  for (let sparseIndex = 0; sparseIndex < sparse.count; sparseIndex++) {
    const index = readSparseIndex(indicesData, indicesStart + sparseIndex * indexComponentSize, sparse.indices.componentType);
    if (index < 0 || index >= accessor.count) throw gltfDataError(`Sparse accessor index ${index} is out of bounds.`);
    readAccessorTuple(
      valuesData,
      valuesStart + sparseIndex * itemSize * componentSize,
      itemSize,
      componentSize,
      accessor.componentType,
      Boolean(accessor.normalized),
      values,
    );
    write(values, index);
  }
}

function readAccessorTuple(
  dataView: DataView,
  offset: number,
  itemSize: number,
  componentSize: number,
  componentType: GltfComponentType,
  normalized: boolean,
  out: Float64Array,
): void {
  for (let component = 0; component < itemSize; component++) {
    out[component] = readComponent(dataView, offset + component * componentSize, componentType, normalized);
  }
}

function readSparseIndex(view: DataView, offset: number, componentType: 5121 | 5123 | 5125): number {
  switch (componentType) {
    case 5121: return view.getUint8(offset);
    case 5123: return view.getUint16(offset, true);
    case 5125: return view.getUint32(offset, true);
  }
}

function getBufferView(gltf: GltfAsset, bufferViewIndex: number): GltfBufferView {
  const view = gltf.bufferViews?.[bufferViewIndex];
  if (!view) throw gltfDataError(`Missing bufferView ${bufferViewIndex}.`);
  return view;
}

function getBuffer(buffers: ArrayBuffer[], bufferIndex: number): ArrayBuffer {
  const buffer = buffers[bufferIndex];
  if (!buffer) throw gltfDataError(`Missing buffer ${bufferIndex}.`);
  return buffer;
}

function getAccessor(gltf: GltfAsset, accessorIndex: number): GltfAccessor {
  const accessor = gltf.accessors?.[accessorIndex];
  if (!accessor) throw gltfDataError(`Missing accessor ${accessorIndex}.`);
  return accessor;
}

function readComponent(view: DataView, offset: number, componentType: GltfComponentType, normalized: boolean): number {
  switch (componentType) {
    case 5120: {
      const value = view.getInt8(offset);
      return normalized ? Math.max(value / 127, -1) : value;
    }
    case 5121: {
      const value = view.getUint8(offset);
      return normalized ? value / 255 : value;
    }
    case 5122: {
      const value = view.getInt16(offset, true);
      return normalized ? Math.max(value / 32767, -1) : value;
    }
    case 5123: {
      const value = view.getUint16(offset, true);
      return normalized ? value / 65535 : value;
    }
    case 5125: return view.getUint32(offset, true);
    case 5126: return view.getFloat32(offset, true);
  }
}

function addNormal(normals: Float32Array, index: number, x: number, y: number, z: number): void {
  const offset = index * 3;
  if (offset < 0 || offset + 2 >= normals.length) {
    throw gltfDataError(`Triangle index ${index} is outside the POSITION accessor.`);
  }
  normals[offset] = (normals[offset] ?? 0) + x;
  normals[offset + 1] = (normals[offset + 1] ?? 0) + y;
  normals[offset + 2] = (normals[offset + 2] ?? 0) + z;
}

export function requiredFiniteArrayValue(values: ArrayLike<number>, index: number, label: string): number {
  const value = values[index];
  if (value === undefined || !Number.isFinite(value)) {
    throw gltfDataError(`${label} is missing a finite value at index ${index}.`);
  }
  return value;
}
