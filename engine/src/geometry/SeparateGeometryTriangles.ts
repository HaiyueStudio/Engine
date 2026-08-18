import { EngineError, EngineErrorCode } from '../core/EngineError';
import { requiredNumberAt } from '../math/arrayAccess';
import {
  Geometry3D,
  type CustomAttribute,
  type Geometry3DTextureCoordinateSet,
  type InstanceAttribute,
  type MorphTarget3D,
  type Skinning3DOptions,
} from './Geometry3D';

/**
 * Creates a non-indexed triangle-list geometry whose three vertex records are
 * unique to each triangle. Triangle order, winding, degenerate triangles, and
 * every per-vertex deformation attribute are preserved.
 *
 * The source geometry and all of its arrays remain untouched. Per-instance
 * attributes are copied without expansion because they are not vertex data.
 */
export function separateGeometryTriangles(source: Geometry3D): Geometry3D {
  if (source.topology !== null && source.topology !== 'triangle-list') {
    throw separationError(
      `separateGeometryTriangles requires triangle-list geometry; received ${String(source.topology)}.`,
    );
  }

  const vertexCount = validatePositions(source.positions);
  const remap = createTriangleVertexRemap(source.indices, vertexCount);
  const positions = expandVertexAttribute(source.positions, 3, vertexCount, remap, 'positions');
  const normals = source.normals
    ? expandVertexAttribute(source.normals, 3, vertexCount, remap, 'normals')
    : undefined;
  const textureCoordinates = copyTextureCoordinates(source, vertexCount, remap);
  const customAttributes = copyCustomAttributes(source, vertexCount, remap);
  const instanceAttributes = copyInstanceAttributes(source);
  const morphTargets = copyMorphTargets(source, vertexCount, remap);
  const skinning = copySkinning(source, vertexCount, remap);

  const result = new Geometry3D({
    positions,
    ...(normals ? { normals } : {}),
    textureCoordinates,
    textureCoordinateLayout: source.textureCoordinateLayout,
    ...(source.topology ? { topology: source.topology } : {}),
    ...(source.cullMode ? { cullMode: source.cullMode } : {}),
    ...(source.frontFace ? { frontFace: source.frontFace } : {}),
    customAttributes,
    instanceAttributes,
    instanceCount: source.instanceCount,
    morphTargets,
    morphWeights: source.morphWeights,
    morphUseGpu: source.morphUseGpu,
    ...(skinning ? { skinning } : {}),
    boundsMode: source.boundsMode,
    localBounds: source.localBounds,
  });

  // CPU morphing keeps an undeformed base separate from the current positions.
  // Preserve that state rather than treating the current deformed pose as base.
  result.morphBasePositions = source.morphBasePositions
    ? expandVertexAttribute(source.morphBasePositions, 3, vertexCount, remap, 'morph base positions')
    : null;
  result.morphBaseNormals = source.morphBaseNormals
    ? expandVertexAttribute(source.morphBaseNormals, 3, vertexCount, remap, 'morph base normals')
    : null;

  return result;
}

function validatePositions(positions: Float32Array): number {
  if (!(positions instanceof Float32Array) || positions.length % 3 !== 0) {
    throw separationError('Source positions must be a Float32Array with complete xyz triplets.');
  }
  return positions.length / 3;
}

function createTriangleVertexRemap(
  indices: Uint16Array | Uint32Array | null,
  vertexCount: number,
): Uint16Array | Uint32Array | null {
  if (indices === null) {
    if (vertexCount % 3 !== 0) {
      throw separationError(
        `Non-indexed source must contain complete triangles; received ${vertexCount} vertices.`,
      );
    }
    return null;
  }
  if (!(indices instanceof Uint16Array) && !(indices instanceof Uint32Array)) {
    throw separationError('Source indices must be Uint16Array, Uint32Array, or null.');
  }
  if (indices.length % 3 !== 0) {
    throw separationError(
      `Indexed source must contain complete triangles; received ${indices.length} indices.`,
    );
  }
  for (let offset = 0; offset < indices.length; offset++) {
    const index = requiredNumberAt(indices, offset, 'triangle separation indices');
    if (index >= vertexCount) {
      throw separationError(
        `Source index ${index} at offset ${offset} exceeds vertexCount ${vertexCount}.`,
      );
    }
  }
  return indices;
}

