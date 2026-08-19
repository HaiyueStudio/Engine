import { RAY_ACCELERATION_POLICY, diagnostic } from './bvh.js';
import {
  compareText,
  emptyBounds,
  fingerprintText,
  inverseMatrix4,
  outwardF32Bounds,
  transformBounds,
  unionBounds,
} from './math.js';
import type {
  RayAccelerationDiagnostic,
  RayBlas,
  RayBvhNode,
  RayPackedAcceleration,
  RayPackedBuffer,
  RayPackedBufferName,
  RayPackResult,
  RayTlas,
} from './types.js';

const U32_SENTINEL = 0xffff_ffff;
const LEAF_BIT = 0x8000_0000;
const MAX_INDEX = 0x7fff_ffff;

export const RAY_ACCELERATION_ABI_V1 = deepFreeze({
  name: 'haiyue-ray-acceleration-abi',
  version: 1,
  endianness: 'little',
  indexWidthBits: 32,
  missingIndex: U32_SENTINEL,
  maxAddressableIndex: MAX_INDEX,
  traversalStackLimit: RAY_ACCELERATION_POLICY.traversalStackLimit,
  stackOverflow: 'abort-ray-and-diagnostic',
  buffers: {
    blasNodes: { stride: 32, alignment: 16, words: 8 },
    blasTable: { stride: 16, alignment: 16, words: 4 },
    tlasNodes: { stride: 32, alignment: 16, words: 8 },
    primitives: { stride: 64, alignment: 16, words: 16 },
    instances: { stride: 144, alignment: 16, words: 36 },
    materials: { stride: 16, alignment: 16, words: 4 },
  },
  node: {
    min: { offset: 0, format: 'float32x3' },
    leftFirst: { offset: 12, format: 'uint32' },
    max: { offset: 16, format: 'float32x3' },
    meta: { offset: 28, format: 'uint32', leafBit: LEAF_BIT },
  },
  blasTable: {
    rootNode: { offset: 0, format: 'uint32' },
    nodeCount: { offset: 4, format: 'uint32' },
    primitiveOffset: { offset: 8, format: 'uint32' },
    primitiveCount: { offset: 12, format: 'uint32' },
  },
  primitive: {
    data: { offset: 0, format: 'float32x12' },
    kind: { offset: 48, format: 'uint32', triangle: 0, sphere: 1 },
    sourcePrimitiveIndex: { offset: 52, format: 'uint32' },
    geometryIdentityIndex: { offset: 56, format: 'uint32' },
    reserved: { offset: 60, format: 'uint32' },
  },
  instance: {
    transform: { offset: 0, format: 'float32x16' },
    inverseTransform: { offset: 64, format: 'float32x16' },
    blasTableIndex: { offset: 128, format: 'uint32' },
    materialIndex: { offset: 132, format: 'uint32' },
    identityIndex: { offset: 136, format: 'uint32' },
    flags: { offset: 140, format: 'uint32', analytic: 1 },
  },
  material: {
    identityHashLow: { offset: 0, format: 'uint32' },
    identityHashHigh: { offset: 4, format: 'uint32' },
    revision: { offset: 8, format: 'uint32' },
    typeHash: { offset: 12, format: 'uint32' },
  },
});

export const RAY_ACCELERATION_ABI_FINGERPRINT = fingerprintText(JSON.stringify(RAY_ACCELERATION_ABI_V1));

