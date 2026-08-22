export type VectorVisualDiagnosticCode =
  | 'E_VECTOR_FORMAT'
  | 'E_VECTOR_LIMIT'
  | 'E_VECTOR_NUMBER'
  | 'E_VECTOR_REFERENCE'
  | 'E_VECTOR_TOPOLOGY'
  | 'E_VECTOR_CYCLE';

export class VectorVisualDiagnostic extends Error {
  readonly name = 'VectorVisualDiagnostic';

  constructor(
    readonly code: VectorVisualDiagnosticCode,
    readonly path: string,
    message: string,
  ) {
    super(`${code} at ${path}: ${message}`);
  }
}
