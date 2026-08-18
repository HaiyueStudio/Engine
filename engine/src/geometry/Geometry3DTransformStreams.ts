import {
  Geometry3D,
  type CustomAttribute,
  type Geometry3DTextureCoordinateSet,
  type InstanceAttribute,
  type MorphTarget3D,
  type Skinning3DOptions,
} from './Geometry3D';

type MidpointMode = 'linear' | 'unit-vector';

export interface MutableVertexStream {
  readonly itemSize: number;
  readonly midpointMode: MidpointMode;
  data: number[];
}

interface MutableSkinningStream {
  joints: number[];
  weights: number[];
  readonly jointMatrices: Float32Array;
}

export interface Geometry3DTransformStreams {
  readonly positions: MutableVertexStream;
  readonly normals: MutableVertexStream | null;
  readonly textureCoordinates: Array<{ readonly set: number; readonly stream: MutableVertexStream }>;
  readonly customAttributes: Array<{ readonly attribute: CustomAttribute; readonly stream: MutableVertexStream }>;
  readonly morphTargets: Array<{
    readonly positions: MutableVertexStream | null;
    readonly normals: MutableVertexStream | null;
  }>;
  readonly morphBasePositions: MutableVertexStream | null;
  readonly morphBaseNormals: MutableVertexStream | null;
  readonly skinning: MutableSkinningStream | null;
  readonly all: MutableVertexStream[];
}

type GeometryTransformError = (message: string) => Error;

export function createGeometry3DTransformStreams(
  source: Geometry3D,
  createError: GeometryTransformError,
): Geometry3DTransformStreams {
  const vertexCount = validateVertexStream(source.positions, 3, undefined, 'positions', createError);
  const positions = createStream(source.positions, 3, vertexCount, 'positions', 'linear', createError);
  const normals = source.normals
    ? createStream(source.normals, 3, vertexCount, 'normals', 'unit-vector', createError)
    : null;
  const textureCoordinates = [...source.textureCoordinates].map(([set, data]) => ({
    set,
    stream: createStream(data, 2, vertexCount, `TEXCOORD_${set}`, 'linear', createError),
  }));
  const customAttributes = [...source.customAttributes.values()].map(attribute => ({
    attribute,
    stream: createStream(
      attribute.data,
      attribute.itemSize,
      vertexCount,
      `custom attribute "${attribute.name}"`,
      'linear',
      createError,
    ),
  }));
  const morphTargets = source.morphTargets.map((target, index) => ({
    positions: target.positions
      ? createStream(target.positions, 3, vertexCount, `morph target ${index} positions`, 'linear', createError)
      : null,
    // Morph normals are deltas, not unit vectors.
    normals: target.normals
      ? createStream(target.normals, 3, vertexCount, `morph target ${index} normals`, 'linear', createError)
      : null,
  }));
  const morphBasePositions = source.morphBasePositions
    ? createStream(source.morphBasePositions, 3, vertexCount, 'morph base positions', 'linear', createError)
    : null;
  const morphBaseNormals = source.morphBaseNormals
    ? createStream(source.morphBaseNormals, 3, vertexCount, 'morph base normals', 'unit-vector', createError)
    : null;
  const skinning = source.skinning ? createSkinningStream(source.skinning, vertexCount, createError) : null;
  const all = [
    positions,
    ...(normals ? [normals] : []),
    ...textureCoordinates.map(item => item.stream),
    ...customAttributes.map(item => item.stream),
    ...morphTargets.flatMap(target => [target.positions, target.normals].filter(isVertexStream)),
    ...(morphBasePositions ? [morphBasePositions] : []),
    ...(morphBaseNormals ? [morphBaseNormals] : []),
  ];
  return {
    positions,
    normals,
    textureCoordinates,
    customAttributes,
    morphTargets,
    morphBasePositions,
    morphBaseNormals,
    skinning,
    all,
  };
}

export function interpolateGeometry3DVertex(
  streams: Geometry3DTransformStreams,
  target: number | null,
  first: number,
  second: number,
  t: number,
): number {
  const outputVertex = target ?? streams.positions.data.length / streams.positions.itemSize;
  for (const stream of streams.all) writeInterpolatedStream(stream, target, first, second, t);
  if (streams.skinning) writeInterpolatedSkinning(streams.skinning, target, first, second, t);
  return outputVertex;
}

