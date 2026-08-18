import type { CSGOperation } from './CSG';
import type { Geometry3D } from './Geometry3D';

/**
 * Opaque handle for geometry prepared inside one {@link CSGWorker}.
 *
 * Handles are owned by the worker that created them and become invalid after
 * release or disposal.
 */
export interface CSGPreparedGeometry {
  readonly id: number;
}

/**
 * Public facade for one dedicated asynchronous CSG worker.
 *
 * The worker keeps at most one active compute and one latest queued compute.
 * A prepared geometry handle can only be used with the worker that created it.
 */
export interface CSGWorker {
  readonly diagnostics: {
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
  };

  prepareGeometry(
    geometry: Geometry3D,
    options?: { readonly signal?: AbortSignal },
  ): Promise<CSGPreparedGeometry>;

  compute(
    a: {
      readonly geometry: CSGPreparedGeometry;
      /** Column-major 4x4 transform applied inside the worker. */
      readonly transform?: ArrayLike<number>;
    },
    b: {
      readonly geometry: CSGPreparedGeometry;
      /** Column-major 4x4 transform applied inside the worker. */
      readonly transform?: ArrayLike<number>;
    },
    operation: CSGOperation,
    options?: { readonly signal?: AbortSignal },
  ): Promise<Geometry3D>;

  releaseGeometry(handle: CSGPreparedGeometry): void;
  dispose(options?: { readonly terminate?: boolean }): void;
}
