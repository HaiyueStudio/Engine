import type {HyaCompositionErrorCode} from './types.js';

export class HyaCompositionError extends Error {
  override readonly name = 'HyaCompositionError';
  constructor(readonly code: HyaCompositionErrorCode, readonly path: string,
      message: string, readonly capability?: string, readonly causeCode?: string) {
    super(`${message} (${path})`);
  }
}
