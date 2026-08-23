import { audioEventFail } from './diagnostics.js';
import { resolveAudioEventLimits, type AudioEventLimits } from './limits.js';
import {
  HYA_AUDIO_EVENT_EXTENSION_ID,
  HYA_AUDIO_EVENT_FORMAT,
  HYA_AUDIO_EVENT_VERSION,
  type AudioEventParseOptions,
  type HyaAudioBus,
  type HyaAudioCodec,
  type HyaAudioCue,
  type HyaAudioEventDocument,
  type HyaAudioResource,
  type HyaAudioTimelineEvent,
} from './types.js';

type UnknownRecord = Record<string, unknown>;

interface ParseTotals {
  embeddedBytes: number;
  decodedFrames: number;
  decodedBytes: number;
  textBytes: number;
}

const CODEC_MEDIA_TYPES: Readonly<Record<HyaAudioCodec, readonly string[]>> = Object.freeze({
  'pcm-f32': Object.freeze(['audio/vnd.haiyue.pcm-f32']),
  wav: Object.freeze(['audio/wav', 'audio/wave', 'audio/x-wav']),
  mp3: Object.freeze(['audio/mpeg']),
  aac: Object.freeze(['audio/aac', 'audio/mp4']),
  opus: Object.freeze(['audio/ogg', 'audio/webm']),
  vorbis: Object.freeze(['audio/ogg', 'audio/webm']),
  flac: Object.freeze(['audio/flac', 'audio/x-flac']),
});

export function parseHyaAudioEvents(
  value: unknown,
  options: AudioEventParseOptions = {},
): HyaAudioEventDocument {
  const hostLimits = resolveAudioEventLimits(options.limits);
  assertAcyclic(value, '$', hostLimits.maxReferenceDepth);
  const root = object(value, '$');
  exactKeys(root, [
    'format',
    'version',
    'extension',
    'playbackProfile',
    'clock',
    'browser',
    'limits',
    'voiceStealing',
    'resources',
    'buses',
    'cues',
    'timelineEvents',
  ], '$');

  literal(root.format, HYA_AUDIO_EVENT_FORMAT, '$.format', 'E_AUDIO_EVENT_FORMAT');
  literal(root.version, HYA_AUDIO_EVENT_VERSION, '$.version', 'E_AUDIO_EVENT_VERSION');
  literal(root.extension, HYA_AUDIO_EVENT_EXTENSION_ID, '$.extension', 'E_AUDIO_EVENT_FORMAT');
  enumeration(root.playbackProfile, ['sample-accurate', 'html-media-restricted'], '$.playbackProfile');
  enumeration(root.voiceStealing, ['reject', 'steal-oldest', 'steal-lowest-priority'], '$.voiceStealing');

  const totals: ParseTotals = {
    embeddedBytes: 0,
    decodedFrames: 0,
    decodedBytes: 0,
    textBytes: 0,
  };
  const documentLimits = parseRuntimeLimits(root.limits, hostLimits);
  parseClock(root.clock, hostLimits);
  parseBrowser(root.browser);

  const resources = array(root.resources, '$.resources');
  const buses = array(root.buses, '$.buses');
  const cues = array(root.cues, '$.cues');
  const timelineEvents = array(root.timelineEvents, '$.timelineEvents');
  enforceLimit(resources.length, hostLimits.maxResources, '$.resources');
  enforceLimit(buses.length, hostLimits.maxBuses, '$.buses');
  enforceLimit(cues.length, hostLimits.maxCues, '$.cues');
  enforceLimit(timelineEvents.length, hostLimits.maxTimelineEvents, '$.timelineEvents');

  const resourceIds = uniqueIds(resources, '$.resources', totals, hostLimits);
  const busIds = uniqueIds(buses, '$.buses', totals, hostLimits);
  const cueIds = uniqueIds(cues, '$.cues', totals, hostLimits);
  uniqueIds(timelineEvents, '$.timelineEvents', totals, hostLimits);

  const parsedResources = resources.map((entry, index) => parseResource(
    entry,
    `$.resources[${index}]`,
    totals,
    hostLimits,
  ));
  const resourcesById = new Map(parsedResources.map(resource => [resource.id, resource]));
  const parsedBuses = buses.map((entry, index) => parseBus(
    entry,
    `$.buses[${index}]`,
    busIds,
    totals,
    hostLimits,
  ));
  validateBusGraph(parsedBuses, hostLimits.maxReferenceDepth);
  const parsedCues = cues.map((entry, index) => parseCue(
    entry,
    `$.cues[${index}]`,
    resourceIds,
    busIds,
    resourcesById,
    totals,
    hostLimits,
  ));
  timelineEvents.forEach((entry, index) => parseTimelineEvent(
    entry,
    `$.timelineEvents[${index}]`,
    cueIds,
    totals,
    hostLimits,
  ));

  enforceLimit(totals.embeddedBytes, hostLimits.maxTotalEmbeddedBytes, '$.resources');
  enforceLimit(totals.decodedFrames, documentLimits.maxDecodedFrames, '$.resources');
  enforceLimit(totals.decodedBytes, documentLimits.maxDecodedBytes, '$.resources');
  enforceLimit(totals.textBytes, hostLimits.maxTotalTextBytes, '$');

  if (root.playbackProfile === 'html-media-restricted') {
    if (documentLimits.maxVoices !== 1 || documentLimits.maxVoicesPerResource !== 1) {
      audioEventFail(
        'E_AUDIO_EVENT_FORMAT',
        '$.limits',
        'restricted media profile requires single-voice limits',
      );
    }
    if (parsedCues.some(cue => cue.overlap !== 'ignore')) {
      audioEventFail(
        'E_AUDIO_EVENT_FORMAT',
        '$.cues',
        'restricted media profile requires ignore overlap policy',
      );
    }
  }

  return deepFreeze(structuredClone(root) as unknown as HyaAudioEventDocument);
}

