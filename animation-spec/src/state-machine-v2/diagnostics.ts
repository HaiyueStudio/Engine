export type StateMachineV2DiagnosticCode =
  | 'E_STATE_MACHINE_V2_FORMAT'
  | 'E_STATE_MACHINE_V2_NUMBER'
  | 'E_STATE_MACHINE_V2_REFERENCE'
  | 'E_STATE_MACHINE_V2_LIMIT'
  | 'E_STATE_MACHINE_V2_POLICY'
  | 'E_STATE_MACHINE_V2_GRAPH'
  | 'E_STATE_MACHINE_V2_MIGRATION';

export class StateMachineV2Diagnostic extends Error {
  readonly name = 'StateMachineV2Diagnostic';
  constructor(readonly code: StateMachineV2DiagnosticCode, readonly path: string, message: string) {
    super(`${message} (${path})`);
  }
}

export function stateMachineV2Fail(code: StateMachineV2DiagnosticCode, path: string, message: string): never {
  throw new StateMachineV2Diagnostic(code, path, message);
}