export function packAcceleration(
  blases: ReadonlyMap<string, RayBlas>,
  tlas: RayTlas,
  maxTotalBytes = 512 * 1024 * 1024,
): RayPackResult {
  const diagnostics: RayAccelerationDiagnostic[] = [];
  if (!isLittleEndian()) {
    diagnostics.push(diagnostic('pack', 'error', 'RAY_PACK_ENDIAN_UNSUPPORTED',
      'Ray acceleration ABI v1 requires little-endian typed-array storage.', {}));
    return freezePackResult(null, diagnostics);
  }
  const sortedBlases = [...blases.values()].sort((a, b) => compareText(a.key, b.key));
  const blasIndex = new Map(sortedBlases.map((blas, index) => [blas.key, index]));
  const geometryIdentities = Object.freeze(sortedBlases.map(blas => `${blas.geometryId}@${blas.geometryRevision}`));
  const packedInstances = tlas.instanceIndices.map(index => tlas.instances[index]!).filter(Boolean);
  const instanceIdentities = Object.freeze(packedInstances.map(instance => (
    `${instance.instanceId}|${instance.entityId}|${instance.geometryId}@${instance.geometryRevision}`
  )));
  const materials = [...new Map(packedInstances
    .filter(instance => instance.material)
    .map(instance => {
      const material = instance.material!;
      return [`${material.materialId}@${material.revision}:${material.type}`, material] as const;
    })).entries()].sort((a, b) => compareText(a[0], b[0]));
  const materialIndex = new Map(materials.map(([key], index) => [key, index]));
  const materialIdentities = Object.freeze(materials.map(([key]) => key));
  const counts = {
    blasNodes: sortedBlases.reduce((sum, blas) => sum + blas.nodes.length, 0),
    blasTable: sortedBlases.length,
    tlasNodes: tlas.nodes.length,
    primitives: sortedBlases.reduce((sum, blas) => sum + blas.primitives.length, 0),
    instances: packedInstances.length,
    materials: materials.length,
  } satisfies Record<RayPackedBufferName, number>;
  for (const [name, count] of Object.entries(counts) as [RayPackedBufferName, number][]) {
    if (!Number.isSafeInteger(count) || count < 0 || count > MAX_INDEX) {
      diagnostics.push(diagnostic('pack', 'error', 'RAY_PACK_INDEX_OVERFLOW',
        `${name} count ${count} exceeds ABI v1 uint31 addressability.`, { buffer: name, count }));
    }
  }
  const strides = Object.fromEntries(Object.entries(RAY_ACCELERATION_ABI_V1.buffers)
    .map(([name, layout]) => [name, layout.stride])) as Record<RayPackedBufferName, number>;
  const totalBytes = (Object.keys(counts) as RayPackedBufferName[])
    .reduce((sum, name) => sum + counts[name] * strides[name], 0);
  if (!Number.isSafeInteger(totalBytes) || totalBytes > maxTotalBytes) {
    diagnostics.push(diagnostic('pack', 'error', 'RAY_PACK_MEMORY_OVERFLOW',
      `Packed acceleration requires ${totalBytes} bytes, exceeding the ${maxTotalBytes}-byte limit.`, {
        totalBytes,
        maxTotalBytes,
      }));
  }
  for (const [, material] of materials) {
    if (!Number.isInteger(material.revision) || material.revision < 0 || material.revision > U32_SENTINEL) {
      diagnostics.push(diagnostic('pack', 'error', 'RAY_PACK_MATERIAL_REVISION_OVERFLOW',
        `Material ${material.materialId} revision ${material.revision} is outside uint32 range.`, {
          materialId: material.materialId,
          materialRevision: material.revision,
        }));
    }
  }
  const packedTlasNodes = createPackedTlasNodes(tlas, blases);
  validateFloat32Representability(sortedBlases, tlas, packedTlasNodes, diagnostics);
  if (diagnostics.some(entry => entry.severity === 'error')) return freezePackResult(null, diagnostics);

  const buffers = {
    blasNodes: createBuffer('blasNodes', counts.blasNodes, strides.blasNodes),
    blasTable: createBuffer('blasTable', counts.blasTable, strides.blasTable),
    tlasNodes: createBuffer('tlasNodes', counts.tlasNodes, strides.tlasNodes),
    primitives: createBuffer('primitives', counts.primitives, strides.primitives),
    instances: createBuffer('instances', counts.instances, strides.instances),
    materials: createBuffer('materials', counts.materials, strides.materials),
  } satisfies Record<RayPackedBufferName, RayPackedBuffer>;

  let nodeBase = 0;
  let primitiveBase = 0;
  for (let tableIndex = 0; tableIndex < sortedBlases.length; tableIndex++) {
    const blas = sortedBlases[tableIndex]!;
    packBlasNodes(buffers.blasNodes.data, blas, nodeBase, primitiveBase);
    packBlasTable(buffers.blasTable.data, tableIndex, blas, nodeBase, primitiveBase);
    packPrimitives(buffers.primitives.data, blas, primitiveBase, tableIndex);
    nodeBase += blas.nodes.length;
    primitiveBase += blas.primitives.length;
  }
  packTlasNodes(buffers.tlasNodes.data, packedTlasNodes);
  packInstances(buffers.instances.data, packedInstances, blasIndex, materialIndex);
  packMaterials(buffers.materials.data, materials.map(([, material]) => material));

  const memory = Object.freeze({
    blasNodesBytes: buffers.blasNodes.data.byteLength,
    blasTableBytes: buffers.blasTable.data.byteLength,
    tlasNodesBytes: buffers.tlasNodes.data.byteLength,
    primitivesBytes: buffers.primitives.data.byteLength,
    instancesBytes: buffers.instances.data.byteLength,
    materialsBytes: buffers.materials.data.byteLength,
    totalBytes,
  });
  const sourceFingerprint = fingerprintText([
    tlas.fingerprint,
    ...sortedBlases.map(blas => blas.fingerprint),
  ].join('|'));
  const fingerprint = fingerprintPacked(buffers, sourceFingerprint);
  const validation = validatePackedAccelerationInternal(buffers, sortedBlases, tlas, diagnostics);
  diagnostics.push(...validation);
  if (diagnostics.some(entry => entry.severity === 'error')) return freezePackResult(null, diagnostics);
  const packed: RayPackedAcceleration = Object.freeze({
    schemaVersion: 1,
    abiFingerprint: RAY_ACCELERATION_ABI_FINGERPRINT,
    sourceFingerprint,
    fingerprint,
    tlasRootNode: tlas.rootNode < 0 ? U32_SENTINEL : tlas.rootNode,
    buffers: Object.freeze(buffers),
    geometryIdentities,
    instanceIdentities,
    materialIdentities,
    memory,
    diagnostics: Object.freeze([...diagnostics]),
  });
  return freezePackResult(packed, diagnostics);
}

