import { canonicalLocale, validateLocalePack } from '../../i18n/packs';
import type { LocalePack } from '../../i18n/types';
import type { NarrativeNode, NarrativeVariables } from '../../narrative/types';
import { deepFreeze, validateNarrativeDefinition, variables } from '../../narrative/validation';
import { at, fields, items, label, read, reject, stableId, StoryDataError } from './data';
import { closedAutomaticNodes, nodeId, reachableFrom, readNode, STAGE_ACTION } from './narrative-data';
import { readAssets, readCues, readPresets } from './stage-data';
import type {
  AuthoredStory, StoryCompilation, StoryCueGroups, StoryDiagnostic, StoryInputs, StoryLine, StoryReplay,
  StoryRoute, StoryRouteStep, StorySource,
} from './types';

export const projectFields = [
  'schemaVersion', 'id', 'version', 'start', 'variables', 'chapters', 'defaultLocale',
  'locales', 'assets', 'presets', 'actions', 'routes', 'replays',
] as const;

export function compileStory(inputs: StoryInputs): StoryCompilation {
  const diagnostics: StoryDiagnostic[] = [];
  const warning = (source: StorySource, code: string, message: string) => {
    diagnostics.push({ ...source, severity: 'warning', code, message });
  };
  const attempt = <T>(operation: () => T): T | undefined => {
    try { return operation(); }
    catch (error) {
      if (!(error instanceof StoryDataError)) throw error;
      diagnostics.push({ ...error.source, severity: 'error', code: error.code, message: error.message });
      return undefined;
    }
  };
  const story = attempt((): AuthoredStory | null => {
    const project = { file: inputs.project.file, path: [] };
    const manifest = fields(inputs.project.data, project, projectFields);
    if (manifest.schemaVersion !== 1) reject(at(project, 'schemaVersion'), 'invalid-schema', 'Expected story schemaVersion 1.');
    const id = stableId(manifest.id, at(project, 'id'));
    const version = label(manifest.version, at(project, 'version'));
    const vars = read(at(project, 'variables'), () => variables(manifest.variables, 'variables'));
    const assets = readAssets(manifest.assets, at(project, 'assets'));
    const presets = readPresets(manifest.presets, at(project, 'presets'), assets);
    const slotIds = new Set(Object.values(presets).flatMap(slots => slots.map(slot => slot.id)));
    const actions = new Set<string>();
    items(manifest.actions === undefined ? [] : manifest.actions, at(project, 'actions')).forEach((entry, index) => {
      const site = at(project, 'actions', index);
      const name = stableId(entry, site);
      if (actions.has(name) || name === STAGE_ACTION) reject(site, 'invalid-action', `Duplicated or reserved action "${name}".`);
      actions.add(name);
    });

    const locales: Record<string, LocalePack> = Object.create(null);
    for (const [key, document] of Object.entries(inputs.locales)) attempt(() => {
      const source = { file: document.file, path: [] };
      const pack = read(source, () => validateLocalePack(document.data));
      if (pack.locale !== key) reject(at(source, 'locale'), 'locale-mismatch', `Expected locale "${key}", found "${pack.locale}".`);
      locales[key] = pack;
    });
    const defaultLocale = read(at(project, 'defaultLocale'), () => canonicalLocale(label(manifest.defaultLocale, at(project, 'defaultLocale'))));
    if (!Object.hasOwn(locales, defaultLocale) && !diagnostics.some(entry => entry.severity === 'error')) {
      reject(at(project, 'defaultLocale'), 'unknown-locale', `Default locale "${defaultLocale}" must be declared.`);
    }

    const chapters = new Set<string>();
    const authored = new Map<string, { chapter: string; raw: unknown; source: StorySource }>();
    for (const document of inputs.chapters) attempt(() => {
      const site = { file: document.file, path: [] };
      const chapter = fields(document.data, site, ['id', 'nodes']);
      const chapterId = stableId(chapter.id, at(site, 'id'));
      if (chapters.has(chapterId)) reject(at(site, 'id'), 'duplicate-chapter', `Duplicate chapter "${chapterId}".`);
      chapters.add(chapterId);
      const chapterNodes = Object.entries(fields(chapter.nodes, at(site, 'nodes')));
      if (!chapterNodes.length) reject(at(site, 'nodes'), 'empty-chapter', 'A chapter must declare nodes.');
      for (const [rawId, raw] of chapterNodes) attempt(() => {
        const source = at(site, 'nodes', rawId);
        authored.set(`${chapterId}/${stableId(rawId, source)}`, { chapter: chapterId, raw, source });
      });
    });

    const startSource = at(project, 'start');
    const start = attempt(() => {
      const target = nodeId(manifest.start, '', startSource);
      if (!authored.has(target)) reject(startSource, 'unknown-target', `Unknown start node "${target}".`);
      return target;
    });
    const nodes: Record<string, NarrativeNode> = Object.create(null);
    const lines: Record<string, StoryLine> = Object.create(null);
    const cues: Record<string, StoryCueGroups> = Object.create(null);
    const keys = new Map<string, StorySource>();
    const lineIds = new Set<string>();
    const ids = new Set(authored.keys());
    for (const [qualified, { chapter, raw, source }] of authored) attempt(() => {
      const { narrative, author } = readNode(qualified, chapter, raw, source, ids, actions, vars);
      nodes[qualified] = narrative;
      const register = (key: string, site: StorySource) => { if (!keys.has(key)) keys.set(key, site); };
      if ('textKey' in narrative && narrative.textKey !== undefined) {
        const lineId = stableId(author.lineId, at(source, 'lineId'));
        if (lineIds.has(lineId)) reject(at(source, 'lineId'), 'duplicate-line', `Duplicate line "${lineId}".`);
        lineIds.add(lineId);
        register(narrative.textKey, at(source, 'textKey'));
        const voiceIds: Record<string, string> = Object.create(null);
        if (author.voices !== undefined) {
          const voiceSource = at(source, 'voices');
          const voiceEntries = fields(author.voices, voiceSource);
          for (const [locale, value] of Object.entries(voiceEntries)) {
            const site = at(voiceSource, locale);
            if (!Object.hasOwn(locales, locale)) reject(site, 'unknown-locale', `Unknown voice locale "${locale}".`);
            const assetId = stableId(value, site);
            if (!Object.hasOwn(assets, assetId) || assets[assetId]?.kind !== 'audio') {
              reject(site, 'invalid-voice-asset', `Voice asset "${assetId}" must reference declared audio.`);
            }
            voiceIds[locale] = assetId;
          }
          for (const locale of Object.keys(locales)) {
            if (!Object.hasOwn(voiceIds, locale)) warning(voiceSource, 'missing-voice', `Line "${lineId}" has no "${locale}" voice.`);
          }
        }
        lines[lineId] = { nodeId: qualified, textKey: narrative.textKey, voices: voiceIds };
      } else if (author.lineId !== undefined || author.voices !== undefined) {
        reject(at(source, 'textKey'), 'missing-text-key', 'A line ID or voice requires a text key.');
      }
      if ('speakerKey' in narrative && narrative.speakerKey) register(narrative.speakerKey, at(source, 'speakerKey'));
      if ('artwork' in narrative && narrative.artwork) {
        const { assetKey, textKey } = narrative.artwork;
        const site = at(source, 'artwork');
        if (!Object.hasOwn(assets, assetKey) || assets[assetKey]?.kind !== 'image') {
          reject(at(site, 'assetKey'), 'invalid-artwork', `Artwork "${assetKey}" must reference a declared image.`);
        }
        register(textKey, at(site, 'textKey'));
      }
      if (narrative.type === 'choice') narrative.options.forEach((option, index) => register(option.textKey, at(source, 'options', index, 'textKey')));
      if (author.type === 'stage') cues[qualified] = readCues(author.cues, at(source, 'cues'), presets, slotIds);
    });

    if (!start || diagnostics.some(entry => entry.severity === 'error')) return null;
    const narrative = read(project, () => validateNarrativeDefinition({ schemaVersion: 1, id, version, start, variables: vars, nodes }));
    for (const [key, source] of keys) for (const [locale, pack] of Object.entries(locales)) {
      if (!Object.hasOwn(pack.messages, key) || pack.messages[key] === '') {
        warning(source, 'missing-translation', `Text key "${key}" is missing or empty in "${locale}" (${inputs.locales[locale]!.file}).`);
      }
    }
    const reachable = reachableFrom(start, narrative.nodes);
    for (const id of closedAutomaticNodes(narrative.nodes)) attempt(() => {
      reject(authored.get(id)!.source, 'closed-automatic-cycle', `Automatic node "${id}" cannot reach a dialogue, choice, action or ending.`);
    });
    const endingIds = new Set([...reachable].flatMap(id => {
      const node = narrative.nodes[id]!;
      return node.type === 'end' ? [node.ending] : [];
    }));
    for (const [id, node] of Object.entries(narrative.nodes)) {
      if (node.type === 'end' && !endingIds.has(node.ending)) {
        warning(at(authored.get(id)!.source, 'ending'), 'unreachable-ending', `Ending "${node.ending}" cannot be reached from "${start}".`);
      }
    }

    const replays: Record<string, StoryReplay> = Object.create(null);
    if (manifest.replays !== undefined) for (const [key, entry] of Object.entries(fields(manifest.replays, at(project, 'replays')))) attempt(() => {
      const site = at(project, 'replays', key);
      stableId(key, site);
      const data = fields(entry, site, ['startLineId', 'endLineId']);
      const startLineId = stableId(data.startLineId, at(site, 'startLineId'));
      const endLineId = stableId(data.endLineId, at(site, 'endLineId'));
      if (!Object.hasOwn(lines, startLineId)) reject(at(site, 'startLineId'), 'unknown-line', `Unknown line "${startLineId}".`);
      if (!Object.hasOwn(lines, endLineId)) reject(at(site, 'endLineId'), 'unknown-line', `Unknown line "${endLineId}".`);
      if (!reachableFrom(lines[startLineId]!.nodeId, nodes).has(lines[endLineId]!.nodeId)) {
        reject(at(site, 'endLineId'), 'unreachable-replay-end', `Line "${endLineId}" cannot be reached from "${startLineId}".`);
      }
      replays[key] = { startLineId, endLineId };
    });

    const routes: Record<string, StoryRoute> = Object.create(null);
    for (const [key, entry] of Object.entries(fields(manifest.routes, at(project, 'routes')))) attempt(() => {
      const site = at(project, 'routes', key);
      stableId(key, site);
      const route = fields(entry, site, ['locale', 'initial', 'steps']);
      const localeSite = at(site, 'locale');
      const locale = route.locale === undefined ? defaultLocale : read(localeSite, () => canonicalLocale(label(route.locale, localeSite)));
      if (!Object.hasOwn(locales, locale)) reject(localeSite, 'unknown-locale', `Unknown route locale "${locale}".`);
      const readPatch = (rawPatch: unknown, patchSite: StorySource): NarrativeVariables => {
        const values = read(patchSite, () => variables(rawPatch, 'variables'));
        for (const [key, value] of Object.entries(values)) {
          if (!Object.hasOwn(vars, key) || typeof value !== typeof vars[key]) reject(at(patchSite, key), 'invalid-route-variable', `Unknown variable or type mismatch: "${key}".`);
        }
        return values;
      };
      const initial = readPatch(route.initial === undefined ? {} : route.initial, at(site, 'initial'));
      const steps = items(route.steps, at(site, 'steps')).map((step, i): StoryRouteStep => {
        const stepSite = at(site, 'steps', i);
        const data = fields(step, stepSite);
        const target = nodeId(data.nodeId, '', at(stepSite, 'nodeId'));
        const node = narrative.nodes[target];
        if (node?.type === 'choice') {
          fields(data, stepSite, ['nodeId', 'choiceId']);
          const choiceId = stableId(data.choiceId, at(stepSite, 'choiceId'));
          if (!node.options.some(option => option.id === choiceId)) reject(at(stepSite, 'choiceId'), 'unknown-route-choice', `Unknown choice "${choiceId}" at "${target}".`);
          return { nodeId: target, choiceId };
        }
        if (node?.type === 'action') {
          if (node.name !== STAGE_ACTION) {
            fields(data, stepSite, ['nodeId', 'result']);
            return { nodeId: target, result: readPatch(data.result, at(stepSite, 'result')) };
          }
          fields(data, stepSite, ['nodeId', 'stage']);
          if (data.stage !== true) reject(at(stepSite, 'stage'), 'invalid-route-stage', 'Set stage to true to acknowledge an isolated stage cue.');
          return { nodeId: target, stage: true };
        }
        reject(at(stepSite, 'nodeId'), 'invalid-route-node', `Expected a declared choice or action node, received "${target}".`);
      });
      return routes[key] = { locale, initial, steps };
    });
    return {
      definition: { schemaVersion: 1, narrative, assets, presets, cues, ...(manifest.replays === undefined ? {} : { replays }) },
      lines, locales, routes, defaultLocale,
    };
  });
  return deepFreeze({ story: diagnostics.some(entry => entry.severity === 'error') ? null : story ?? null, diagnostics });
}
