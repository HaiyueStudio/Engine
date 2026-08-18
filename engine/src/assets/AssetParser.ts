import { EngineError, EngineErrorCode, ErrorDomain, ErrorRecovery } from '../core/EngineError';
import { createAbortError } from '../async/AsyncPrimitives';

export interface AssetParserContext {
  readonly signal?: AbortSignal;
  readonly source: string;
}

export interface AssetParser<Input, Output> {
  readonly type: string;
  parse(input: Input, context: AssetParserContext): Output | Promise<Output>;
}

export interface WorkerFirstParseOptions<Input, Output> {
  parser: AssetParser<Input, Output>;
  input: Input;
  context: AssetParserContext;
  worker?: ((input: Input, context: AssetParserContext) => Promise<Output>) | null;
  shouldFallback?: (error: unknown) => boolean;
  onFallback?: (diagnostic: WorkerFallbackDiagnostic) => void;
}

export interface WorkerFallbackDiagnostic {
  readonly kind: 'worker-infrastructure-fallback';
  readonly parserType: string;
  readonly source: string;
  readonly error: unknown;
}

/** Runs the same parser contract on both paths and only falls back for worker infrastructure failures. */
export async function parseAssetWorkerFirst<Input, Output>(options: WorkerFirstParseOptions<Input, Output>): Promise<Output> {
  throwIfAborted(options.context.signal);
  if (options.worker) {
    try {
      return await options.worker(options.input, options.context);
    } catch (error) {
      if (!(options.shouldFallback ?? isWorkerInfrastructureError)(error)) throw normalizeParserError(error, options.parser.type, options.context.source);
      const diagnostic = Object.freeze({
        kind: 'worker-infrastructure-fallback' as const,
        parserType: options.parser.type,
        source: options.context.source,
        error,
      });
      if (options.onFallback) options.onFallback(diagnostic);
      else console.warn('[HaiYue] Worker infrastructure fallback', diagnostic);
    }
  }
  try {
    return await options.parser.parse(options.input, options.context);
  } catch (error) {
    throw normalizeParserError(error, options.parser.type, options.context.source);
  }
}

export function isWorkerInfrastructureError(error: unknown): boolean {
  return error instanceof EngineError && (error.domain === ErrorDomain.Worker || error.code === EngineErrorCode.WorkerProtocolInvalid);
}

export function normalizeParserError(error: unknown, type: string, source: string): EngineError {
  if (error instanceof EngineError) return error;
  return new EngineError(EngineErrorCode.AssetInvalidData, error instanceof Error ? error.message : String(error), {
    domain: ErrorDomain.Asset,
    recovery: ErrorRecovery.ReleaseResource,
    context: { resourceType: type, source },
    path: `${type}.parse`,
    cause: error,
  });
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw createAbortError('Asset parsing aborted.', signal.reason);
}
