import type {
  ChannelOwnershipPort, RuntimeChannel, RuntimeValue, SideEffectPort, StateMachinePose, TimelineContribution,
  TimelineEffectOccurrence, TimelineSample,
} from './runtime-types.js';

interface LedgerEntry { readonly effect: TimelineEffectOccurrence }

export class ChannelMixerV2 {
  private readonly _contributions: TimelineContribution[] = [];
  private readonly _effects: TimelineEffectOccurrence[] = [];
  private readonly _ledger = new Map<string, LedgerEntry>();
  private readonly _owners = new Map<string, Readonly<{ channel: RuntimeChannel; value: RuntimeValue }>>();
  private _transaction = 0;
  private _activeTransaction: number | null = null;
  private _sequence = 0;
  private _disposed = false;

  constructor(private readonly _sideEffects?: SideEffectPort, private readonly _ownership?: ChannelOwnershipPort) {}

  begin(): number {
    this._requireActive(); if (this._activeTransaction !== null) throw mixerError('E_STATE_MACHINE_MIXER_TRANSACTION', 'A mixer transaction is already active.');
    const id = ++this._transaction; this._activeTransaction = id; this._contributions.length = 0; this._effects.length = 0;
    try { this._sideEffects?.begin(id); this._ownership?.begin(id); return id; }
    catch (error) { try { this._sideEffects?.rollback(id); this._ownership?.rollback(id); } finally { this._finish(); } throw error; }
  }

  submit(sample: TimelineSample): void {
    this._requireTransaction(); this._contributions.push(...sample.contributions); this._effects.push(...sample.effects);
  }

  submitContribution(contribution: TimelineContribution): void { this._requireTransaction(); this._contributions.push(contribution); }
  submitEffect(effect: TimelineEffectOccurrence): void { this._requireTransaction(); this._effects.push(effect); }

  commit(settled = false): StateMachinePose {
    const transaction = this._requireTransaction();
    try {
      const channels = mixChannels(this._contributions), mixedIds = new Set(channels.map(entry => entry.channel.id));
      for (const owner of this._owners.values()) if (!mixedIds.has(owner.channel.id)) channels.push(Object.freeze({ channel: owner.channel, value: cloneValue(owner.channel.defaultValue ?? null) }));
      channels.sort((left, right) => left.channel.id.localeCompare(right.channel.id));
      const transfers = channels.filter(entry => entry.channel.policy === 'ownership').map(entry => ({ channel: entry.channel, previous: this._owners.get(entry.channel.id)?.value ?? entry.channel.defaultValue ?? null, next: entry.value })).filter(change => !valuesEqual(change.previous, change.next));
      if (transfers.length > 0 && !this._ownership) throw mixerError('E_STATE_MACHINE_OWNERSHIP_PORT_REQUIRED', 'Ownership channel changed without a transactional ownership port.');
      for (const transfer of transfers) this._ownership?.transfer(transfer);
      const effects = stableUniqueEffects(this._effects).filter(effect => !this._ledger.has(effect.id));
      if (effects.length > 0 && !this._sideEffects) throw mixerError('E_STATE_MACHINE_SIDE_EFFECT_PORT_REQUIRED', 'Side-effect occurrence has no transactional delivery port.');
      for (const effect of effects) this._sideEffects?.invoke(effect);
      this._ownership?.commit(transaction); this._sideEffects?.commit(transaction);
      for (const entry of channels) if (entry.channel.policy === 'ownership') this._owners.set(entry.channel.id, Object.freeze({ channel: entry.channel, value: cloneValue(entry.value) }));
      for (const effect of effects) this._ledger.set(effect.id, { effect });
      const pose = Object.freeze({ sequence: ++this._sequence, channels: Object.freeze(channels), effects: Object.freeze(effects), settled });
      this._finish(); return pose;
    } catch (error) {
      this._sideEffects?.rollback(transaction); this._ownership?.rollback(transaction); this._finish(); throw error;
    }
  }

