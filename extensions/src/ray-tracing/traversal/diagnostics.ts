import type { RayTraversalDiagnostic, RayTraversalPhase, RayTraversalSeverity } from './types.js';

export function traversalDiagnostic(
  phase: RayTraversalPhase,
  severity: RayTraversalSeverity,
  code: string,
  message: string,
  context: Record<string, string | number | boolean | null> = {},
): RayTraversalDiagnostic {
  return Object.freeze({ phase, severity, code, message, context: Object.freeze({ ...context }) });
}
