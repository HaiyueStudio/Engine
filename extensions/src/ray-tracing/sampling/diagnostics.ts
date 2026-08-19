import type { RayPathDiagnosticPhase } from '../renderer/index.js';
import type { RayProgressiveDiagnostic } from './types.js';

export function samplingDiagnostic(
  phase: RayPathDiagnosticPhase | 'sampling' | 'accumulation' | 'denoise' | 'present',
  severity: RayProgressiveDiagnostic['severity'],
  code: string,
  message: string,
  context: Readonly<Record<string, string | number | boolean | null>> = {},
): RayProgressiveDiagnostic {
  return Object.freeze({ phase, severity, code, message, context: Object.freeze({ ...context }) });
}
