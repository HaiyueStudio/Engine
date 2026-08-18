export type AsyncPriority = 'background' | 'normal' | 'interactive' | 'critical';

export const ASYNC_PRIORITY_VALUE: Readonly<Record<AsyncPriority, number>> = Object.freeze({
  background: 0,
  normal: 100,
  interactive: 200,
  critical: 300,
});

export function normalizeAsyncPriority(
  priority: AsyncPriority | number | undefined,
  fallback: AsyncPriority = 'normal',
): number {
  if (typeof priority === 'number') return Number.isFinite(priority) ? priority : ASYNC_PRIORITY_VALUE[fallback];
  return ASYNC_PRIORITY_VALUE[priority ?? fallback];
}

export function monotonicNow(): number {
  return globalThis.performance?.now() ?? Date.now();
}

export function createAbortError(message: string, cause?: unknown): Error {
  const error = new Error(message, { cause });
  error.name = 'AbortError';
  return error;
}

export function isAbortError(error: unknown): error is Error {
  return error instanceof Error && error.name === 'AbortError';
}
