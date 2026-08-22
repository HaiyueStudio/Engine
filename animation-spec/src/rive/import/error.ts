import type { RiveImportDiagnosticCode, RiveImportDiagnosticContext } from './types.js';

export class RiveImportError extends Error {
  readonly domain = 'animation-import' as const;
  readonly recoverable: boolean;
  readonly recovery: 'retry' | 'release-resource' | 'terminate-runtime';

  constructor(
    readonly code: RiveImportDiagnosticCode,
    message: string,
    readonly path: string,
    readonly context: RiveImportDiagnosticContext,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'RiveImportError';
    this.recoverable = code === 'E_RIVE_ABORTED' || code === 'E_RIVE_ASSET_MISSING';
    this.recovery = code === 'E_RIVE_ABORTED' || code === 'E_RIVE_ASSET_MISSING'
      ? 'retry'
      : code === 'E_RIVE_INTERNAL'
        ? 'terminate-runtime'
        : 'release-resource';
  }

  toJSON(): Readonly<Record<string, unknown>> {
    return Object.freeze({
      domain: this.domain,
      code: this.code,
      message: this.message,
      recoverable: this.recoverable,
      recovery: this.recovery,
      path: this.path,
      context: this.context,
    });
  }
}
