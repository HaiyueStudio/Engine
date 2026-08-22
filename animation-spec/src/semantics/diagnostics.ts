export type SemanticsDiagnosticCode = 'E_SEMANTICS_FORMAT' | 'E_SEMANTICS_NUMBER' | 'E_SEMANTICS_REFERENCE' | 'E_SEMANTICS_LIMIT' | 'E_SEMANTICS_GRAPH';
export class SemanticsDiagnostic extends Error { readonly name = 'SemanticsDiagnostic'; constructor(readonly code: SemanticsDiagnosticCode, readonly path: string, message: string) { super(`${message} (${path})`); } }
export function semanticsFail(code: SemanticsDiagnosticCode, path: string, message: string): never { throw new SemanticsDiagnostic(code, path, message); }
