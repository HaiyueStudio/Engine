import type { ShaderDiagnostic, ShaderDiagnosticCode } from './contracts';

export class ShaderComposerError extends Error {
  readonly diagnostic: ShaderDiagnostic;

  constructor(diagnostic: ShaderDiagnostic, options?: ErrorOptions) {
    super(`[${diagnostic.code}] ${diagnostic.message}`, options);
    this.name = 'ShaderComposerError';
    this.diagnostic = Object.freeze({ ...diagnostic });
  }
}

export function shaderError(
  code: ShaderDiagnosticCode,
  message: string,
  options: {
    moduleId?: string;
    path?: string;
    details?: Readonly<Record<string, unknown>>;
    cause?: unknown;
  } = {},
): never {
  const diagnostic: ShaderDiagnostic = {
    code,
    message,
    ...(options.moduleId === undefined ? {} : { moduleId: options.moduleId }),
    ...(options.path === undefined ? {} : { path: options.path }),
    ...(options.details === undefined ? {} : { details: options.details }),
  };
  throw new ShaderComposerError(diagnostic, options.cause === undefined ? undefined : { cause: options.cause });
}
