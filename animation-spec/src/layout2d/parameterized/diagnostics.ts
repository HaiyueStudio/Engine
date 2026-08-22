export type LayoutDiagnosticCode = 'E_LAYOUT_FORMAT' | 'E_LAYOUT_LIMIT' | 'E_LAYOUT_NUMBER' | 'E_LAYOUT_REFERENCE' | 'E_LAYOUT_CYCLE' | 'E_LAYOUT_OSCILLATION' | 'E_LAYOUT_SHAPING' | 'E_LAYOUT_ASSET_INTEGRITY' | 'E_LAYOUT_BINARY';

export class LayoutDiagnostic extends Error {
  readonly name = 'LayoutDiagnostic';
  constructor(readonly code: LayoutDiagnosticCode, readonly path: string, message: string) { super(`${code} at ${path}: ${message}`); }
}
