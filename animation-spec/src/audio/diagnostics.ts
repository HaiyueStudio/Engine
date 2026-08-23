export type AudioEventDiagnosticCode =
  | 'E_AUDIO_EVENT_FORMAT'
  | 'E_AUDIO_EVENT_VERSION'
  | 'E_AUDIO_EVENT_NUMBER'
  | 'E_AUDIO_EVENT_LIMIT'
  | 'E_AUDIO_EVENT_REFERENCE'
  | 'E_AUDIO_EVENT_GRAPH'
  | 'E_AUDIO_EVENT_CODEC'
  | 'E_AUDIO_EVENT_INTEGRITY';

export class AudioEventDiagnostic extends Error {
  readonly name = 'AudioEventDiagnostic';

  constructor(
    readonly code: AudioEventDiagnosticCode,
    readonly path: string,
    message: string,
  ) {
    super(`${message} (${path})`);
  }
}

export function audioEventFail(
  code: AudioEventDiagnosticCode,
  path: string,
  message: string,
): never {
  throw new AudioEventDiagnostic(code, path, message);
}
