import {
  EngineError,
  EngineErrorCode,
  ErrorDomain,
  ErrorRecovery,
  isSerializedEngineError,
} from '../core/EngineError';
import type { SerializedEngineError } from '../core/EngineError';
import type { CSGOperation } from './CSG';
import { Geometry3D } from './Geometry3D';
import type { CSGPreparedGeometry } from './CSGWorkerPublic';

export interface CSGGeometryData {
  readonly positions: Float32Array;
  readonly normals?: Float32Array;
  readonly uvs?: Float32Array;
  readonly indices?: Uint16Array | Uint32Array;
  readonly topology: GPUPrimitiveTopology | null;
}

export interface CSGWorkerOperand {
  readonly geometry: CSGPreparedGeometry;
  /** Column-major 4x4 transform applied inside the worker. */
  readonly transform?: ArrayLike<number>;
}

export interface CSGWorkerComputeOptions {
  readonly signal?: AbortSignal;
}

export interface CSGWorkerDiagnostics {
  readonly pendingRequestCount: number;
  readonly preparedGeometryCount: number;
  readonly hasActiveCompute: boolean;
  readonly hasQueuedCompute: boolean;
  readonly requestsPosted: number;
  readonly computeRequestsPosted: number;
  readonly supersededComputeCount: number;
  readonly abortedRequestCount: number;
  readonly inputTransferBytes: number;
  readonly outputTransferBytes: number;
}

export interface CSGWorkerLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(
    type: 'message' | 'error' | 'messageerror',
    listener: (event: MessageEvent<unknown> | Event) => void,
  ): void;
  removeEventListener(
    type: 'message' | 'error' | 'messageerror',
    listener: (event: MessageEvent<unknown> | Event) => void,
  ): void;
  terminate?(): void;
}

export interface CSGPrepareRequest {
  readonly id: number;
  readonly type: 'prepare';
  readonly handleId: number;
  readonly geometry: CSGGeometryData;
}

export interface CSGComputeRequest {
  readonly id: number;
  readonly type: 'compute';
  readonly operation: CSGOperation;
  readonly a: SerializedCSGWorkerOperand;
  readonly b: SerializedCSGWorkerOperand;
}

export interface CSGReleaseRequest {
  readonly type: 'release';
  readonly handleId: number;
}

export interface CSGCancelRequest {
  readonly type: 'cancel';
  readonly id: number;
  readonly requestType: 'prepare' | 'compute';
}

export interface SerializedCSGWorkerOperand {
  readonly handleId: number;
  readonly transform?: Float32Array;
}

interface CSGPreparedResponse {
  readonly id: number;
  readonly ok: true;
  readonly type: 'prepared';
  readonly handleId: number;
}

interface CSGComputedResponse {
  readonly id: number;
  readonly ok: true;
  readonly type: 'computed';
  readonly geometry: CSGGeometryData;
  readonly workerComputeMs: number;
}

interface CSGFailureResponse {
  readonly id: number;
  readonly ok: false;
  readonly error: SerializedEngineError;
}

export type CSGWorkerResponse = CSGPreparedResponse | CSGComputedResponse | CSGFailureResponse;

export function copyGeometryData(geometry: Geometry3D): CSGGeometryData {
  const uvs = geometry.getTextureCoordinates(0);
  const indices = geometry.indices;
  return {
    positions: Float32Array.from(geometry.positions),
    ...(geometry.normals ? { normals: Float32Array.from(geometry.normals) } : {}),
    ...(uvs ? { uvs: Float32Array.from(uvs) } : {}),
    ...(indices instanceof Uint16Array
      ? { indices: Uint16Array.from(indices) }
      : indices instanceof Uint32Array
        ? { indices: Uint32Array.from(indices) }
        : {}),
    topology: geometry.topology,
  };
}

export function geometryFromData(data: CSGGeometryData): Geometry3D {
  return new Geometry3D({
    positions: data.positions,
    ...(data.normals ? { normals: data.normals } : {}),
    ...(data.uvs
      ? { textureCoordinates: [{ set: 0, data: data.uvs }], textureCoordinateLayout: [0] }
      : {}),
    ...(data.indices ? { indices: data.indices } : {}),
    ...(data.topology ? { topology: data.topology } : {}),
  });
}

export function geometryDataTransferList(data: CSGGeometryData): Transferable[] {
  const buffers: ArrayBuffer[] = [data.positions.buffer as ArrayBuffer];
  if (data.normals) buffers.push(data.normals.buffer as ArrayBuffer);
  if (data.uvs) buffers.push(data.uvs.buffer as ArrayBuffer);
  if (data.indices) buffers.push(data.indices.buffer as ArrayBuffer);
  return [...new Set(buffers)];
}

export function geometryDataByteLength(data: CSGGeometryData): number {
  return data.positions.byteLength
    + (data.normals?.byteLength ?? 0)
    + (data.uvs?.byteLength ?? 0)
    + (data.indices?.byteLength ?? 0);
}

export function isCSGGeometryData(value: unknown): value is CSGGeometryData {
  if (!isRecord(value) || !(value.positions instanceof Float32Array)) return false;
  if (value.normals !== undefined && !(value.normals instanceof Float32Array)) return false;
  if (value.uvs !== undefined && !(value.uvs instanceof Float32Array)) return false;
  if (
    value.indices !== undefined
    && !(value.indices instanceof Uint16Array)
    && !(value.indices instanceof Uint32Array)
  ) return false;
  return value.topology === null || typeof value.topology === 'string';
}

export function isCSGWorkerResponse(value: unknown): value is CSGWorkerResponse {
  if (!hasResponseId(value) || typeof value.ok !== 'boolean') return false;
  if (!value.ok) return isSerializedEngineError(value.error);
  if (value.type === 'prepared') return Number.isSafeInteger(value.handleId);
  return value.type === 'computed'
    && isCSGGeometryData(value.geometry)
    && typeof value.workerComputeMs === 'number'
    && Number.isFinite(value.workerComputeMs);
}

export function hasResponseId(value: unknown): value is Record<string, unknown> & { id: number } {
  return isRecord(value) && Number.isSafeInteger(value.id);
}

export function copyAndValidateTransform(transform: ArrayLike<number>, path: string): Float32Array {
  if (transform.length !== 16) {
    throw protocolError('CSG operand transform must contain exactly 16 numbers.', path);
  }
  const copy = new Float32Array(16);
  for (let index = 0; index < copy.length; index++) {
    const value = transform[index];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw protocolError('CSG operand transform must contain only finite numbers.', path);
    }
    copy[index] = value;
  }
  return copy;
}

export function assertCSGOperation(operation: CSGOperation): void {
  if (operation !== 'union' && operation !== 'subtract' && operation !== 'intersect') {
    throw protocolError(`Unsupported CSG operation: ${String(operation)}.`, 'csg.worker.compute.operation');
  }
}

function protocolError(message: string, path: string): EngineError {
  return new EngineError(EngineErrorCode.WorkerProtocolInvalid, message, {
    domain: ErrorDomain.Worker,
    recovery: ErrorRecovery.TerminateRuntime,
    context: {},
    path,
    hint: 'Use finite CSG geometry data and a column-major 4x4 transform.',
    docsPath: 'errors/E_WORKER_PROTOCOL_INVALID',
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