function validateFloat32Representability(
  blases: readonly RayBlas[],
  tlas: RayTlas,
  packedTlasNodes: readonly RayBvhNode[],
  diagnostics: RayAccelerationDiagnostic[],
): void {
  const finiteF32 = (value: number) => Number.isFinite(Math.fround(value));
  for (const blas of blases) {
    if (blas.nodes.some(node => [...node.bounds.min, ...node.bounds.max].some(value => !finiteF32(value)))
      || blas.primitives.some(primitive => primitive.data.some(value => !finiteF32(value)))) {
      diagnostics.push(diagnostic('pack', 'error', 'RAY_PACK_FLOAT32_OVERFLOW',
        `BLAS ${blas.key} contains values outside finite float32 range.`, { blasKey: blas.key }));
    }
  }
  if (packedTlasNodes.some(node => [...node.bounds.min, ...node.bounds.max].some(value => !finiteF32(value)))) {
    diagnostics.push(diagnostic('pack', 'error', 'RAY_PACK_FLOAT32_OVERFLOW',
      'TLAS bounds exceed finite float32 range after applying packed transforms.', {}));
  }
  for (const instance of tlas.instances) {
    if (instance.transform.some(value => !finiteF32(value))) {
      diagnostics.push(diagnostic('pack', 'error', 'RAY_PACK_FLOAT32_OVERFLOW',
        `Instance ${instance.instanceId} transform exceeds finite float32 range.`, { instanceId: instance.instanceId }));
    }
  }
}