export function buildGeometry3DFromTransformStreams(
  source: Geometry3D,
  streams: Geometry3DTransformStreams,
  indices: readonly number[],
  vertexOrder?: readonly number[],
): Geometry3D {
  const order = vertexOrder ?? Array.from(
    { length: streams.positions.data.length / streams.positions.itemSize },
    (_, index) => index,
  );
  const result = new Geometry3D({
    positions: extractStream(streams.positions, order),
    ...(streams.normals ? { normals: extractStream(streams.normals, order) } : {}),
    textureCoordinates: streams.textureCoordinates.map(({ set, stream }): Geometry3DTextureCoordinateSet => ({
      set,
      data: extractStream(stream, order),
    })),
    textureCoordinateLayout: source.textureCoordinateLayout,
    indices: order.length <= 0xffff ? Uint16Array.from(indices) : Uint32Array.from(indices),
    ...(source.topology ? { topology: source.topology } : {}),
    ...(source.cullMode ? { cullMode: source.cullMode } : {}),
    ...(source.frontFace ? { frontFace: source.frontFace } : {}),
    customAttributes: streams.customAttributes.map(({ attribute, stream }): CustomAttribute => ({
      ...attribute,
      data: extractStream(stream, order),
    })),
    instanceAttributes: copyInstanceAttributes(source),
    instanceCount: source.instanceCount,
    morphTargets: streams.morphTargets.map((target): MorphTarget3D => ({
      ...(target.positions ? { positions: extractStream(target.positions, order) } : {}),
      ...(target.normals ? { normals: extractStream(target.normals, order) } : {}),
    })),
    morphWeights: source.morphWeights,
    morphUseGpu: source.morphUseGpu,
    ...(streams.skinning ? { skinning: extractSkinning(streams.skinning, order) } : {}),
    boundsMode: source.boundsMode,
    localBounds: source.localBounds,
  });
  result.morphBasePositions = streams.morphBasePositions
    ? extractStream(streams.morphBasePositions, order)
    : null;
  result.morphBaseNormals = streams.morphBaseNormals
    ? extractStream(streams.morphBaseNormals, order)
    : null;
  return result;
}

export function compactGeometry3DTransformStreams(
  source: Geometry3D,
  streams: Geometry3DTransformStreams,
  indices: readonly number[],
): Geometry3D {
  const remap = new Map<number, number>();
  const vertexOrder: number[] = [];
  const compactIndices = indices.map(index => {
    const cached = remap.get(index);
    if (cached !== undefined) return cached;
    const compact = vertexOrder.length;
    remap.set(index, compact);
    vertexOrder.push(index);
    return compact;
  });
  return buildGeometry3DFromTransformStreams(source, streams, compactIndices, vertexOrder);
}

export function validateGeometry3DVertexStream(
  data: Float32Array,
  itemSize: number,
  vertexCount: number | undefined,
  label: string,
  createError: GeometryTransformError,
): number {
  return validateVertexStream(data, itemSize, vertexCount, label, createError);
}

function createStream(
  data: Float32Array,
  itemSize: number,
  vertexCount: number,
  label: string,
  midpointMode: MidpointMode,
  createError: GeometryTransformError,
): MutableVertexStream {
  validateVertexStream(data, itemSize, vertexCount, label, createError);
  return { itemSize, midpointMode, data: Array.from(data) };
}

function validateVertexStream(
  data: Float32Array,
  itemSize: number,
  vertexCount: number | undefined,
  label: string,
  createError: GeometryTransformError,
): number {
  if (!(data instanceof Float32Array)) throw createError(`${label} must be a Float32Array.`);
  if (!Number.isInteger(itemSize) || itemSize <= 0) {
    throw createError(`${label} itemSize must be a positive integer; received ${itemSize}.`);
  }
  if (data.length % itemSize !== 0) {
    throw createError(`${label} must contain complete ${itemSize}-component records.`);
  }
  const actualVertexCount = data.length / itemSize;
  if (vertexCount !== undefined && actualVertexCount !== vertexCount) {
    throw createError(
      `${label} length must be vertexCount * itemSize (${vertexCount * itemSize}); received ${data.length}.`,
    );
  }
  return actualVertexCount;
}

function writeInterpolatedStream(
  stream: MutableVertexStream,
  target: number | null,
  first: number,
  second: number,
  t: number,
): void {
  const values: number[] = [];
  const firstOffset = first * stream.itemSize;
  const secondOffset = second * stream.itemSize;
  for (let component = 0; component < stream.itemSize; component++) {
    const firstValue = stream.data[firstOffset + component]!;
    values.push(firstValue + (stream.data[secondOffset + component]! - firstValue) * t);
  }
  if (stream.midpointMode === 'unit-vector') normalizeVector(values);
  if (target === null) stream.data.push(...values);
  else {
    const targetOffset = target * stream.itemSize;
    for (let component = 0; component < values.length; component++) {
      stream.data[targetOffset + component] = values[component]!;
    }
  }
}

