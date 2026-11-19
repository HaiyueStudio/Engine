import { I18n } from '../../i18n/I18n';
import { NarrativeRuntime } from '../../narrative/NarrativeRuntime';
import { deepFreeze } from '../../narrative/validation';
import type { NarrativeSnapshot, NarrativeVariables, NarrativeView } from '../../narrative/types';
import type { AuthoredStory, StoryCueGroups, StorySlot, StoryWait } from './types';

type Slot = StorySlot & { readonly stateId?: string; readonly transitionId?: string };
type Barrier = { readonly group: number } & (
  { readonly kind: 'resource'; readonly assetId: string; readonly slotId: string } |
  { readonly kind: 'transition'; readonly slotId: string; readonly seconds: number } |
  StoryWait
);

export class StoryPreviewError extends Error {
  constructor(readonly step: number | null, message: string) { super(message); }
}

function describeStage(groups: StoryCueGroups, committed: ReadonlyMap<string, Slot>, step: number) {
  const slots = new Map(committed);
  const barriers: Barrier[] = [];
  groups.forEach((cues, group) => {
    for (const cue of cues) {
      if (cue.op === 'show') for (const slot of cue.slots) {
        slots.set(slot.id, slot);
        barriers.push({ group, kind: 'resource', assetId: slot.assetId, slotId: slot.id });
      }
      if (cue.op === 'hide') slots.delete(cue.slotId);
      if (cue.op === 'state' || cue.op === 'transition') {
        const slot = slots.get(cue.slotId);
        if (!slot) throw new StoryPreviewError(step, `Stage "${cue.op}" needs visible slot "${cue.slotId}".`);
        if (cue.op === 'state') slots.set(cue.slotId, { ...slot, stateId: cue.stateId });
        else {
          slots.set(cue.slotId, { ...slot, transitionId: cue.transitionId });
          barriers.push({ group, kind: 'transition', slotId: cue.slotId, seconds: cue.seconds });
        }
      }
    }
    for (const cue of cues) if (cue.op === 'wait') {
      if (cue.wait.kind === 'event' && !slots.has(cue.wait.slotId)) {
        throw new StoryPreviewError(step, `Event "${cue.wait.event}" needs visible slot "${cue.wait.slotId}".`);
      }
      barriers.push({ group, ...cue.wait });
    }
  });
  return { slots, barriers };
}

type Waiting =
  | { readonly kind: 'choice' }
  | { readonly kind: 'action'; readonly name: string; readonly payload: NarrativeVariables }
  | { readonly kind: 'stage'; readonly activeGroup: number | null; readonly barriers: readonly Barrier[] }
  | null;

export interface StoryPreviewTarget { readonly lineId?: string; readonly nodeId?: string }

/** A fresh NarrativeRuntime and simulated stage on every invocation. No host action runs here. */
export function previewStory(story: AuthoredStory, routeId: string, target: StoryPreviewTarget = {}) {
  const route = Object.hasOwn(story.routes, routeId) ? story.routes[routeId] : undefined;
  if (!route) throw new StoryPreviewError(null, `Unknown route "${routeId}".`);
  if (target.lineId !== undefined && !Object.hasOwn(story.lines, target.lineId)) {
    throw new StoryPreviewError(null, `Unknown line "${target.lineId}".`);
  }
  const targetNode = target.lineId === undefined ? target.nodeId : story.lines[target.lineId]!.nodeId;
  const { definition } = story;
  const lineByNode = new Map(Object.entries(story.lines).map(([lineId, line]) => [line.nodeId, { lineId, ...line }]));
  const runtime = new NarrativeRuntime(definition.narrative);
  const locale = new I18n({ locale: route.locale, fallbackLocale: story.defaultLocale });
  let slots = new Map<string, Slot>();
  const visited: string[] = [];
  let stepIndex = 0;
  let waiting: Waiting = null;

  const inspect = (view: NarrativeView, snapshot: NarrativeSnapshot) => {
    const line = lineByNode.get(view.nodeId);
    const params = Object.fromEntries(Object.entries(view.variables).map(([key, value]) => [key, typeof value === 'boolean' ? String(value) : value]));
    const caption = (key: string) => locale.text(key, params);
    const available = new Map(view.choices.map(choice => [choice.id, choice]));
    const choices = view.node.type === 'choice' ? view.node.options.map(option => ({
      id: option.id, text: caption(option.textKey),
      visible: available.has(option.id), enabled: available.get(option.id)?.enabled ?? false,
      conditions: { visibleWhen: option.visibleWhen ?? null, enabledWhen: option.enabledWhen ?? null },
    })) : [];
    return deepFreeze({
      routeId, locale: route.locale, nodeId: view.nodeId, visited, lineId: line?.lineId ?? null,
      text: line ? caption(line.textKey) : null,
      speaker: 'speakerKey' in view.node && view.node.speakerKey ? caption(view.node.speakerKey) : null,
      voiceAssetId: line?.voices[route.locale] ?? null,
      variables: view.variables, choices, slots: [...slots.values()].sort((a, b) => a.order - b.order),
      waiting, ending: view.ending, snapshot,
    });
  };

  try {
    for (const pack of Object.values(story.locales)) locale.register(pack);
    runtime.start(`preview:${routeId}`, route.initial);
    for (let count = 0; count < 10_000; count++) {
      const view = runtime.view!;
      visited.push(view.nodeId);
      const next = route.steps[stepIndex];
      const stage = definition.cues[view.nodeId];
      const planned = stage && describeStage(stage, slots, stepIndex);
      waiting = view.action ? (planned
        ? { kind: 'stage', activeGroup: planned.barriers[0]?.group ?? null, barriers: planned.barriers }
        : { kind: 'action', name: view.action.name, payload: { ...view.action.payload } })
        : view.node.type === 'choice' ? { kind: 'choice' } : null;
      if (targetNode === view.nodeId) return inspect(view, runtime.save());
      if (view.node.type === 'dialogue') {
        runtime.advance(view.revision);
        continue;
      }
      if (next && next.nodeId !== view.nodeId) {
        throw new StoryPreviewError(stepIndex, `Expected "${next.nodeId}", reached "${view.nodeId}".`);
      }
      if (!next) {
        if (targetNode !== undefined) throw new StoryPreviewError(null, `Route "${routeId}" stops at "${view.nodeId}" before "${targetNode}".`);
        return inspect(view, runtime.save());
      }
      if ('choiceId' in next && runtime.choose(next.choiceId, view.revision)) {
        stepIndex++;
        continue;
      }
      if (view.action && 'result' in next && runtime.completeAction(view.action.id, next.result)) {
        stepIndex++;
        continue;
      }
      if (view.action && 'stage' in next && planned && runtime.completeAction(view.action.id)) {
        slots = planned.slots;
        stepIndex++;
        continue;
      }
      throw new StoryPreviewError(stepIndex, `Route cannot take the configured step at "${view.nodeId}".`);
    }
    throw new StoryPreviewError(stepIndex, 'Preview exceeded 10,000 presentation steps.');
  } catch (error) {
    if (error instanceof StoryPreviewError) throw error;
    if (error instanceof Error) throw new StoryPreviewError(stepIndex, error.message);
    throw error;
  } finally {
    locale.dispose();
    runtime.dispose();
  }
}

export type StoryPreview = ReturnType<typeof previewStory>;
