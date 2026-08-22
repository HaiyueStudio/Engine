import type { HyaChannelFamily, HyaChannelPolicy, TimelineValueKind } from './types.js';

export interface HyaChannelFamilyContract {
  readonly family: HyaChannelFamily; readonly valueKinds: readonly TimelineValueKind[];
  readonly policies: readonly HyaChannelPolicy[]; readonly transition: 'blend' | 'select' | 'transfer-owner' | 'exactly-once';
  readonly rewind: 'resample' | 'restore-owner' | 'reset-and-replay';
}

export const HYA_CHANNEL_FAMILY_CONTRACTS: Readonly<Record<HyaChannelFamily, HyaChannelFamilyContract>> = deepFreeze({
  transform: family('transform', ['number', 'vector'], ['override', 'additive'], 'blend', 'resample'),
  'paint-path': family('paint-path', ['number', 'vector', 'color', 'id'], ['override', 'additive', 'discrete'], 'blend', 'resample'),
  rig: family('rig', ['number', 'vector', 'boolean'], ['override', 'additive', 'discrete'], 'blend', 'resample'),
  'text-layout': family('text-layout', ['number', 'vector', 'color', 'boolean', 'string', 'id', 'integer', 'unsigned'], ['override', 'additive', 'discrete'], 'select', 'resample'),
  'resource-data': family('resource-data', ['number', 'vector', 'color', 'boolean', 'string', 'id', 'integer', 'unsigned'], ['override', 'additive', 'discrete', 'ownership'], 'transfer-owner', 'restore-owner'),
  'visibility-order': family('visibility-order', ['boolean', 'integer', 'unsigned', 'id'], ['discrete'], 'select', 'resample'),
  'event-audio-script': family('event-audio-script', ['callback'], ['ownership'], 'exactly-once', 'reset-and-replay'),
});

export function isChannelPolicyExecutable(familyName: HyaChannelFamily, valueKind: TimelineValueKind, policy: HyaChannelPolicy): boolean {
  const contract = HYA_CHANNEL_FAMILY_CONTRACTS[familyName];
  return contract.valueKinds.includes(valueKind) && contract.policies.includes(policy);
}

function family(familyName: HyaChannelFamily, valueKinds: readonly TimelineValueKind[], policies: readonly HyaChannelPolicy[], transition: HyaChannelFamilyContract['transition'], rewind: HyaChannelFamilyContract['rewind']): HyaChannelFamilyContract {
  return { family: familyName, valueKinds, policies, transition, rewind };
}
function deepFreeze<T>(value: T): T { if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.freeze(value); for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child); } return value; }