function parseRuntimeLimits(
  value: unknown,
  host: Readonly<AudioEventLimits>,
): HyaAudioEventDocument['limits'] {
  const path = '$.limits';
  const limits = object(value, path);
  exactKeys(limits, [
    'maxVoices',
    'maxVoicesPerResource',
    'maxDecodeJobs',
    'maxEventTokens',
    'maxDecodedFrames',
    'maxDecodedBytes',
  ], path);
  const result = {
    maxVoices: boundedInteger(limits.maxVoices, 1, host.maxVoices, `${path}.maxVoices`),
    maxVoicesPerResource: boundedInteger(
      limits.maxVoicesPerResource,
      1,
      host.maxVoicesPerResource,
      `${path}.maxVoicesPerResource`,
    ),
    maxDecodeJobs: boundedInteger(limits.maxDecodeJobs, 1, host.maxDecodeJobs, `${path}.maxDecodeJobs`),
    maxEventTokens: boundedInteger(limits.maxEventTokens, 1, host.maxEventTokens, `${path}.maxEventTokens`),
    maxDecodedFrames: boundedInteger(
      limits.maxDecodedFrames,
      1,
      host.maxDecodedFrames,
      `${path}.maxDecodedFrames`,
    ),
    maxDecodedBytes: boundedInteger(
      limits.maxDecodedBytes,
      1,
      host.maxDecodedBytes,
      `${path}.maxDecodedBytes`,
    ),
  };
  if (result.maxVoicesPerResource > result.maxVoices) {
    audioEventFail(
      'E_AUDIO_EVENT_LIMIT',
      `${path}.maxVoicesPerResource`,
      'per-resource voice limit cannot exceed the total voice limit',
    );
  }
  return result;
}

