import { GameSaveError, GameSaveErrorCode } from '@haiyue/engine/save';
import { NarrativeRuntime } from '../../narrative/NarrativeRuntime.js';
import type { NarrativeSnapshot, NarrativeVariables } from '../../narrative/types';
import type { I18nParams } from '../../i18n/types';
import type { StageSlot } from '../stage/types';
import type { AuthoredStory } from '../story/types';

export interface SavedReadingLine {
  readonly lineId: string;
  readonly params: I18nParams;
}
export interface VisualNovelSnapshot {
  readonly schemaVersion: 1;
  readonly narrative: NarrativeSnapshot;
  readonly slots: readonly StageSlot[];
  readonly history?: readonly SavedReadingLine[];
}
export interface SavedMusic {
  readonly assetId: string;
  readonly playing: boolean;
  readonly position?: number;
}
export interface SavedPosition {
  readonly snapshot: VisualNovelSnapshot;
  readonly music?: SavedMusic;
}
export interface ReplayCapture {
  readonly start: SavedPosition;
  readonly results: Readonly<Record<string, NarrativeVariables>>;
  readonly choices?: NarrativeSnapshot['choices'];
}

export const valueRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const id = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '';
const scalar = (value: unknown) => typeof value === 'string' || typeof value === 'boolean' || finite(value);
function readBounds(value: unknown): StageSlot['bounds'] | undefined {
  if (!Array.isArray(value) || value.length !== 4) return undefined;
  const [x, y, width, height] = value;
  if (finite(x) && finite(y) && finite(width) && finite(height) && width > 0 && height > 0) return [x, y, width, height];
}
export const stable = (runtime: NarrativeRuntime) => {
  const kind = runtime.view?.node.type;
  return kind === 'dialogue' || kind === 'choice';
};
export const invalidSave = (message: string, cause?: unknown) =>
  new GameSaveError(GameSaveErrorCode.InvalidData, message, { operation: 'validate', cause });