export function validatePackedAcceleration(packed: RayPackedAcceleration): readonly RayAccelerationDiagnostic[] {
  const diagnostics: RayAccelerationDiagnostic[] = [];
  if (packed.abiFingerprint !== RAY_ACCELERATION_ABI_FINGERPRINT) {
    diagnostics.push(diagnostic('pack', 'error', 'RAY_PACK_ABI_MISMATCH',
      `Packed ABI ${packed.abiFingerprint} does not match ${RAY_ACCELERATION_ABI_FINGERPRINT}.`, {}));
  }
  for (const name of Object.keys(RAY_ACCELERATION_ABI_V1.buffers) as RayPackedBufferName[]) {
    const buffer = packed.buffers[name];
    const expectedStride = RAY_ACCELERATION_ABI_V1.buffers[name].stride;
    if (buffer.name !== name || buffer.stride !== expectedStride || buffer.data.byteLength !== buffer.count * buffer.stride) {
      diagnostics.push(diagnostic('pack', 'error', 'RAY_PACK_BUFFER_SHAPE_INVALID',
        `${name} buffer shape does not match ABI v1.`, { buffer: name }));
    }
  }
  if (diagnostics.length > 0) return Object.freeze(diagnostics);
  validateNodeBuffer(packed.buffers.blasNodes, packed.buffers.primitives.count, diagnostics);
  validateNodeBuffer(packed.buffers.tlasNodes, packed.buffers.instances.count, diagnostics);
  const tableView = new DataView(packed.buffers.blasTable.data);
  for (let index = 0; index < packed.buffers.blasTable.count; index++) {
    const offset = index * packed.buffers.blasTable.stride;
    const rootNode = tableView.getUint32(offset, true);
    const nodeCount = tableView.getUint32(offset + 4, true);
    const primitiveOffset = tableView.getUint32(offset + 8, true);
    const primitiveCount = tableView.getUint32(offset + 12, true);
    const rootValid = nodeCount === 0
      ? rootNode === U32_SENTINEL
      : rootNode < packed.buffers.blasNodes.count && rootNode + nodeCount <= packed.buffers.blasNodes.count;
    if (!rootValid || primitiveOffset + primitiveCount > packed.buffers.primitives.count) {
      diagnostics.push(diagnostic('pack', 'error', 'RAY_PACK_BLAS_TABLE_INVALID',
        `BLAS table record ${index} addresses data outside packed buffers.`, { tableIndex: index }));
    }
  }
  const primitiveView = new DataView(packed.buffers.primitives.data);
  for (let index = 0; index < packed.buffers.primitives.count; index++) {
    const offset = index * packed.buffers.primitives.stride;
    const kind = primitiveView.getUint32(offset + 48, true);
    const geometryIndex = primitiveView.getUint32(offset + 56, true);
    if (kind > 1 || geometryIndex >= packed.geometryIdentities.length) {
      diagnostics.push(diagnostic('pack', 'error', 'RAY_PACK_PRIMITIVE_INVALID',
        `Primitive record ${index} has invalid kind or geometry indirection.`, { primitiveIndex: index }));
    }
  }
  const instanceView = new DataView(packed.buffers.instances.data);
  for (let index = 0; index < packed.buffers.instances.count; index++) {
    const offset = index * packed.buffers.instances.stride;
    const blasTableIndex = instanceView.getUint32(offset + 128, true);
    const materialIndex = instanceView.getUint32(offset + 132, true);
    const identityIndex = instanceView.getUint32(offset + 136, true);
    if (blasTableIndex >= packed.buffers.blasTable.count
      || (materialIndex !== U32_SENTINEL && materialIndex >= packed.buffers.materials.count)
      || identityIndex >= packed.instanceIdentities.length) {
      diagnostics.push(diagnostic('pack', 'error', 'RAY_PACK_INSTANCE_INVALID',
        `Instance record ${index} has invalid BLAS, material, or identity indirection.`, { instanceIndex: index }));
    }
  }
  if ((packed.tlasRootNode === U32_SENTINEL) !== (packed.buffers.tlasNodes.count === 0)
    || (packed.tlasRootNode !== U32_SENTINEL && packed.tlasRootNode >= packed.buffers.tlasNodes.count)) {
    diagnostics.push(diagnostic('pack', 'error', 'RAY_PACK_TLAS_ROOT_INVALID',
      'Packed TLAS root does not address the TLAS node buffer.', { tlasRootNode: packed.tlasRootNode }));
  }
  if (packed.fingerprint !== fingerprintPacked(packed.buffers, packed.sourceFingerprint)) {
    diagnostics.push(diagnostic('pack', 'error', 'RAY_PACK_FINGERPRINT_MISMATCH',
      'Packed buffer bytes do not match their deterministic serialization fingerprint.', {}));
  }
  return Object.freeze(diagnostics);
}