function parseClock(value: unknown, host: Readonly<AudioEventLimits>): void {
  const path = '$.clock';
  const clock = object(value, path);
  exactKeys(clock, [
    'sampleRate',
    'lookAheadFrames',
    'driftToleranceFrames',
    'driftPolicy',
    'lateDecodePolicy',
    'visibilityPolicy',
    'suspendedPolicy',
  ], path);
  boundedInteger(clock.sampleRate, 8_000, 384_000, `${path}.sampleRate`);
  boundedInteger(clock.lookAheadFrames, 1, host.maxDecodedFrames, `${path}.lookAheadFrames`);
  boundedInteger(clock.driftToleranceFrames, 0, 384_000, `${path}.driftToleranceFrames`);
  enumeration(clock.driftPolicy, ['resync', 'error'], `${path}.driftPolicy`);
  enumeration(clock.lateDecodePolicy, ['catch-up', 'drop', 'error'], `${path}.lateDecodePolicy`);
  enumeration(clock.visibilityPolicy, ['continue', 'pause-resume'], `${path}.visibilityPolicy`);
  enumeration(clock.suspendedPolicy, ['queue-until-resume', 'error'], `${path}.suspendedPolicy`);
}

function parseBrowser(value: unknown): void {
  const path = '$.browser';
  const browser = object(value, path);
  exactKeys(browser, ['autoplay'], path);
  enumeration(browser.autoplay, ['require-user-gesture', 'attempt'], `${path}.autoplay`);
}

function parseResource(
  value: unknown,
  path: string,
  totals: ParseTotals,
  limits: Readonly<AudioEventLimits>,
): HyaAudioResource {
  const resource = object(value, path);
  exactKeys(resource, [
    'id',
    'codec',
    'mediaType',
    'integrity',
    'sampleRate',
    'channels',
    'frameLength',
    'source',
  ], path);
  identifier(resource.id, `${path}.id`, totals, limits);
  const codec = enumeration(resource.codec, [
    'pcm-f32',
    'wav',
    'mp3',
    'aac',
    'opus',
    'vorbis',
    'flac',
  ], `${path}.codec`) as HyaAudioCodec;
  const mediaType = text(resource.mediaType, `${path}.mediaType`, totals, limits);
  if (!CODEC_MEDIA_TYPES[codec].includes(mediaType)) {
    audioEventFail('E_AUDIO_EVENT_CODEC', `${path}.mediaType`, 'media type is incompatible with codec');
  }
  const integrity = object(resource.integrity, `${path}.integrity`);
  exactKeys(integrity, ['algorithm', 'digest'], `${path}.integrity`);
  literal(integrity.algorithm, 'sha256', `${path}.integrity.algorithm`, 'E_AUDIO_EVENT_INTEGRITY');
  const digest = text(integrity.digest, `${path}.integrity.digest`, totals, limits);
  if (!/^[0-9a-f]{64}$/u.test(digest)) {
    audioEventFail('E_AUDIO_EVENT_INTEGRITY', `${path}.integrity.digest`, 'digest must be lowercase SHA-256 hex');
  }
  const sampleRate = boundedInteger(resource.sampleRate, 8_000, 384_000, `${path}.sampleRate`);
  const channels = boundedInteger(resource.channels, 1, 32, `${path}.channels`);
  const frameLength = boundedInteger(resource.frameLength, 1, limits.maxDecodedFrames, `${path}.frameLength`);
  const decodedFrames = safeProduct(frameLength, channels, `${path}.frameLength`);
  const decodedBytes = safeProduct(decodedFrames, 4, `${path}.frameLength`);
  totals.decodedFrames = safeSum(totals.decodedFrames, decodedFrames, '$.resources');
  totals.decodedBytes = safeSum(totals.decodedBytes, decodedBytes, '$.resources');

  const sourcePath = `${path}.source`;
  const source = object(resource.source, sourcePath);
  const kind = enumeration(source.kind, ['embedded', 'referenced', 'hosted'], `${sourcePath}.kind`);
  if (kind === 'embedded') {
    exactKeys(source, ['kind', 'data'], sourcePath);
    const data = text(source.data, `${sourcePath}.data`, totals, limits);
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(data)) {
      audioEventFail('E_AUDIO_EVENT_FORMAT', `${sourcePath}.data`, 'embedded data must be canonical base64');
    }
    const byteLength = base64ByteLength(data);
    if (byteLength === 0) audioEventFail('E_AUDIO_EVENT_FORMAT', `${sourcePath}.data`, 'embedded audio must not be empty');
    enforceLimit(byteLength, limits.maxEmbeddedBytes, `${sourcePath}.data`);
    totals.embeddedBytes = safeSum(totals.embeddedBytes, byteLength, '$.resources');
  } else if (kind === 'referenced') {
    exactKeys(source, ['kind', 'uri'], sourcePath);
    const uri = text(source.uri, `${sourcePath}.uri`, totals, limits);
    if (uri.length === 0) audioEventFail('E_AUDIO_EVENT_FORMAT', `${sourcePath}.uri`, 'URI must not be empty');
  } else {
    exactKeys(source, ['kind', 'key'], sourcePath);
    identifier(source.key, `${sourcePath}.key`, totals, limits);
  }
  return resource as unknown as HyaAudioResource;
}

