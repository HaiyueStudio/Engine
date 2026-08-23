export type AudioRuntimeDiagnosticCode =
  | 'E_AUDIO_RUNTIME_STATE'
  | 'E_AUDIO_RUNTIME_PORT'
  | 'E_AUDIO_RUNTIME_LIMIT'
  | 'E_AUDIO_RUNTIME_RESOURCE'
  | 'E_AUDIO_RUNTIME_INTEGRITY'
  | 'E_AUDIO_RUNTIME_DECODE'
  | 'E_AUDIO_RUNTIME_PROFILE'
  | 'E_AUDIO_RUNTIME_CLOCK'
  | 'E_AUDIO_RUNTIME_AUTOPLAY'
  | 'E_AUDIO_RUNTIME_ABORTED';

export class AudioRuntimeError extends Error {
  readonly name = 'AudioRuntimeError';

  constructor(
    readonly code: AudioRuntimeDiagnosticCode,
    readonly path: string,
    message: string,
    readonly context: Readonly<Record<string, unknown>> = Object.freeze({}),
  ) {
    super(`${message} (${path})`);
  }
}

export function audioRuntimeFail(
  code: AudioRuntimeDiagnosticCode,
  path: string,
  message: string,
  context: Readonly<Record<string, unknown>> = Object.freeze({}),
): never {
  throw new AudioRuntimeError(code, path, message, context);
}
