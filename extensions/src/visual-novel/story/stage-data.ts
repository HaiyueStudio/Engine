import { variables } from '../../narrative/validation';
import { at, fields, finite, items, label, read, reject, relativeFile, stableId } from './data';
import type { StoryAsset, StoryCue, StoryCueGroups, StorySlot, StorySource, StoryWait } from './types';

export function readAssets(raw: unknown, source: StorySource): Record<string, StoryAsset> {
  return Object.fromEntries(Object.entries(fields(raw, source)).map(([id, value]) => {
    const site = at(source, id);
    stableId(id, site);
    const { kind, path } = fields(value, site, ['kind', 'path']);
    if (kind !== 'hya' && kind !== 'image' && kind !== 'audio') {
      reject(at(site, 'kind'), 'invalid-asset', 'Asset kind must be hya, image or audio.');
    }
    return [id, { kind, path: relativeFile(path, at(site, 'path')) }];
  }));
}

export function readPresets(raw: unknown, source: StorySource, assets: Readonly<Record<string, StoryAsset>>): Record<string, StorySlot[]> {
  return Object.fromEntries(Object.entries(fields(raw, source)).map(([id, value]) => {
    const site = at(source, id);
    stableId(id, site);
    const ids = new Set<string>();
    const slots = items(value, site).map((item, index): StorySlot => {
      const slot = at(site, index);
      const n = fields(item, slot, ['id', 'assetId', 'bounds', 'order', 'variantId', 'fit', 'time', 'data']);
      const slotId = stableId(n.id, at(slot, 'id'));
      if (ids.has(slotId)) reject(at(slot, 'id'), 'duplicate-slot', `Duplicate slot "${slotId}" in preset "${id}".`);
      ids.add(slotId);
      const assetId = stableId(n.assetId, at(slot, 'assetId'));
      if (!Object.hasOwn(assets, assetId) || assets[assetId]?.kind !== 'hya') {
        reject(at(slot, 'assetId'), 'invalid-asset-reference', `Expected a declared HYA asset, received "${assetId}".`);
      }
      const position = at(slot, 'bounds');
      const bounds = items(n.bounds, position);
      if (bounds.length !== 4) reject(position, 'invalid-bounds', 'Expected [x, y, width, height].');
      const [x, y, width, height] = bounds.map((entry, i) => finite(entry, at(position, i))) as [number, number, number, number];
      if (width <= 0 || height <= 0) reject(position, 'invalid-bounds', 'Width and height must be positive.');
      const order = finite(n.order, at(slot, 'order'));
      if (!Number.isSafeInteger(order)) reject(at(slot, 'order'), 'invalid-order', 'Layer order must be an integer.');
      const fit = n.fit;
      if (fit !== undefined && fit !== 'contain' && fit !== 'cover' && fit !== 'stretch') {
        reject(at(slot, 'fit'), 'invalid-fit', 'Fit must be contain, cover or stretch.');
      }
      return {
        id: slotId, assetId, bounds: [x, y, width, height], order,
        ...(fit === undefined ? {} : { fit }),
        ...(n.variantId === undefined ? {} : { variantId: stableId(n.variantId, at(slot, 'variantId')) }),
        ...(n.time === undefined ? {} : { time: finite(n.time, at(slot, 'time'), 0) }),
        ...(n.data === undefined ? {} : { data: read(at(slot, 'data'), () => variables(n.data, 'data')) }),
      };
    });
    if (!slots.length) reject(site, 'empty-preset', 'A preset must have at least one slot.');
    return [id, slots.sort((a, b) => a.order - b.order)];
  }));
}

export function readCues(raw: unknown, source: StorySource, presets: Readonly<Record<string, readonly StorySlot[]>>, slotIds: ReadonlySet<string>): StoryCueGroups {
  const readSlot = (rawId: unknown, site: StorySource): string => {
    const id = stableId(rawId, site);
    if (!slotIds.has(id)) reject(site, 'unknown-slot', `Unknown slot "${id}".`);
    return id;
  };
  const groups = items(raw, source).map((group, i) => {
    const groupSite = at(source, i);
    const cues = items(group, groupSite).map((rawCue, j): StoryCue => {
      const site = at(groupSite, j);
      const cue = fields(rawCue, site);
      switch (cue.op) {
        case 'show': {
          fields(cue, site, ['op', 'presetId', 'slotId']);
          const presetId = stableId(cue.presetId, at(site, 'presetId'));
          if (!Object.hasOwn(presets, presetId)) reject(at(site, 'presetId'), 'unknown-preset', `Unknown preset "${presetId}".`);
          const preset = presets[presetId]!;
          const slots = cue.slotId === undefined ? preset : preset.filter(slot => slot.id === readSlot(cue.slotId, at(site, 'slotId')));
          if (!slots.length) reject(at(site, 'slotId'), 'unknown-preset-slot', `Slot is absent from preset "${presetId}".`);
          return { op: 'show', presetId, slots };
        }
        case 'hide':
          fields(cue, site, ['op', 'slotId']);
          return { op: 'hide', slotId: readSlot(cue.slotId, at(site, 'slotId')) };
        case 'state':
          fields(cue, site, ['op', 'slotId', 'stateId']);
          return { op: 'state', slotId: readSlot(cue.slotId, at(site, 'slotId')), stateId: stableId(cue.stateId, at(site, 'stateId')) };
        case 'transition':
          fields(cue, site, ['op', 'slotId', 'transitionId', 'seconds', 'decorative']);
          if (cue.decorative !== undefined && typeof cue.decorative !== 'boolean') reject(at(site, 'decorative'), 'invalid-decorative', 'Expected a boolean.');
          return {
            op: 'transition', slotId: readSlot(cue.slotId, at(site, 'slotId')),
            transitionId: stableId(cue.transitionId, at(site, 'transitionId')),
            seconds: finite(cue.seconds, at(site, 'seconds'), 0), decorative: cue.decorative === true,
          };
        case 'wait': {
          let wait: StoryWait;
          if (cue.kind === 'duration') {
            fields(cue, site, ['op', 'kind', 'seconds']);
            wait = { kind: 'duration', seconds: finite(cue.seconds, at(site, 'seconds'), 0) };
          } else if (cue.kind === 'event') {
            fields(cue, site, ['op', 'kind', 'slotId', 'event']);
            wait = { kind: 'event', slotId: readSlot(cue.slotId, at(site, 'slotId')), event: label(cue.event, at(site, 'event')) };
          } else reject(at(site, 'kind'), 'invalid-wait-kind', 'Wait kind must be duration or event.');
          return { op: 'wait', wait };
        }
        default:
          reject(at(site, 'op'), 'invalid-operation', 'Expected show, hide, state, transition or wait.');
      }
    });
    if (!cues.length) reject(groupSite, 'empty-cue-group', 'A parallel cue group cannot be empty.');
    const changes = new Set<string>();
    cues.forEach((cue, j) => {
      const affected = cue.op === 'show' ? cue.slots.map(slot => slot.id) : cue.op === 'wait' ? [] : [cue.slotId];
      for (const id of affected) {
        if (changes.has(id)) reject(at(groupSite, j), 'conflicting-cues', `Parallel group modifies "${id}" twice. Use successive groups.`);
        changes.add(id);
      }
    });
    return cues;
  });
  if (!groups.length) reject(source, 'empty-cue', 'A stage node requires at least one cue group.');
  return groups;
}