function validateNodeBuffer(
  buffer: RayPackedBuffer,
  leafItemCount: number,
  diagnostics: RayAccelerationDiagnostic[],
): void {
  const view = new DataView(buffer.data);
  for (let index = 0; index < buffer.count; index++) {
    const offset = index * buffer.stride;
    const leftFirst = view.getUint32(offset + 12, true);
    const meta = view.getUint32(offset + 28, true);
    const isLeaf = (meta & LEAF_BIT) !== 0;
    const countOrRight = meta & MAX_INDEX;
    let valid = true;
    for (let axis = 0; axis < 3; axis++) {
      const minimum = view.getFloat32(offset + axis * 4, true);
      const maximum = view.getFloat32(offset + 16 + axis * 4, true);
      valid &&= Number.isFinite(minimum) && Number.isFinite(maximum) && minimum <= maximum;
    }
    valid &&= isLeaf
      ? countOrRight > 0 && leftFirst + countOrRight <= leafItemCount
      : leftFirst < buffer.count && countOrRight < buffer.count;
    if (!valid) {
      diagnostics.push(diagnostic('pack', 'error', 'RAY_PACK_NODE_INVALID',
        `${buffer.name} node ${index} has invalid bounds or references.`, { buffer: buffer.name, nodeIndex: index }));
    }
  }
}

function packBlasNodes(target: ArrayBuffer, blas: RayBlas, nodeBase: number, primitiveBase: number): void {
  for (let index = 0; index < blas.nodes.length; index++) {
    const node = blas.nodes[index]!;
    writeNode(target, nodeBase + index, node,
      node.indexCount > 0 ? primitiveBase + node.firstIndex : nodeBase + node.leftChild,
      node.indexCount > 0 ? LEAF_BIT | node.indexCount : nodeBase + node.rightChild);
  }
}

function packTlasNodes(target: ArrayBuffer, nodes: readonly RayBvhNode[]): void {
  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index]!;
    writeNode(target, index, node,
      node.indexCount > 0 ? node.firstIndex : node.leftChild,
      node.indexCount > 0 ? LEAF_BIT | node.indexCount : node.rightChild);
  }
}

function createPackedTlasNodes(tlas: RayTlas, blases: ReadonlyMap<string, RayBlas>): readonly RayBvhNode[] {
  const packedInstanceBounds = tlas.instances.map(instance => {
    const blasBounds = blases.get(instance.blasKey)?.bounds;
    if (!blasBounds) return instance.bounds;
    const packedTransform = Object.freeze(instance.transform.map(Math.fround));
    return transformBounds(blasBounds, packedTransform);
  });
  const nodes = new Array<RayBvhNode>(tlas.nodes.length);
  for (let nodeIndex = tlas.nodes.length - 1; nodeIndex >= 0; nodeIndex--) {
    const source = tlas.nodes[nodeIndex]!;
    let nodeBounds = emptyBounds();
    if (source.indexCount > 0) {
      for (let offset = 0; offset < source.indexCount; offset++) {
        const instanceIndex = tlas.instanceIndices[source.firstIndex + offset];
        if (instanceIndex !== undefined) nodeBounds = unionBounds(nodeBounds, packedInstanceBounds[instanceIndex]!);
      }
    } else {
      nodeBounds = unionBounds(nodes[source.leftChild]!.bounds, nodes[source.rightChild]!.bounds);
    }
    nodes[nodeIndex] = Object.freeze({ ...source, bounds: nodeBounds });
  }
  return Object.freeze(nodes);
}