function createSkinningStream(
  source: NonNullable<Geometry3D['skinning']>,
  vertexCount: number,
  createError: GeometryTransformError,
): MutableSkinningStream {
  validateVertexStream(source.joints, 4, vertexCount, 'skinning joints', createError);
  validateVertexStream(source.weights, 4, vertexCount, 'skinning weights', createError);
  const joints = Array.from(source.joints);
  const weights = Array.from(source.weights);
  for (let index = 0; index < joints.length; index++) {
    const joint = joints[index]!;
    const weight = weights[index]!;
    if (!Number.isInteger(joint) || joint < 0 || !Number.isFinite(weight) || weight < 0) {
      throw createError(
        `Skinning influence ${index} must use a non-negative integer joint and finite non-negative weight.`,
      );
    }
  }
  return { joints, weights, jointMatrices: Float32Array.from(source.jointMatrices) };
}

function writeInterpolatedSkinning(
  skinning: MutableSkinningStream,
  target: number | null,
  first: number,
  second: number,
  t: number,
): void {
  const joints: number[] = [];
  const weights: number[] = [];
  if (t <= 0 || t >= 1) {
    const sourceVertex = t <= 0 ? first : second;
    const sourceOffset = sourceVertex * 4;
    for (let component = 0; component < 4; component++) {
      joints.push(skinning.joints[sourceOffset + component]!);
      weights.push(skinning.weights[sourceOffset + component]!);
    }
  } else {
    const influences = new Map<number, number>();
    for (const [vertex, factor] of [[first, 1 - t], [second, t]] as const) {
      const offset = vertex * 4;
      for (let component = 0; component < 4; component++) {
        const weight = skinning.weights[offset + component]! * factor;
        if (weight <= 0) continue;
        const joint = skinning.joints[offset + component]!;
        influences.set(joint, (influences.get(joint) ?? 0) + weight);
      }
    }
    const selected = [...influences]
      .sort((left, right) => right[1] - left[1] || left[0] - right[0])
      .slice(0, 4);
    const totalWeight = selected.reduce((sum, influence) => sum + influence[1], 0);
    for (let component = 0; component < 4; component++) {
      const influence = selected[component];
      joints.push(influence?.[0] ?? 0);
      weights.push(influence && totalWeight > 0 ? influence[1] / totalWeight : 0);
    }
  }
  if (target === null) {
    skinning.joints.push(...joints);
    skinning.weights.push(...weights);
  } else {
    const targetOffset = target * 4;
    for (let component = 0; component < 4; component++) {
      skinning.joints[targetOffset + component] = joints[component]!;
      skinning.weights[targetOffset + component] = weights[component]!;
    }
  }
}

function extractStream(stream: MutableVertexStream, order: readonly number[]): Float32Array {
  const output = new Float32Array(order.length * stream.itemSize);
  for (let outputVertex = 0; outputVertex < order.length; outputVertex++) {
    const sourceOffset = order[outputVertex]! * stream.itemSize;
    const outputOffset = outputVertex * stream.itemSize;
    for (let component = 0; component < stream.itemSize; component++) {
      output[outputOffset + component] = stream.data[sourceOffset + component]!;
    }
  }
  return output;
}

function extractSkinning(stream: MutableSkinningStream, order: readonly number[]): Skinning3DOptions {
  const joints = new Float32Array(order.length * 4);
  const weights = new Float32Array(order.length * 4);
  for (let outputVertex = 0; outputVertex < order.length; outputVertex++) {
    const sourceOffset = order[outputVertex]! * 4;
    const outputOffset = outputVertex * 4;
    for (let component = 0; component < 4; component++) {
      joints[outputOffset + component] = stream.joints[sourceOffset + component]!;
      weights[outputOffset + component] = stream.weights[sourceOffset + component]!;
    }
  }
  return { joints, weights, jointMatrices: Float32Array.from(stream.jointMatrices) };
}

function copyInstanceAttributes(source: Geometry3D): InstanceAttribute[] {
  return [...source.instanceAttributes.values()].map(attribute => ({
    ...attribute,
    data: Float32Array.from(attribute.data),
  }));
}

function normalizeVector(values: number[]): void {
  let lengthSquared = 0;
  for (const value of values) lengthSquared += value * value;
  if (lengthSquared <= Number.EPSILON) return;
  const inverseLength = 1 / Math.sqrt(lengthSquared);
  for (let index = 0; index < values.length; index++) values[index] = values[index]! * inverseLength;
}

function isVertexStream(value: MutableVertexStream | null): value is MutableVertexStream {
  return value !== null;
}