/** Only resolved, identity-checked values from the current story reach the stage/resource host. */
export function readPosition(story: AuthoredStory, candidate: unknown): SavedPosition {
  if (!valueRecord(candidate) || !valueRecord(candidate.snapshot)) throw invalidSave('Missing visual novel save snapshot.');
  const { snapshot, music } = candidate;
  if (snapshot.schemaVersion !== 1 || !Array.isArray(snapshot.slots) || !valueRecord(snapshot.narrative)) {
    throw invalidSave('Unsupported visual novel snapshot version or shape.');
  }
  const runtime = new NarrativeRuntime(story.definition.narrative);
  let narrative: NarrativeSnapshot;
  try {
    runtime.restore(snapshot.narrative);
    if (!stable(runtime)) throw invalidSave('Save must be at a dialogue or choice.');
    const saved = runtime.save();
    narrative = { ...saved, variables: { ...saved.variables } };
  } catch (cause) {
    if (cause instanceof GameSaveError) throw cause;
    throw invalidSave('Save does not match the current story.', cause);
  } finally { runtime.dispose(); }

  const ids = new Set<string>();
  const authored = [
    ...Object.values(story.definition.presets).flat(),
    ...Object.values(story.definition.cues).flat(2).flatMap(cue => cue.op === 'show' ? cue.slots : []),
  ];
  const slots = snapshot.slots.map((slot: unknown): StageSlot => {
    const bounds = valueRecord(slot) && readBounds(slot.bounds);
    if (!valueRecord(slot) || !id(slot.id) || ids.has(slot.id) || !id(slot.assetId) ||
      !Object.hasOwn(story.definition.assets, slot.assetId) || story.definition.assets[slot.assetId]!.kind !== 'hya' ||
      !authored.some(entry => entry.id === slot.id && entry.assetId === slot.assetId && entry.variantId === slot.variantId) ||
      !bounds || !Number.isSafeInteger(slot.order) ||
      !finite(slot.time) || slot.time < 0 ||
      (slot.variantId !== undefined && !id(slot.variantId)) || (slot.stateId !== undefined && !id(slot.stateId)) ||
      (slot.fit !== undefined && !['contain', 'cover', 'stretch'].includes(String(slot.fit))) ||
      (slot.data !== undefined && (!valueRecord(slot.data) || !Object.values(slot.data).every(scalar)))) {
      throw invalidSave('Invalid saved HYA slot, timing or asset identity.');
    }
    ids.add(slot.id);
    const { id: slotId, assetId, order, time, variantId, stateId, fit, data } = slot;
    return { id: slotId, assetId, bounds, order: order as number, time,
      ...(variantId === undefined ? {} : { variantId }), ...(stateId === undefined ? {} : { stateId }),
      ...(fit === undefined ? {} : { fit: fit as StageSlot['fit'] & string }),
      ...(data === undefined ? {} : { data: { ...data } as NarrativeVariables }) };
  });
  let history: SavedReadingLine[] | undefined;
  if (snapshot.history !== undefined) {
    if (!Array.isArray(snapshot.history) || snapshot.history.length > 2_000) throw invalidSave('Invalid reading history size.');
    history = snapshot.history.map((entry: unknown): SavedReadingLine => {
      if (!valueRecord(entry) || !id(entry.lineId) || !Object.hasOwn(story.lines, entry.lineId) ||
        !valueRecord(entry.params) || !Object.values(entry.params).every(value => typeof value === 'string' || finite(value))) {
        throw invalidSave('Invalid saved reading history entry.');
      }
      return { lineId: entry.lineId, params: { ...entry.params } as I18nParams };
    });
  }
  let soundtrack: SavedMusic | undefined;
  if (music !== undefined) {
    if (!valueRecord(music) || !id(music.assetId) || !Object.hasOwn(story.definition.assets, music.assetId) ||
      story.definition.assets[music.assetId]!.kind !== 'audio' || typeof music.playing !== 'boolean' ||
      (music.position !== undefined && (!finite(music.position) || music.position < 0))) {
      throw invalidSave('Invalid saved music identity or position.');
    }
    soundtrack = { assetId: music.assetId, playing: music.playing, ...(music.position === undefined ? {} : { position: music.position }) };
  }
  return { snapshot: { schemaVersion: 1, narrative, slots, ...(history ? { history } : {}) }, ...(soundtrack ? { music: soundtrack } : {}) };
}

export function readReplay(story: AuthoredStory, replayId: string, value: unknown): ReplayCapture {
  if (!valueRecord(value) || !valueRecord(value.results) || !Object.hasOwn(story.definition.replays ?? {}, replayId)) {
    throw invalidSave('Unknown or malformed replay.');
  }
  const definition = story.definition.replays![replayId]!;
  const start = readPosition(story, value.start);
  if (story.lines[definition.startLineId]?.nodeId !== start.snapshot.narrative.nodeId ||
    Object.values(value.results).some(result => !valueRecord(result) || !Object.values(result).every(scalar))) {
    throw invalidSave('Invalid replay start or action result.');
  }
  let choices: NarrativeSnapshot['choices'] | undefined;
  if (value.choices !== undefined) {
    if (!Array.isArray(value.choices)) throw invalidSave('Malformed replay choice path.');
    choices = value.choices.map((choice: unknown) => {
      if (!valueRecord(choice) || !id(choice.nodeId) || !id(choice.optionId)) throw invalidSave('Malformed replay choice.');
      const node = story.definition.narrative.nodes[choice.nodeId];
      if (node?.type !== 'choice' || !node.options.some(option => option.id === choice.optionId)) {
        throw invalidSave('Replay refers to an unknown choice.');
      }
      return { nodeId: choice.nodeId, optionId: choice.optionId };
    });
  }
  return { start, results: structuredClone(value.results) as ReplayCapture['results'], ...(choices ? { choices } : {}) };
}
