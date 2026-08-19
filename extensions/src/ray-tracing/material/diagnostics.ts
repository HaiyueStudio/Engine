import type { RayMaterialDiagnostic, RayMaterialPhase, RayMaterialSeverity } from './types.js';

export function materialDiagnostic(
  phase: RayMaterialPhase,
  severity: RayMaterialSeverity,
  code: string,
  message: string,
  context: Readonly<Record<string, string | number | boolean | null>> = {},
): RayMaterialDiagnostic {
  return Object.freeze({ phase, severity, code, message, context: Object.freeze({ ...context }) });
}