  rollback(): void {
    if (this._activeTransaction === null) return; const transaction = this._activeTransaction;
    try { this._sideEffects?.rollback(transaction); this._ownership?.rollback(transaction); } finally { this._finish(); }
  }

  /** Re-arms occurrences after the deterministic rewind point. */
  rewind(rawTime: number): void {
    this._requireActive(); if (!Number.isFinite(rawTime)) throw mixerError('E_STATE_MACHINE_RUNTIME_TIME', 'Rewind time must be finite.');
    for (const [id, entry] of this._ledger) if (entry.effect.occurrenceTime > rawTime) this._ledger.delete(id);
  }

  pause(): void { this._requireActive(); this._sideEffects?.pause(); }
  resume(): void { this._requireActive(); this._sideEffects?.resume(); }
  stop(): void { this._requireActive(); this._sideEffects?.stop(); }
  reset(): void { this._requireActive(); this.rollback(); this._ledger.clear(); this._owners.clear(); this._sideEffects?.reset(); this._ownership?.reset(); this._sequence = 0; }
  dispose(): void { if (this._disposed) return; this.rollback(); this._sideEffects?.dispose(); this._ownership?.dispose(); this._disposed = true; this._ledger.clear(); this._owners.clear(); this._contributions.length = 0; this._effects.length = 0; }
  get deliveredEffectCount(): number { return this._ledger.size; }

  private _finish(): void { this._activeTransaction = null; this._contributions.length = 0; this._effects.length = 0; }
  private _requireTransaction(): number { this._requireActive(); if (this._activeTransaction === null) throw mixerError('E_STATE_MACHINE_MIXER_TRANSACTION', 'No mixer transaction is active.'); return this._activeTransaction; }
  private _requireActive(): void { if (this._disposed) throw mixerError('E_STATE_MACHINE_RUNTIME_DISPOSED', 'Channel mixer was disposed.'); }
}

function mixChannels(contributions: readonly TimelineContribution[]): Readonly<{ channel: RuntimeChannel; value: RuntimeValue }>[] {
  const grouped = new Map<string, TimelineContribution[]>();
  for (const contribution of contributions) { if (!(contribution.weight > 0)) continue; const list = grouped.get(contribution.channel.id) ?? []; list.push(contribution); grouped.set(contribution.channel.id, list); }
  const result: { channel: RuntimeChannel; value: RuntimeValue }[] = [];
  for (const list of grouped.values()) {
    list.sort(compareContribution); const channel = list[0]!.channel;
    if (channel.policy === 'discrete' || channel.policy === 'ownership') {
      const winner = [...list].sort(compareWinner).at(-1)!; result.push(Object.freeze({ channel, value: cloneValue(winner.value) })); continue;
    }
    let value: RuntimeValue = cloneValue(channel.defaultValue ?? zeroLike(list[0]!.value));
    const layers = new Map<number, TimelineContribution[]>(); for (const contribution of list) { const entries = layers.get(contribution.layerOrder) ?? []; entries.push(contribution); layers.set(contribution.layerOrder, entries); }
    for (const entries of layers.values()) {
      const overrides = entries.filter(entry => channel.policy !== 'additive' && entry.blendMode !== 'additive'), additives = entries.filter(entry => channel.policy === 'additive' || entry.blendMode === 'additive');
      if (overrides.length > 0) { const total = overrides.reduce((sum, entry) => sum + entry.weight, 0), layerValue = weightedLayerValue(overrides, total, channel); value = overrideWeighted(value, layerValue, Math.min(1, total), channel); }
      for (const contribution of additives) value = addWeighted(value, contribution.value, contribution.weight, channel);
    }
    result.push(Object.freeze({ channel, value }));
  }
  result.sort((left, right) => left.channel.id.localeCompare(right.channel.id)); return result;
}

