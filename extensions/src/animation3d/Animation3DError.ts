export type Animation3DErrorCode =
  | 'mixer-destroyed'
  | 'invalid-clip'
  | 'invalid-track'
  | 'invalid-action'
  | 'duplicate-action-id'
  | 'resolver-miss';

export type Animation3DErrorDetails = Readonly<Record<
  string,
  string | number | boolean | null
>>;

/**
 * Stable domain error for the Animation3D facade.
 *
 * Callers should branch on `code`; messages remain diagnostic and may gain
 * additional context without changing the error contract.
 */
export class Animation3DError extends Error {
  readonly code: Animation3DErrorCode;
  readonly details: Animation3DErrorDetails;

  constructor(
    code: Animation3DErrorCode,
    message: string,
    details: Animation3DErrorDetails = {},
  ) {
    super(message);
    this.name = 'Animation3DError';
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}
