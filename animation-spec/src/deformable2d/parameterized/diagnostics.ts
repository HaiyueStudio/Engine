export type ParameterizedRigDiagnosticCode =
  | 'E_RIG_FORMAT'
  | 'E_RIG_LIMIT'
  | 'E_RIG_NUMBER'
  | 'E_RIG_REFERENCE'
  | 'E_RIG_CYCLE'
  | 'E_RIG_WEIGHT'
  | 'E_RIG_DEGENERATE'
  | 'E_RIG_NON_CONVERGENCE'
  | 'E_RIG_BINARY';

export class ParameterizedRigDiagnostic extends Error {
  readonly name = 'ParameterizedRigDiagnostic';
  constructor(readonly code: ParameterizedRigDiagnosticCode, readonly path: string, message: string) {
    super(`${code} at ${path}: ${message}`);
  }
}