function parseBus(
  value: unknown,
  path: string,
  ids: ReadonlySet<string>,
  totals: ParseTotals,
  limits: Readonly<AudioEventLimits>,
): HyaAudioBus {
  const bus = object(value, path);
  exactKeys(bus, ['id', 'parent', 'gain'], path);
  identifier(bus.id, `${path}.id`, totals, limits);
  if (bus.parent !== undefined) reference(bus.parent, ids, `${path}.parent`);
  boundedNumber(bus.gain, 0, 4, `${path}.gain`);
  return bus as unknown as HyaAudioBus;
}

function parseCue(
  value: unknown,
  path: string,
  resourceIds: ReadonlySet<string>,
  busIds: ReadonlySet<string>,
  resources: ReadonlyMap<string, HyaAudioResource>,
  totals: ParseTotals,
  limits: Readonly<AudioEventLimits>,
): HyaAudioCue {
  const cue = object(value, path);
  exactKeys(cue, [
    'id',
    'resource',
    'owner',
    'bus',
    'gain',
    'rate',
    'offsetFrames',
    'durationFrames',
    'loop',
    'overlap',
    'priority',
  ], path);
  identifier(cue.id, `${path}.id`, totals, limits);
  const resourceId = reference(cue.resource, resourceIds, `${path}.resource`);
  identifier(cue.owner, `${path}.owner`, totals, limits);
  reference(cue.bus, busIds, `${path}.bus`);
  boundedNumber(cue.gain, 0, 4, `${path}.gain`);
  boundedNumber(cue.rate, 0.0625, 16, `${path}.rate`);
  const resource = resources.get(resourceId)!;
  const offsetFrames = boundedInteger(cue.offsetFrames, 0, resource.frameLength - 1, `${path}.offsetFrames`);
  if (cue.durationFrames !== undefined) {
    boundedInteger(cue.durationFrames, 1, resource.frameLength - offsetFrames, `${path}.durationFrames`);
  }
  if (cue.loop !== undefined) {
    if (cue.durationFrames !== undefined) {
      audioEventFail('E_AUDIO_EVENT_FORMAT', path, 'loop iterations and durationFrames are mutually exclusive');
    }
    const loopPath = `${path}.loop`;
    const loop = object(cue.loop, loopPath);
    exactKeys(loop, ['startFrame', 'endFrame', 'iterations'], loopPath);
    const start = boundedInteger(loop.startFrame, 0, resource.frameLength - 1, `${loopPath}.startFrame`);
    const end = boundedInteger(loop.endFrame, 1, resource.frameLength, `${loopPath}.endFrame`);
    if (end <= start || offsetFrames >= end) {
      audioEventFail('E_AUDIO_EVENT_NUMBER', loopPath, 'loop range must contain the cue offset');
    }
    if (loop.iterations !== 'infinite') boundedInteger(loop.iterations, 1, 1_000_000, `${loopPath}.iterations`);
  }
  enumeration(cue.overlap, ['allow', 'ignore', 'restart'], `${path}.overlap`);
  boundedInteger(cue.priority, -1_000_000, 1_000_000, `${path}.priority`);
  return cue as unknown as HyaAudioCue;
}