function stableUniqueEffects(effects: readonly TimelineEffectOccurrence[]): TimelineEffectOccurrence[] {
  const seen = new Set<string>(), result: TimelineEffectOccurrence[] = [];
  for (const effect of [...effects].sort((left, right) => left.occurrenceTime - right.occurrenceTime || left.id.localeCompare(right.id))) if (!seen.has(effect.id)) { seen.add(effect.id); result.push(effect); }
  return result;
}

function compareContribution(left: TimelineContribution, right: TimelineContribution): number { return left.layerOrder - right.layerOrder || left.actionOrder - right.actionOrder; }
function compareWinner(left: TimelineContribution, right: TimelineContribution): number { return left.layerOrder - right.layerOrder || left.weight - right.weight || left.actionOrder - right.actionOrder; }
function weightedLayerValue(entries: readonly TimelineContribution[], total: number, channel: RuntimeChannel): RuntimeValue { const first = entries[0]!.value; if (typeof first === 'number' && entries.every(entry => typeof entry.value === 'number')) { if (channel.numericMode === 'angle-radians') { const reference = first; return wrapAngle(reference + entries.reduce((sum, entry) => sum + wrapAngle((entry.value as number) - reference) * entry.weight, 0) / total); } return entries.reduce((sum, entry) => sum + (entry.value as number) * entry.weight, 0) / total; } if (Array.isArray(first) && entries.every(entry => Array.isArray(entry.value) && entry.value.length === first.length)) return first.map((_, index) => entries.reduce((sum, entry) => sum + (entry.value as readonly number[])[index]! * entry.weight, 0) / total); return cloneValue([...entries].sort(compareWinner).at(-1)!.value); }
function overrideWeighted(base: RuntimeValue, incoming: RuntimeValue, weight: number, channel: RuntimeChannel): RuntimeValue { const alpha = clamp(weight, 0, 1); if (typeof base === 'number' && typeof incoming === 'number') return channel.numericMode === 'angle-radians' ? wrapAngle(base + wrapAngle(incoming - base) * alpha) : base + (incoming - base) * alpha; if (Array.isArray(base) && Array.isArray(incoming) && base.length === incoming.length) return base.map((value, index) => value + (incoming[index]! - value) * alpha); return alpha >= 0.5 ? cloneValue(incoming) : cloneValue(base); }
function addWeighted(base: RuntimeValue, incoming: RuntimeValue, weight: number, channel: RuntimeChannel): RuntimeValue { if (typeof base === 'number' && typeof incoming === 'number') { const result = base + incoming * weight; return channel.numericMode === 'angle-radians' ? wrapAngle(result) : result; } if (Array.isArray(base) && Array.isArray(incoming) && base.length === incoming.length) return base.map((value, index) => value + incoming[index]! * weight); throw mixerError('E_STATE_MACHINE_MIXER_POLICY', 'Additive policy requires matching numeric values.'); }
function zeroLike(value: RuntimeValue): RuntimeValue { if (typeof value === 'number') return 0; if (Array.isArray(value)) return value.map(() => 0); return value; }
function cloneValue(value: RuntimeValue): RuntimeValue { if (Array.isArray(value)) return [...value]; if (value && typeof value === 'object') return structuredClone(value); return value; }
function valuesEqual(left: RuntimeValue, right: RuntimeValue): boolean { if (Array.isArray(left) && Array.isArray(right)) return left.length === right.length && left.every((value, index) => Object.is(value, right[index])); if (left && right && typeof left === 'object' && typeof right === 'object') return JSON.stringify(left) === JSON.stringify(right); return Object.is(left, right); }
function clamp(value: number, minimum: number, maximum: number): number { return Math.min(maximum, Math.max(minimum, value)); }
function wrapAngle(value: number): number { const period = Math.PI * 2; let result = (value + Math.PI) % period; if (result < 0) result += period; return result - Math.PI; }
function mixerError(code: string, message: string): Error & { code: string } { return Object.assign(new Error(message), { code }); }