function writeNode(target: ArrayBuffer, index: number, node: RayBvhNode, leftFirst: number, meta: number): void {
  const byteOffset = index * 32;
  const view = new DataView(target);
  const conservative = outwardF32Bounds(node.bounds);
  for (let axis = 0; axis < 3; axis++) view.setFloat32(byteOffset + axis * 4, conservative.min[axis]!, true);
  view.setUint32(byteOffset + 12, leftFirst >>> 0, true);
  for (let axis = 0; axis < 3; axis++) view.setFloat32(byteOffset + 16 + axis * 4, conservative.max[axis]!, true);
  view.setUint32(byteOffset + 28, meta >>> 0, true);
}

function packBlasTable(
  target: ArrayBuffer,
  tableIndex: number,
  blas: RayBlas,
  nodeBase: number,
  primitiveBase: number,
): void {
  const view = new DataView(target);
  const offset = tableIndex * 16;
  view.setUint32(offset, blas.rootNode < 0 ? U32_SENTINEL : nodeBase + blas.rootNode, true);
  view.setUint32(offset + 4, blas.nodes.length, true);
  view.setUint32(offset + 8, primitiveBase, true);
  view.setUint32(offset + 12, blas.primitives.length, true);
}

function packPrimitives(target: ArrayBuffer, blas: RayBlas, primitiveBase: number, geometryIndex: number): void {
  const view = new DataView(target);
  for (let orderedIndex = 0; orderedIndex < blas.primitiveIndices.length; orderedIndex++) {
    const sourceIndex = blas.primitiveIndices[orderedIndex]!;
    const primitive = blas.primitives[sourceIndex]!;
    const offset = (primitiveBase + orderedIndex) * 64;
    for (let item = 0; item < 12; item++) view.setFloat32(offset + item * 4, primitive.data[item] ?? 0, true);
    view.setUint32(offset + 48, primitive.kind === 'triangle' ? 0 : 1, true);
    view.setUint32(offset + 52, primitive.primitiveIndex, true);
    view.setUint32(offset + 56, geometryIndex, true);
    view.setUint32(offset + 60, 0, true);
  }
}

function packInstances(
  target: ArrayBuffer,
  instances: readonly RayTlas['instances'][number][],
  blasIndex: ReadonlyMap<string, number>,
  materialIndex: ReadonlyMap<string, number>,
): void {
  const view = new DataView(target);
  for (let index = 0; index < instances.length; index++) {
    const instance = instances[index]!;
    const offset = index * 144;
    const packedTransform = Object.freeze(instance.transform.map(Math.fround));
    const packedInverse = inverseMatrix4(packedTransform) ?? instance.inverseTransform;
    for (let item = 0; item < 16; item++) view.setFloat32(offset + item * 4, packedTransform[item]!, true);
    for (let item = 0; item < 16; item++) view.setFloat32(offset + 64 + item * 4, packedInverse[item]!, true);
    view.setUint32(offset + 128, blasIndex.get(instance.blasKey) ?? U32_SENTINEL, true);
    const materialKey = instance.material
      ? `${instance.material.materialId}@${instance.material.revision}:${instance.material.type}`
      : null;
    view.setUint32(offset + 132, materialKey ? materialIndex.get(materialKey) ?? U32_SENTINEL : U32_SENTINEL, true);
    view.setUint32(offset + 136, index, true);
    view.setUint32(offset + 140, instance.analyticIdentity ? 1 : 0, true);
  }
}

