import type { RayHybridDiagnostic, RayHybridPhase } from './types.js';
export function hybridDiagnostic(phase: RayHybridPhase, severity: RayHybridDiagnostic['severity'], code: string, message: string, context: Readonly<Record<string, string | number | boolean | null>> = {}): RayHybridDiagnostic {
  return Object.freeze({ phase, severity, code, message, context: Object.freeze({ ...context }) });
}
