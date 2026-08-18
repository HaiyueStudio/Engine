import { EngineError, EngineErrorCode } from '@haiyue/engine';
import { ErrorDomain, ErrorRecovery } from '@haiyue/engine/core';
import { createAbortError } from '@haiyue/engine/experimental/async';

export function throwIfGltfLoadAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw createAbortError('glTF load aborted.', signal.reason);
}

export function attachGltfSource(error: unknown, src: string): Error {
  if (error instanceof Error && error.name === 'AbortError') return error;
  if (error instanceof EngineError) {
    return new EngineError(error.code, error.message, {
      domain: error.domain,
      recoverable: error.recoverable,
      recovery: error.recovery,
      context: { url: src, resourceType: 'model/gltf', ...error.context },
      ...(error.path === undefined ? {} : { path: error.path }),
      ...(error.hint === undefined ? {} : { hint: error.hint }),
      ...(error.docsPath === undefined ? {} : { docsPath: error.docsPath }),
      cause: error,
    });
  }
  return gltfDataError(error instanceof Error ? error.message : String(error), { url: src }, undefined, error);
}

export function gltfDataError(
  message: string,
  context: Record<string, unknown> = {},
  path?: string,
  cause?: unknown,
): EngineError {
  const accessor = /[Aa]ccessor\s+(\d+)/.exec(message)?.[1];
  const bufferView = /bufferView\s+(\d+)/i.exec(message)?.[1];
  const buffer = /buffer\s+(\d+)/i.exec(message)?.[1];
  const failedLoad = /^Failed to load/.test(message);
  const resolvedPath = path
    ?? (accessor === undefined ? undefined : `gltf.accessors[${accessor}]`)
    ?? (bufferView === undefined ? undefined : `gltf.bufferViews[${bufferView}]`)
    ?? (buffer === undefined ? undefined : `gltf.buffers[${buffer}]`)
    ?? 'gltf';
  return new EngineError(
    failedLoad ? EngineErrorCode.AssetLoadFailed : EngineErrorCode.AssetInvalidData,
    message,
    {
      domain: ErrorDomain.Component,
      recovery: failedLoad ? ErrorRecovery.Retry : ErrorRecovery.ReleaseResource,
      context: {
        resourceType: 'model/gltf',
        ...context,
        ...(accessor === undefined ? {} : { accessor: Number(accessor) }),
        ...(bufferView === undefined ? {} : { bufferView: Number(bufferView) }),
        ...(buffer === undefined ? {} : { buffer: Number(buffer) }),
      },
      path: resolvedPath,
      cause,
    },
  );
}