function packMaterials(target: ArrayBuffer, materials: readonly NonNullable<RayTlas['instances'][number]['material']>[]): void {
  const view = new DataView(target);
  for (let index = 0; index < materials.length; index++) {
    const material = materials[index]!;
    const [low, high] = hashParts(material.materialId);
    const [typeLow] = hashParts(material.type);
    const offset = index * 16;
    view.setUint32(offset, low, true);
    view.setUint32(offset + 4, high, true);
    view.setUint32(offset + 8, material.revision >>> 0, true);
    view.setUint32(offset + 12, typeLow, true);
  }
}

function createBuffer(name: RayPackedBufferName, count: number, stride: number): RayPackedBuffer {
  return Object.freeze({ name, stride, count, data: new ArrayBuffer(count * stride) });
}

function validatePackedAccelerationInternal(
  buffers: Readonly<Record<RayPackedBufferName, RayPackedBuffer>>,
  blases: readonly RayBlas[],
  tlas: RayTlas,
  diagnostics: RayAccelerationDiagnostic[],
): readonly RayAccelerationDiagnostic[] {
  const result: RayAccelerationDiagnostic[] = [];
  for (const buffer of Object.values(buffers)) {
    if (buffer.data.byteLength % 16 !== 0) {
      result.push(diagnostic('pack', 'error', 'RAY_PACK_ALIGNMENT_INVALID',
        `${buffer.name} byte length is not 16-byte aligned.`, { buffer: buffer.name, byteLength: buffer.data.byteLength }));
    }
  }
  const deepestBlasEntries = blases.reduce((maximum, blas) => Math.max(maximum, blas.statistics.maxDepth + 1), 0);
  const combinedStackEntries = tlas.statistics.maxDepth + 1 + deepestBlasEntries;
  if (blases.some(blas => blas.statistics.maxDepth + 1 > RAY_ACCELERATION_POLICY.traversalStackLimit)
    || tlas.statistics.maxDepth + 1 > RAY_ACCELERATION_POLICY.traversalStackLimit
    || combinedStackEntries > RAY_ACCELERATION_POLICY.traversalStackLimit) {
    result.push(diagnostic('pack', 'error', 'RAY_PACK_STACK_LIMIT_EXCEEDED',
      'TLAS plus deepest BLAS cannot be traversed with the ABI v1 bounded stack.', {
        combinedStackEntries,
        stackLimit: RAY_ACCELERATION_POLICY.traversalStackLimit,
      }));
  }
  void diagnostics;
  return result;
}

function fingerprintPacked(
  buffers: Readonly<Record<RayPackedBufferName, RayPackedBuffer>>,
  sourceFingerprint: string,
): string {
  const tokens = [RAY_ACCELERATION_ABI_FINGERPRINT, sourceFingerprint];
  for (const name of Object.keys(buffers) as RayPackedBufferName[]) {
    tokens.push(name, bytesToHex(new Uint8Array(buffers[name].data)));
  }
  return fingerprintText(tokens.join('|'));
}

function hashParts(value: string): readonly [number, number] {
  const hex = fingerprintText(value).slice('fnv1a64:'.length);
  return [Number.parseInt(hex.slice(8), 16) >>> 0, Number.parseInt(hex.slice(0, 8), 16) >>> 0];
}

function bytesToHex(bytes: Uint8Array): string {
  let output = '';
  for (const byte of bytes) output += byte.toString(16).padStart(2, '0');
  return output;
}

function isLittleEndian(): boolean {
  const bytes = new Uint8Array(new Uint32Array([0x01020304]).buffer);
  return bytes[0] === 0x04;
}

function freezePackResult(packed: RayPackedAcceleration | null, diagnostics: RayAccelerationDiagnostic[]): RayPackResult {
  return Object.freeze({ packed, diagnostics: Object.freeze([...diagnostics]) });
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
