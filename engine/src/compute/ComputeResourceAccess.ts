import { EngineError, EngineErrorCode } from '../core/EngineError';
import type { RenderCommandContext } from '../core/RenderCommandContext';

export type ComputeResourceUse =
  | 'storage-read'
  | 'storage-write'
  | 'storage-read-write'
  | 'indirect'
  | 'render-read'
  | 'copy-read'
  | 'copy-write';

export interface ComputeResourceAccess {
  readonly resource: object;
  readonly use: ComputeResourceUse;
  readonly path: string;
}

export interface ComputeResourcePassDescriptor {
  readonly label: string;
  readonly path: string;
  readonly accesses: readonly ComputeResourceAccess[];
  readonly after?: readonly ComputeResourcePassToken[] | undefined;
}

export interface ComputeResourcePassToken {
  readonly label: string;
  readonly sequence: number;
}

interface RecordedAccess {
  readonly token: ComputeResourcePassToken;
  readonly use: ComputeResourceUse;
}

interface EncoderResourceState {
  sequence: number;
  readonly accesses: WeakMap<object, RecordedAccess>;
  readonly tokens: Set<ComputeResourcePassToken>;
}

const encoderStates = new WeakMap<object, EncoderResourceState>();

/**
 * Validates and records a logical compute/resource operation before commands are encoded.
 * WebGPU command order remains the synchronization mechanism; this contract makes the
 * caller's dependency responsibility explicit and produces stable diagnostic paths.
 */
export function recordComputeResourcePass(
  context: RenderCommandContext,
  descriptor: ComputeResourcePassDescriptor,
): ComputeResourcePassToken {
  if (context.passEncoder) {
    invalidOrder(
      `${descriptor.label} cannot run during a render pass.`,
      `${descriptor.path}.passEncoder`,
      { label: descriptor.label, conflict: 'active-render-pass' },
    );
  }
  const encoder = context.encoder as object;
  let state = encoderStates.get(encoder);
  if (!state) {
    state = { sequence: 0, accesses: new WeakMap(), tokens: new Set() };
    encoderStates.set(encoder, state);
  }
  const dependencies = new Set(descriptor.after ?? []);
  for (const token of dependencies) {
    if (!state.tokens.has(token)) {
      invalidOrder(
        `${descriptor.label} dependency is not owned by this encoder.`,
        `${descriptor.path}.after`,
        { label: descriptor.label, dependency: token.label, dependencySequence: token.sequence },
      );
    }
  }

  const currentUses = new Map<object, ComputeResourceAccess>();
  descriptor.accesses.forEach((access, index) => {
    if (!access.resource || typeof access.resource !== 'object') {
      invalidOrder(
        `${descriptor.label} resource must be an object.`,
        `${descriptor.path}.accesses[${index}].resource`,
        { label: descriptor.label, use: access.use },
      );
    }
    const samePass = currentUses.get(access.resource);
    if (samePass && !isCompatibleSamePassUse(samePass.use, access.use)) {
      invalidOrder(
        `${descriptor.label} has incompatible uses ${samePass.use} and ${access.use}.`,
        access.path,
        { label: descriptor.label, firstUse: samePass.use, secondUse: access.use },
      );
    }
    currentUses.set(access.resource, access);

    const previous = state!.accesses.get(access.resource);
    if (previous && conflicts(previous.use, access.use) && !dependencies.has(previous.token)) {
      invalidOrder(
        `${descriptor.label} requires ${previous.token.label} before ${access.use}.`,
        access.path,
        {
          label: descriptor.label,
          use: access.use,
          previousLabel: previous.token.label,
          previousUse: previous.use,
          requiredDependencySequence: previous.token.sequence,
        },
      );
    }
  });

  const token = Object.freeze({ label: descriptor.label, sequence: ++state.sequence });
  state.tokens.add(token);
  for (const access of descriptor.accesses) {
    state.accesses.set(access.resource, { token, use: access.use });
  }
  return token;
}

function isCompatibleSamePassUse(first: ComputeResourceUse, second: ComputeResourceUse): boolean {
  return first === second;
}

function conflicts(first: ComputeResourceUse, second: ComputeResourceUse): boolean {
  return isWrite(first) || isWrite(second);
}

function isWrite(use: ComputeResourceUse): boolean {
  return use === 'storage-write' || use === 'storage-read-write' || use === 'copy-write';
}

function invalidOrder(message: string, path: string, context: Record<string, unknown>): never {
  throw new EngineError(EngineErrorCode.ComputeInvalidParameter, message, {
    path,
    context,
    hint: 'End render passes, split incompatible uses, and declare producer tokens in after.',
    docsPath: 'errors/E_COMPUTE_INVALID_PARAMETER',
  });
}
