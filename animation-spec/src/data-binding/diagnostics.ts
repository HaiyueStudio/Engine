export type DataBindingDiagnosticCode =
  | 'E_DATA_BINDING_FORMAT'
  | 'E_DATA_BINDING_NUMBER'
  | 'E_DATA_BINDING_REFERENCE'
  | 'E_DATA_BINDING_LIMIT'
  | 'E_DATA_BINDING_TYPE'
  | 'E_DATA_BINDING_PATH'
  | 'E_DATA_BINDING_GRAPH';

export class DataBindingDiagnostic extends Error {
  readonly name = 'DataBindingDiagnostic';
  constructor(readonly code: DataBindingDiagnosticCode, readonly path: string, message: string) {
    super(`${message} (${path})`);
  }
}

export function dataBindingFail(code: DataBindingDiagnosticCode, path: string, message: string): never {
  throw new DataBindingDiagnostic(code, path, message);
}
