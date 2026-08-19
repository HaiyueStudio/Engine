import type { RayWorkerDiagnostic, RayWorkerDiagnosticCode } from './types.js';

export function rayWorkerDiagnostic(
  phase: RayWorkerDiagnostic['phase'], severity: RayWorkerDiagnostic['severity'], code: RayWorkerDiagnosticCode,
  message: string, context: Readonly<Record<string, string | number | boolean | null>> = {},
): RayWorkerDiagnostic {
  return Object.freeze({ phase, severity, code, message, context: Object.freeze({ ...context }) });
}