function parseTimelineEvent(
  value: unknown,
  path: string,
  cueIds: ReadonlySet<string>,
  totals: ParseTotals,
  limits: Readonly<AudioEventLimits>,
): HyaAudioTimelineEvent {
  const event = object(value, path);
  exactKeys(event, ['id', 'clock', 'time', 'sequence', 'cue', 'operation'], path);
  identifier(event.id, `${path}.id`, totals, limits);
  enumeration(event.clock, ['composition', 'state', 'event'], `${path}.clock`);
  boundedNumber(event.time, 0, Number.MAX_SAFE_INTEGER, `${path}.time`);
  boundedInteger(event.sequence, 0, Number.MAX_SAFE_INTEGER, `${path}.sequence`);
  reference(event.cue, cueIds, `${path}.cue`);
  enumeration(event.operation, ['start', 'stop'], `${path}.operation`);
  return event as unknown as HyaAudioTimelineEvent;
}

function validateBusGraph(buses: readonly HyaAudioBus[], maxDepth: number): void {
  const parents = new Map(buses.map(bus => [bus.id, bus.parent]));
  const gains = new Map(buses.map(bus => [bus.id, bus.gain]));
  for (const bus of buses) {
    const seen = new Set<string>();
    let current: string | undefined = bus.id;
    let depth = 0;
    let effectiveGain = 1;
    while (current !== undefined) {
      if (seen.has(current)) audioEventFail('E_AUDIO_EVENT_GRAPH', `$.buses.${bus.id}`, 'bus graph contains a cycle');
      seen.add(current);
      effectiveGain *= gains.get(current) ?? 1;
      if (!Number.isFinite(effectiveGain) || effectiveGain > 4) {
        audioEventFail('E_AUDIO_EVENT_LIMIT', `$.buses.${bus.id}.gain`, 'effective bus gain exceeds 4');
      }
      current = parents.get(current);
      if (++depth > maxDepth) audioEventFail('E_AUDIO_EVENT_LIMIT', `$.buses.${bus.id}`, 'bus graph exceeds depth budget');
    }
  }
}

function uniqueIds(
  values: readonly unknown[],
  path: string,
  totals: ParseTotals,
  limits: Readonly<AudioEventLimits>,
): Set<string> {
  const ids = new Set<string>();
  values.forEach((value, index) => {
    const id = identifier(object(value, `${path}[${index}]`).id, `${path}[${index}].id`, totals, limits);
    if (ids.has(id)) audioEventFail('E_AUDIO_EVENT_FORMAT', `${path}[${index}].id`, 'duplicate id');
    ids.add(id);
  });
  return ids;
}

function exactKeys(value: UnknownRecord, allowed: readonly string[], path: string): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) audioEventFail('E_AUDIO_EVENT_FORMAT', `${path}.${key}`, 'unknown field');
  }
  for (const key of allowed) {
    if (!(key in value) && !['parent', 'durationFrames', 'loop'].includes(key)) {
      audioEventFail('E_AUDIO_EVENT_FORMAT', `${path}.${key}`, 'required field is missing');
    }
  }
}

function object(value: unknown, path: string): UnknownRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    audioEventFail('E_AUDIO_EVENT_FORMAT', path, 'expected object');
  }
  return value as UnknownRecord;
}

