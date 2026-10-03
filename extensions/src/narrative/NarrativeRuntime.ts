import type { NarrativeDefinition, NarrativeEffect, NarrativeEvent, NarrativeSnapshot, NarrativeVariables, NarrativeView } from './types';
import { array, deepFreeze, matches, object, text, validateNarrativeDefinition, variables } from './validation';

type State = { runId: string; nodeId: string; variables: Record<string, string | number | boolean>; choices: { nodeId: string; optionId: string }[]; actionSequence: number; pendingAction: { sequence: number } | null };
/** Deterministic graph execution, with transactional transitions and explicit external-action boundaries. */
export class NarrativeRuntime {
  readonly definition: NarrativeDefinition;
  private state: State | null = null;
  private revision = 0;
  private busy = false;
  private dead = false;
  private readonly listeners = new Set<(event: NarrativeEvent) => void>();
  private readonly maxSteps: number;
  constructor(definition: NarrativeDefinition, options: { maxAutomaticSteps?: number } = {}) {
    this.definition = validateNarrativeDefinition(definition);
    this.maxSteps = options.maxAutomaticSteps ?? 256;
    if (!Number.isSafeInteger(this.maxSteps) || this.maxSteps < 1 || this.maxSteps > 10000) throw new RangeError('maxAutomaticSteps must be 1..10000');
  }
  get disposed(): boolean { return this.dead; }
  get view(): NarrativeView | null {
    if (!this.state) return null;
    const s = this.state, node = this.definition.nodes[s.nodeId]!;
    return deepFreeze({ revision: this.revision, nodeId: s.nodeId, node, variables: { ...s.variables },
      choices: node.type === 'choice' ? node.options.filter(o => !o.visibleWhen || matches(o.visibleWhen, s.variables)).map(o => ({ ...o, enabled: !o.enabledWhen || matches(o.enabledWhen, s.variables) })) : [],
      action: node.type === 'action' ? { id: this.revision, token: `narrative:${JSON.stringify([this.definition.id, this.definition.version, s.runId, s.actionSequence, s.nodeId])}`, name: node.name, payload: node.payload ?? {} } : null,
      ending: node.type === 'end' ? node.ending : null });
  }
  /** Supply a fresh runId for a new playthrough. Restore uses the saved runId instead. */
  start(runId: string, initial: NarrativeVariables = {}): void {
    this.assertMutable(); text(runId, 'runId');
    if (runId === this.state?.runId) throw new Error('Use a fresh runId for a new playthrough');
    const next: State = { runId, nodeId: this.definition.start, variables: variables(this.definition.variables, 'variables'), choices: [], actionSequence: 0, pendingAction: null };
    this.patch(next, initial); this.settle(next); this.commit(next);
  }
  advance(expectedRevision = this.revision): boolean {
    this.assertMutable();
    const view = this.view;
    if (!view || expectedRevision !== this.revision || view.node.type !== 'dialogue') return false;
    const next = this.copy(); next.nodeId = view.node.next; this.settle(next); this.commit(next); return true;
  }
  choose(optionId: string, expectedRevision = this.revision): boolean {
    this.assertMutable();
    const view = this.view;
    if (!view || expectedRevision !== this.revision || view.node.type !== 'choice') return false;
    const option = view.choices.find(o => o.id === optionId && o.enabled);
    if (!option) return false;
    const next = this.copy(); this.apply(next, option.effects ?? []);
    next.choices.push({ nodeId: next.nodeId, optionId }); next.nodeId = option.next;
    this.settle(next); this.commit(next); return true;
  }
  /** A stale/duplicate acknowledgement does nothing. Unknown or mistyped variables reject atomically. */
  completeAction(requestId: number, result: NarrativeVariables = {}): boolean {
    this.assertMutable(); const view = this.view;
    if (!view?.action || view.action.id !== requestId || view.node.type !== 'action') return false;
    const next = this.copy(); this.patch(next, result); next.pendingAction = null; next.nodeId = view.node.next;
    this.settle(next); this.commit(next); return true;
  }
  save(): NarrativeSnapshot {
    this.assertAlive();
    const s = this.copy();
    return deepFreeze({ schemaVersion: 1, storyId: this.definition.id, storyVersion: this.definition.version, ...s });
  }
  /** Strict version check; migrations belong to the game's save layer. Does not replay prior effect nodes. */
  restore(raw: unknown): void {
    this.assertMutable(); const data = object(raw, 'save');
    if (data.schemaVersion !== 1 || data.storyId !== this.definition.id || data.storyVersion !== this.definition.version) throw new TypeError('Incompatible narrative save version/story');
    const nodeId = text(data.nodeId, 'nodeId'), node = this.definition.nodes[nodeId];
    if (!node || node.type === 'branch' || node.type === 'effect') throw new TypeError('Save must point to a resumable node');
    const values = variables(data.variables, 'variables');
    if (Object.keys(values).length !== Object.keys(this.definition.variables).length) throw new TypeError('Incomplete saved variables');
    const sequence = data.actionSequence;
    if (typeof sequence !== 'number' || !Number.isSafeInteger(sequence) || sequence < 0) throw new TypeError('Invalid actionSequence');
    const pending = data.pendingAction;
    if (node.type === 'action') {
      if (sequence < 1 || object(pending, 'pendingAction').sequence !== sequence) throw new TypeError('Invalid pending action');
    } else if (pending !== null) throw new TypeError('Unexpected pending action');
    const choices = array(data.choices, 'choices').map(rawChoice => {
      const c = object(rawChoice, 'choice'), id = text(c.nodeId, 'choice.nodeId'), optionId = text(c.optionId, 'choice.optionId');
      const n = this.definition.nodes[id];
      if (n?.type !== 'choice' || !n.options.some(o => o.id === optionId)) throw new TypeError('Invalid saved choice');
      return { nodeId: id, optionId };
    });
    const next: State = { runId: text(data.runId, 'runId'), nodeId, variables: variables(this.definition.variables, 'variables'), choices, actionSequence: sequence, pendingAction: node.type === 'action' ? { sequence } : null };
    this.patch(next, values); this.commit(next);
  }
  subscribe(listener: (event: NarrativeEvent) => void): () => void {
    this.assertAlive(); this.listeners.add(listener); return () => { this.listeners.delete(listener); };
  }
  dispose(): void {
    if (this.dead) return;
    this.assertMutable(); this.dead = true;
    try { this.emit([{ type: 'dispose' }]); }
    finally { this.listeners.clear(); this.state = null; }
  }
  private copy(): State {
    if (!this.state) throw new Error('Narrative has not started');
    return { ...this.state, variables: variables(this.state.variables, 'variables'), choices: this.state.choices.map(c => ({ ...c })), pendingAction: this.state.pendingAction ? { ...this.state.pendingAction } : null };
  }
  private patch(state: State, patch: NarrativeVariables): void {
    for (const [key, value] of Object.entries(variables(patch, 'result'))) {
      if (!Object.hasOwn(this.definition.variables, key) || typeof this.definition.variables[key] !== typeof value) throw new TypeError(`Unknown variable or type mismatch: ${key}`);
      state.variables[key] = value;
    }
  }
  private apply(state: State, effects: readonly NarrativeEffect[]): void {
    for (const e of effects) {
      const value = e.op === 'set' ? e.value : (state.variables[e.variable] as number) + e.value;
      this.patch(state, { [e.variable]: value });
    }
  }
  private settle(state: State): void {
    for (let step = 0; step < this.maxSteps; step++) {
      const node = this.definition.nodes[state.nodeId]!;
      if (node.type === 'branch') state.nodeId = matches(node.condition, state.variables) ? node.then : node.otherwise;
      else if (node.type === 'effect') { this.apply(state, node.effects); state.nodeId = node.next; }
      else {
        if (node.type === 'action') {
          if (state.actionSequence >= Number.MAX_SAFE_INTEGER) throw new RangeError('Action sequence exhausted');
          state.pendingAction = { sequence: ++state.actionSequence };
        }
        return;
      }
    }
    throw new Error('Automatic narrative step limit exceeded; possible cycle');
  }
  private commit(state: State): void {
    this.state = state; this.revision++;
    const view = this.view!;
    const events: NarrativeEvent[] = [{ type: 'change', view }];
    if (view.action) events.push({ type: 'action', request: view.action });
    if (view.ending) events.push({ type: 'end', ending: view.ending, runId: state.runId });
    this.emit(events);
  }
  private emit(events: NarrativeEvent[]): void {
    this.busy = true; const errors: unknown[] = [];
    try {
      for (const event of events) for (const listener of [...this.listeners]) {
        try { listener(event); } catch (error) { errors.push(error); }
      }
    } finally { this.busy = false; }
    if (errors.length) throw new AggregateError(errors, 'Narrative subscriber errors (state is committed)');
  }
  private assertMutable(): void { this.assertAlive(); if (this.busy) throw new Error('Schedule narrative mutations after event delivery'); }
  private assertAlive(): void { if (this.dead) throw new Error('Narrative runtime disposed'); }
}
