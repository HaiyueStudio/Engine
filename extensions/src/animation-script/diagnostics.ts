import type { ScriptLocation, ScriptRuntimeDiagnostic } from './runtime-types.js';

export type ScriptRuntimeDiagnosticCode =
  | 'E_SCRIPT_RUNTIME_ERROR'
  | 'E_SCRIPT_TIMEOUT'
  | 'E_SCRIPT_OOM'
  | 'E_SCRIPT_CAPABILITY_DENIED'
  | 'E_SCRIPT_PROTOCOL'
  | 'E_SCRIPT_ABORTED'
  | 'E_SCRIPT_WORKER_CRASH'
  | 'E_SCRIPT_EVENT_BUDGET'
  | 'E_SCRIPT_DISPOSED'
  | 'E_SHADER_VALIDATION'
  | 'E_SHADER_BINDING'
  | 'E_SHADER_BUDGET'
  | 'E_SHADER_DEVICE_LOST';

export class AnimationScriptRuntimeError extends Error {
  readonly diagnostic: ScriptRuntimeDiagnostic;
  readonly code: ScriptRuntimeDiagnosticCode;

  constructor(
    code: ScriptRuntimeDiagnosticCode,
    message: string,
    context: { programId?: string | undefined; invocationId?: string | undefined; path?: string | undefined; location?: ScriptLocation | undefined; instructions?: number | undefined } = {},
  ) {
    super(`${code}: ${message}`);
    this.name = 'AnimationScriptRuntimeError';
    this.code = code;
    this.diagnostic = Object.freeze({ code, message: redact(message), ...context });
  }
}
export function scriptRuntimeFail(
  code: ScriptRuntimeDiagnosticCode,
  message: string,
  context: { programId?: string | undefined; invocationId?: string | undefined; path?: string | undefined; location?: ScriptLocation | undefined; instructions?: number | undefined } = {},
): never {
  throw new AnimationScriptRuntimeError(code, message, context);
}

function redact(message: string): string {
  return message
    .replace(/\b(?:https?|file):\/\/\S+/gi, '[redacted-url]')
    .replace(/[A-Za-z]:\\[^\s]+/g, '[redacted-path]')
    .slice(0, 512);
}
