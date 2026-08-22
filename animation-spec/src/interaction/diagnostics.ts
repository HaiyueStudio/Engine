export type InteractionDiagnosticCode = 'E_INTERACTION_FORMAT' | 'E_INTERACTION_NUMBER' | 'E_INTERACTION_REFERENCE' | 'E_INTERACTION_LIMIT' | 'E_INTERACTION_GRAPH' | 'E_INTERACTION_ACTION';
export class InteractionDiagnostic extends Error { readonly name = 'InteractionDiagnostic'; constructor(readonly code: InteractionDiagnosticCode, readonly path: string, message: string) { super(`${message} (${path})`); } }
export function interactionFail(code: InteractionDiagnosticCode, path: string, message: string): never { throw new InteractionDiagnostic(code, path, message); }
