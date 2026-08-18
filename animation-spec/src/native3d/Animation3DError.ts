export type Native3DAnimationDiagnosticCode =
  | 'E_ANIMATION_3D_INVALID_PAYLOAD'
  | 'E_ANIMATION_3D_MIXED_DIMENSIONS'
  | 'E_ANIMATION_3D_UNSUPPORTED_FEATURE'
  | 'E_ANIMATION_3D_UNKNOWN_RESOURCE'
  | 'E_ANIMATION_3D_BINDING_MISMATCH'
  | 'E_ANIMATION_3D_LIMIT_EXCEEDED';

/** Stable native-3D extension diagnostic. */
export class Native3DAnimationFormatError extends Error {
  readonly name = 'Native3DAnimationFormatError';

  constructor(
    readonly code: Native3DAnimationDiagnosticCode,
    message: string,
    readonly path: string,
  ) {
    super(`${message} (${path})`);
  }
}