function copyTextureCoordinates(
  source: Geometry3D,
  vertexCount: number,
  remap: Uint16Array | Uint32Array | null,
): Geometry3DTextureCoordinateSet[] {
  return [...source.textureCoordinates].map(([set, data]) => ({
    set,
    data: expandVertexAttribute(data, 2, vertexCount, remap, `TEXCOORD_${set}`),
  }));
}

function copyCustomAttributes(
  source: Geometry3D,
  vertexCount: number,
  remap: Uint16Array | Uint32Array | null,
): CustomAttribute[] {
  return [...source.customAttributes.values()].map(attribute => ({
    ...attribute,
    data: expandVertexAttribute(
      attribute.data,
      attribute.itemSize,
      vertexCount,
      remap,
      `custom attribute "${attribute.name}"`,
    ),
  }));
}

function copyInstanceAttributes(source: Geometry3D): InstanceAttribute[] {
  return [...source.instanceAttributes.values()].map(attribute => ({
    ...attribute,
    data: Float32Array.from(attribute.data),
  }));
}

function copyMorphTargets(
  source: Geometry3D,
  vertexCount: number,
  remap: Uint16Array | Uint32Array | null,
): MorphTarget3D[] {
  return source.morphTargets.map((target, index) => ({
    ...(target.positions ? {
      positions: expandVertexAttribute(
        target.positions,
        3,
        vertexCount,
        remap,
        `morph target ${index} positions`,
      ),
    } : {}),
    ...(target.normals ? {
      normals: expandVertexAttribute(
        target.normals,
        3,
        vertexCount,
        remap,
        `morph target ${index} normals`,
      ),
    } : {}),
  }));
}

function copySkinning(
  source: Geometry3D,
  vertexCount: number,
  remap: Uint16Array | Uint32Array | null,
): Skinning3DOptions | null {
  if (!source.skinning) return null;
  return {
    joints: expandVertexAttribute(source.skinning.joints, 4, vertexCount, remap, 'skinning joints'),
    weights: expandVertexAttribute(source.skinning.weights, 4, vertexCount, remap, 'skinning weights'),
    jointMatrices: Float32Array.from(source.skinning.jointMatrices),
  };
}

function expandVertexAttribute(
  data: Float32Array,
  itemSize: number,
  vertexCount: number,
  remap: Uint16Array | Uint32Array | null,
  label: string,
): Float32Array {
  if (!(data instanceof Float32Array)) {
    throw separationError(`${label} must be a Float32Array.`);
  }
  if (!Number.isInteger(itemSize) || itemSize <= 0) {
    throw separationError(`${label} itemSize must be a positive integer; received ${itemSize}.`);
  }
  const expectedLength = vertexCount * itemSize;
  if (data.length !== expectedLength) {
    throw separationError(
      `${label} length must be vertexCount * itemSize (${expectedLength}); received ${data.length}.`,
    );
  }
  if (remap === null) return Float32Array.from(data);

  const output = new Float32Array(remap.length * itemSize);
  for (let outputVertex = 0; outputVertex < remap.length; outputVertex++) {
    const sourceVertex = requiredNumberAt(remap, outputVertex, 'triangle separation indices');
    const sourceOffset = sourceVertex * itemSize;
    const outputOffset = outputVertex * itemSize;
    for (let component = 0; component < itemSize; component++) {
      output[outputOffset + component] = requiredNumberAt(data, sourceOffset + component, label);
    }
  }
  return output;
}

function separationError(message: string): EngineError {
  return new EngineError(
    EngineErrorCode.GeometryInvalidParameter,
    message,
    {
      hint: 'Provide complete triangle-list geometry with every per-vertex attribute aligned to vertexCount.',
      docsPath: 'errors/E_GEOMETRY_INVALID_PARAMETER',
    },
  );
}