function array(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) audioEventFail('E_AUDIO_EVENT_FORMAT', path, 'expected array');
  return value;
}

function literal(
  value: unknown,
  expected: string | number,
  path: string,
  code: 'E_AUDIO_EVENT_FORMAT' | 'E_AUDIO_EVENT_VERSION' | 'E_AUDIO_EVENT_INTEGRITY',
): void {
  if (value !== expected) audioEventFail(code, path, `expected ${JSON.stringify(expected)}`);
}

function enumeration(value: unknown, allowed: readonly string[], path: string): string {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    audioEventFail('E_AUDIO_EVENT_FORMAT', path, `expected one of ${allowed.join(', ')}`);
  }
  return value;
}

function identifier(
  value: unknown,
  path: string,
  totals: ParseTotals,
  limits: Readonly<AudioEventLimits>,
): string {
  const result = text(value, path, totals, limits);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/u.test(result)) {
    audioEventFail('E_AUDIO_EVENT_FORMAT', path, 'invalid identifier');
  }
  return result;
}

function text(
  value: unknown,
  path: string,
  totals: ParseTotals,
  limits: Readonly<AudioEventLimits>,
): string {
  if (typeof value !== 'string') audioEventFail('E_AUDIO_EVENT_FORMAT', path, 'expected string');
  const bytes = new TextEncoder().encode(value).byteLength;
  enforceLimit(bytes, limits.maxStringBytes, path);
  totals.textBytes = safeSum(totals.textBytes, bytes, '$.textBytes');
  return value;
}

function reference(value: unknown, ids: ReadonlySet<string>, path: string): string {
  if (typeof value !== 'string' || !ids.has(value)) {
    audioEventFail('E_AUDIO_EVENT_REFERENCE', path, 'unknown reference');
  }
  return value;
}

function boundedInteger(value: unknown, minimum: number, maximum: number, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    audioEventFail('E_AUDIO_EVENT_NUMBER', path, `expected integer in [${minimum}, ${maximum}]`);
  }
  return value as number;
}

function boundedNumber(value: unknown, minimum: number, maximum: number, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    audioEventFail('E_AUDIO_EVENT_NUMBER', path, `expected finite number in [${minimum}, ${maximum}]`);
  }
  return value;
}

function enforceLimit(observed: number, limit: number, path: string): void {
  if (observed > limit) audioEventFail('E_AUDIO_EVENT_LIMIT', path, `limit ${limit} exceeded by ${observed}`);
}

function safeSum(left: number, right: number, path: string): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) audioEventFail('E_AUDIO_EVENT_LIMIT', path, 'aggregate size exceeds safe integer range');
  return result;
}

function safeProduct(left: number, right: number, path: string): number {
  const result = left * right;
  if (!Number.isSafeInteger(result)) audioEventFail('E_AUDIO_EVENT_LIMIT', path, 'decoded size exceeds safe integer range');
  return result;
}

function base64ByteLength(value: string): number {
  if (value.length === 0) return 0;
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  return value.length / 4 * 3 - padding;
}

function assertAcyclic(value: unknown, path: string, maxDepth: number): void {
  const active = new Set<object>();
  const visit = (candidate: unknown, candidatePath: string, depth: number): void => {
    if (candidate === null || typeof candidate !== 'object') return;
    if (depth > maxDepth) audioEventFail('E_AUDIO_EVENT_LIMIT', candidatePath, 'reference depth budget exceeded');
    if (active.has(candidate)) audioEventFail('E_AUDIO_EVENT_GRAPH', candidatePath, 'input contains a cycle');
    active.add(candidate);
    if (Array.isArray(candidate)) {
      candidate.forEach((entry, index) => visit(entry, `${candidatePath}[${index}]`, depth + 1));
    } else {
      for (const [key, entry] of Object.entries(candidate)) visit(entry, `${candidatePath}.${key}`, depth + 1);
    }
    active.delete(candidate);
  };
  visit(value, path, 0);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
