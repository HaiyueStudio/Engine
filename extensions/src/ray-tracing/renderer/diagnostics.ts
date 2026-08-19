import type { RayPathDiagnostic, RayPathDiagnosticPhase, RayPathDiagnosticSeverity } from './types.js';

export function pathDiagnostic(
  phase: RayPathDiagnosticPhase,
  severity: RayPathDiagnosticSeverity,
  code: string,
  message: string,
  context: Readonly<Record<string, string | number | boolean | null>> = {},
): RayPathDiagnostic {
  return Object.freeze({ phase, severity, code, message, context: Object.freeze({ ...context }) });
}
