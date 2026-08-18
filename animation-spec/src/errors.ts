export type AnimationFormatErrorCode =
  | 'E_ANIMATION_INVALID_FORMAT'
  | 'E_ANIMATION_UNSUPPORTED_VERSION'
  | 'E_ANIMATION_LIMIT_EXCEEDED'
  | 'E_ANIMATION_MISSING_EXTENSION'
  | 'E_ANIMATION_INVALID_BINARY';

export class AnimationFormatError extends Error {
  readonly name = 'AnimationFormatError';

  constructor(
    readonly code: AnimationFormatErrorCode,
    message: string,
    readonly path = '$',
  ) {
    super(`${message} (${path})`);
  }
}
