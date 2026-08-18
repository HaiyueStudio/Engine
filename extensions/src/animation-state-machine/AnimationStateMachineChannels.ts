import {
  HYA_STATE_MACHINE_CHANNEL_REGISTRY,
  hyaStateMachineChannelCapability,
  type HyaStateMachineChannelCapability,
  type HyaStateMachineChannelId,
  type HyaStateMachineDefinition,
  type HyaStateMachineMotion,
} from '@haiyue/animation-spec';

export {
  HYA_STATE_MACHINE_CHANNEL_REGISTRY,
  hyaStateMachineChannelCapability,
};
export type {
  HyaStateMachineChannelCapability,
  HyaStateMachineChannelId,
};

export type AnimationStateMachineChannelDiagnosticCode =
  | NonNullable<HyaStateMachineChannelCapability['diagnosticCode']>
  | 'W_STATE_MACHINE_CHANNEL_AUDIO_AUTOPLAY_REJECTED';

export interface AnimationStateMachineChannelDiagnostic {
  readonly code: AnimationStateMachineChannelDiagnosticCode;
  readonly severity: 'warning' | 'error';
  readonly channelId: HyaStateMachineChannelId;
  readonly path: string;
  readonly message: string;
}

export class AnimationStateMachineChannelError extends Error {
  readonly name = 'AnimationStateMachineChannelError';

  constructor(readonly diagnostic: AnimationStateMachineChannelDiagnostic) {
    super(`${diagnostic.message} (${diagnostic.path})`);
  }
}

/**
 * Audio owns one HTMLMediaElement playhead and is intentionally not amplitude
 * mixed. It is executable only when the graph can never overlap two motions.
 */
export function audioStateMachineCompatibilityDiagnostic(
  definition: HyaStateMachineDefinition,
  path = '$.stateMachine',
): AnimationStateMachineChannelDiagnostic | null {
  const capability = hyaStateMachineChannelCapability('audio');
  if (definition.layers.length !== 1) {
    return audioRangeDiagnostic(`${path}.layers`, 'Audio requires exactly one state-machine layer.');
  }
  const layer = definition.layers[0]!;
  if ((layer.weight ?? 1) !== 1 || (layer.blendMode ?? 'override') !== 'override') {
    return audioRangeDiagnostic(
      `${path}.layers[0]`,
      'Audio requires one full-weight override layer because media amplitude is not pose-mixable.',
    );
  }
  for (let stateIndex = 0; stateIndex < layer.states.length; stateIndex++) {
    if (motionContainsBlendTree(layer.states[stateIndex]!.motion)) {
      return audioRangeDiagnostic(
        `${path}.layers[0].states[${stateIndex}].motion`,
        'Audio cannot run inside a Blend Tree because two media playheads would overlap.',
      );
    }
  }
  for (let transitionIndex = 0; transitionIndex < layer.transitions.length; transitionIndex++) {
    if (layer.transitions[transitionIndex]!.duration > 0) {
      return audioRangeDiagnostic(
        `${path}.layers[0].transitions[${transitionIndex}].duration`,
        'Audio transitions must be immediate; non-zero cross-fades are an unmixable media range.',
      );
    }
  }
  if (capability.transition !== 'immediate-only') {
    throw new Error('The canonical audio channel contract is internally inconsistent.');
  }
  return null;
}

export function assertAudioStateMachineCompatible(
  definition: HyaStateMachineDefinition,
  path?: string,
): void {
  const diagnostic = audioStateMachineCompatibilityDiagnostic(definition, path);
  if (diagnostic) throw new AnimationStateMachineChannelError(diagnostic);
}

export function audioAutoplayRejectedDiagnostic(
  path: string,
  reason?: unknown,
): AnimationStateMachineChannelDiagnostic {
  const suffix = reason instanceof Error && reason.message
    ? ` Browser reason: ${reason.message}`
    : '';
  return Object.freeze({
    code: 'W_STATE_MACHINE_CHANNEL_AUDIO_AUTOPLAY_REJECTED',
    severity: 'warning',
    channelId: 'audio',
    path,
    message: `Audio play() was rejected; the playhead remains paused until a later user-authorized resume.${suffix}`,
  });
}

function audioRangeDiagnostic(path: string, message: string): AnimationStateMachineChannelDiagnostic {
  return Object.freeze({
    code: 'E_STATE_MACHINE_CHANNEL_AUDIO_UNMIXABLE_RANGE',
    severity: 'error',
    channelId: 'audio',
    path,
    message,
  });
}

function motionContainsBlendTree(motion: HyaStateMachineMotion): boolean {
  return motion.kind !== 'clip';
}
