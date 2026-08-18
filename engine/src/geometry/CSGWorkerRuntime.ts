/**
 * Creates a dedicated module-worker runtime. The imported module must be the
 * published `@haiyue/engine/geometry` entrypoint.
 */
export function createCSGWorkerSource(geometryModuleUrl: string): string {
  return `
const geometryModulePromise = import(${JSON.stringify(geometryModuleUrl)});
const prepared = new Map();
const preparing = new Set();
const cancelledPreparations = new Set();

self.addEventListener('message', async event => {
  const request = event.data;
  if (!request || typeof request !== 'object') return;
  if (request.type === 'release') {
    prepared.delete(request.handleId);
    return;
  }
  if (request.type === 'cancel') {
    if (request.requestType === 'prepare' && preparing.has(request.id)) {
      cancelledPreparations.add(request.id);
    }
    return;
  }
  if (!Number.isSafeInteger(request.id)) return;
  if (request.type === 'prepare') preparing.add(request.id);

  try {
    const geometryModule = await geometryModulePromise;
    if (request.type === 'prepare') {
      if (cancelledPreparations.delete(request.id)) return;
      prepared.set(request.handleId, geometryFromPayload(request.geometry, geometryModule.Geometry3D));
      self.postMessage({ id: request.id, ok: true, type: 'prepared', handleId: request.handleId });
      return;
    }
    if (request.type !== 'compute') throw protocolError('Unknown CSG worker request type.');
    const storedA = requiredPrepared(request.a && request.a.handleId);
    const storedB = requiredPrepared(request.b && request.b.handleId);
    const a = transformGeometry(storedA, request.a && request.a.transform, geometryModule.Geometry3D);
    const b = transformGeometry(storedB, request.b && request.b.transform, geometryModule.Geometry3D);
    const started = performance.now();
    const result = geometryModule.createCSGGeometry(a, b, request.operation);
    const workerComputeMs = performance.now() - started;
    const geometry = geometryToPayload(result);
    const transfer = geometryTransferList(geometry);
    self.postMessage({ id: request.id, ok: true, type: 'computed', geometry, workerComputeMs }, transfer);
  } catch (error) {
    self.postMessage({ id: request.id, ok: false, error: serializeError(error) });
  } finally {
    preparing.delete(request.id);
    cancelledPreparations.delete(request.id);
  }
});

function requiredPrepared(handleId) {
  const geometry = prepared.get(handleId);
  if (!geometry) throw protocolError('Unknown or released CSG prepared geometry handle.');
  return geometry;
}

function geometryFromPayload(data, Geometry3D) {
  if (!data || !(data.positions instanceof Float32Array)) {
    throw protocolError('CSG worker received invalid geometry data.');
  }
  return new Geometry3D({
    positions: data.positions,
    ...(data.normals instanceof Float32Array ? { normals: data.normals } : {}),
    ...(data.uvs instanceof Float32Array
      ? { textureCoordinates: [{ set: 0, data: data.uvs }], textureCoordinateLayout: [0] }
      : {}),
    ...(data.indices instanceof Uint16Array || data.indices instanceof Uint32Array ? { indices: data.indices } : {}),
    ...(typeof data.topology === 'string' ? { topology: data.topology } : {}),
  });
}

function geometryToPayload(geometry) {
  const uvs = geometry.getTextureCoordinates(0);
  return {
    positions: geometry.positions,
    ...(geometry.normals ? { normals: geometry.normals } : {}),
    ...(uvs ? { uvs } : {}),
    ...(geometry.indices ? { indices: geometry.indices } : {}),
    topology: geometry.topology,
  };
}

function geometryTransferList(geometry) {
  const buffers = [geometry.positions.buffer];
  if (geometry.normals) buffers.push(geometry.normals.buffer);
  if (geometry.uvs) buffers.push(geometry.uvs.buffer);
  if (geometry.indices) buffers.push(geometry.indices.buffer);
  return [...new Set(buffers)];
}

function transformGeometry(geometry, matrix, Geometry3D) {
  if (matrix === undefined) return geometry;
  if (!(matrix instanceof Float32Array) || matrix.length !== 16) {
    throw protocolError('CSG operand transform must contain 16 finite numbers.');
  }
  for (const value of matrix) {
    if (!Number.isFinite(value)) throw protocolError('CSG operand transform must contain 16 finite numbers.');
  }

  const positions = new Float32Array(geometry.positions.length);
  for (let offset = 0; offset < positions.length; offset += 3) {
    const x = geometry.positions[offset];
    const y = geometry.positions[offset + 1];
    const z = geometry.positions[offset + 2];
    const w = matrix[3] * x + matrix[7] * y + matrix[11] * z + matrix[15];
    const inverseW = Math.abs(w) > 1e-8 ? 1 / w : 1;
    positions[offset] = (matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12]) * inverseW;
    positions[offset + 1] = (matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13]) * inverseW;
    positions[offset + 2] = (matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14]) * inverseW;
  }

  const normals = geometry.normals ? transformNormals(geometry.normals, matrix) : undefined;
  const uvs = geometry.getTextureCoordinates(0);
  return new Geometry3D({
    positions,
    ...(normals ? { normals } : {}),
    ...(uvs ? { textureCoordinates: [{ set: 0, data: uvs }], textureCoordinateLayout: [0] } : {}),
    ...(geometry.indices ? { indices: geometry.indices } : {}),
    ...(geometry.topology ? { topology: geometry.topology } : {}),
  });
}

function transformNormals(source, matrix) {
  const a00 = matrix[0], a01 = matrix[4], a02 = matrix[8];
  const a10 = matrix[1], a11 = matrix[5], a12 = matrix[9];
  const a20 = matrix[2], a21 = matrix[6], a22 = matrix[10];
  const c00 = a11 * a22 - a12 * a21;
  const c01 = a12 * a20 - a10 * a22;
  const c02 = a10 * a21 - a11 * a20;
  const c10 = a02 * a21 - a01 * a22;
  const c11 = a00 * a22 - a02 * a20;
  const c12 = a01 * a20 - a00 * a21;
  const c20 = a01 * a12 - a02 * a11;
  const c21 = a02 * a10 - a00 * a12;
  const c22 = a00 * a11 - a01 * a10;
  const determinant = a00 * c00 + a01 * c01 + a02 * c02;
  if (Math.abs(determinant) <= 1e-12) {
    const error = new Error('CSG operand transform must be invertible.');
    error.code = 'E_GEOMETRY_INVALID_PARAMETER';
    error.domain = 'engine';
    error.recovery = 'terminate-runtime';
    error.path = 'csg.worker.compute.transform';
    throw error;
  }
  const inverseDeterminant = 1 / determinant;
  const normals = new Float32Array(source.length);
  for (let offset = 0; offset < source.length; offset += 3) {
    const x = source[offset], y = source[offset + 1], z = source[offset + 2];
    const nx = (c00 * x + c01 * y + c02 * z) * inverseDeterminant;
    const ny = (c10 * x + c11 * y + c12 * z) * inverseDeterminant;
    const nz = (c20 * x + c21 * y + c22 * z) * inverseDeterminant;
    const length = Math.hypot(nx, ny, nz);
    normals[offset] = length > 1e-8 ? nx / length : 0;
    normals[offset + 1] = length > 1e-8 ? ny / length : 1;
    normals[offset + 2] = length > 1e-8 ? nz / length : 0;
  }
  return normals;
}

function protocolError(message) {
  const error = new Error(message);
  error.code = 'E_WORKER_PROTOCOL_INVALID';
  error.domain = 'worker';
  error.recovery = 'terminate-runtime';
  error.path = 'csg.worker.request';
  return error;
}

function serializeError(error) {
  const knownCode = error && (
    error.code === 'E_GEOMETRY_INVALID_PARAMETER'
    || error.code === 'E_WORKER_PROTOCOL_INVALID'
  );
  const code = knownCode ? error.code : 'E_WORKER_PROTOCOL_INVALID';
  return {
    name: 'EngineError',
    domain: error && typeof error.domain === 'string'
      ? error.domain
      : code === 'E_WORKER_PROTOCOL_INVALID' ? 'worker' : 'engine',
    code,
    message: error instanceof Error ? error.message : String(error),
    recoverable: false,
    recovery: error && typeof error.recovery === 'string' ? error.recovery : 'terminate-runtime',
    context: error && error.context && typeof error.context === 'object' ? error.context : {},
    path: error && typeof error.path === 'string' ? error.path : 'csg.worker.compute',
    ...(error instanceof Error && typeof error.stack === 'string' ? { stack: error.stack } : {}),
  };
}
`.trim();
}
