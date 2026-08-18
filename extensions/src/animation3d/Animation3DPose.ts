import type {
  Animation3DBinding,
  Animation3DBindingResolver,
  Animation3DResolvedBinding,
} from './Animation3DBinding.js';
import type { Animation3DEvent } from './Animation3DClip.js';
import { Animation3DError } from './Animation3DError.js';

export interface Animation3DPoseChannel<
  TBinding extends Animation3DBinding = Animation3DBinding,
> {
  readonly binding: TBinding;
  /** Exactly binding.valueSize sampled and blended values. */
  readonly value: Readonly<Float32Array>;
}

export interface Animation3DPoseEvent {
  readonly actionId: string;
  readonly clipId: string;
  readonly event: Animation3DEvent;
}

/**
 * Frame-transient mixer output. Implementations may reuse its arrays on the
 * next evaluate/update call; callers must copy values they need to retain.
 */
export interface Animation3DPose {
  readonly sequence: number;
  readonly mixerTime: number;
  readonly channels: readonly Animation3DPoseChannel[];
  readonly events: readonly Animation3DPoseEvent[];
}

/**
 * Caller-provided scratch target used to keep mixer evaluation allocation-free.
 * reset() begins a new pose and seal() returns the current read-only view.
 */
export interface Animation3DMutablePose {
  reset(mixerTime: number): void;
  write(
    binding: Animation3DBinding,
    value: ArrayLike<number>,
  ): void;
  emit(event: Animation3DPoseEvent): void;
  seal(): Animation3DPose;
}

interface Animation3DPoseApplierState {
  readonly resolver: Animation3DBindingResolver;
  resolverRevision: number;
  readonly resolvedBindings: Map<
    string,
    Animation3DResolvedBinding | null
  >;
}

const POSE_APPLIER_STATES = new WeakMap<
  Animation3DPoseApplier,
  Animation3DPoseApplierState
>();

/**
 * Applies pose channels through a revision-aware binding resolver cache.
 * Resolver misses fail explicitly and never write to a fallback target.
 */
export class Animation3DPoseApplier {
  constructor(resolver: Animation3DBindingResolver) {
    POSE_APPLIER_STATES.set(this, {
      resolver,
      resolverRevision: Number.NaN,
      resolvedBindings: new Map(),
    });
  }

  apply(pose: Animation3DPose): void {
    const state = POSE_APPLIER_STATES.get(this)!;
    const { resolver } = state;
    if (state.resolverRevision !== resolver.revision) {
      state.resolverRevision = resolver.revision;
      state.resolvedBindings.clear();
    }
    for (let index = 0; index < pose.channels.length; index++) {
      const channel = pose.channels[index]!;
      const bindingId = channel.binding.id;
      let resolved = state.resolvedBindings.get(bindingId);
      if (resolved === undefined && !state.resolvedBindings.has(bindingId)) {
        resolved = resolver.resolve(channel.binding);
        state.resolvedBindings.set(bindingId, resolved);
      }
      if (!resolved) {
        throw new Animation3DError(
          'resolver-miss',
          `Animation3D binding resolver could not resolve "${bindingId}".`,
          { resolver: 'binding', bindingId },
        );
      }
      resolved.write(channel.value);
    }
  }
}
