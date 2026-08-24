import type { RiveConversionDiagnosticCode } from './types.js';
export interface RiveConversionErrorContext { readonly objectIndex?: number; readonly objectTypeKey?: number; readonly propertyKey?: number; }
export class RiveConversionError extends Error {
  readonly name = 'RiveConversionError';
  constructor(readonly code: RiveConversionDiagnosticCode, message: string, readonly path: string, readonly context?: RiveConversionErrorContext, options?: ErrorOptions) { super(message, options); }
}
export function conversionFail(code: RiveConversionDiagnosticCode, message: string, path: string, context?: RiveConversionErrorContext, cause?: unknown): never {
  throw new RiveConversionError(code, message, path, context, cause === undefined ? undefined : { cause });
}
export function throwIfAborted(signal: AbortSignal, path = '$.signal'): void {
  if (signal.aborted) conversionFail('E_RIVE_CONVERT_ABORTED', 'Rive conversion was aborted.', path, undefined, signal.reason);
}
export function asConversionError(error: unknown, path: string): RiveConversionError {
  if (error instanceof RiveConversionError) return error;
  return new RiveConversionError('E_RIVE_CONVERT_INTERNAL', error instanceof Error ? error.message : String(error), path, undefined, { cause: error });
}
