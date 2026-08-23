export type SandboxedAnimationScriptDiagnosticCode =
  | 'E_ANIMATION_SCRIPT_FORMAT'
  | 'E_ANIMATION_SCRIPT_VERSION'
  | 'E_ANIMATION_SCRIPT_REFERENCE'
  | 'E_ANIMATION_SCRIPT_LIMIT'
  | 'E_ANIMATION_SCRIPT_PROTOCOL'
  | 'E_ANIMATION_SCRIPT_CAPABILITY'
  | 'E_ANIMATION_SCRIPT_ARTIFACT'
  | 'E_ANIMATION_SHADER_INVALID'
  | 'E_ANIMATION_SHADER_BINDING'
  | 'E_ANIMATION_SHADER_BUDGET';

export class SandboxedAnimationScriptError extends Error {
  readonly code: SandboxedAnimationScriptDiagnosticCode;
  readonly path: string;

  constructor(code: SandboxedAnimationScriptDiagnosticCode, path: string, message: string) {
    super(`${code} at ${path}: ${message}`);
    this.name = 'SandboxedAnimationScriptError';
    this.code = code;
    this.path = path;
  }
}
export function scriptFormatError(
  code: SandboxedAnimationScriptDiagnosticCode,
  path: string,
  message: string,
): never {
  throw new SandboxedAnimationScriptError(code, path, message);
}
