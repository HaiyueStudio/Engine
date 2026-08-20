import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const CONTENT_TIERS = Object.freeze(['smoke', 'full']);

const MANIFEST_SOURCES = Object.freeze([
  Object.freeze({ repository: 'Engine', directory: 'examples', kind: 'examples', prefix: 'example' }),
  Object.freeze({ repository: 'Games', directory: 'games', kind: 'games', prefix: 'game' }),
]);
const CI_LABELS = new Set(['smoke', 'full', 'manual']);

export function resolveContentTier(argv) {
  const values = [];
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--content-tier') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) {
        throw new Error('--content-tier requires smoke or full.');
      }
      values.push(value);
      index++;
    } else if (argument.startsWith('--content-tier=')) {
      values.push(argument.slice('--content-tier='.length));
    } else {
      throw new Error(`Unknown check:slow argument "${argument}".`);
    }
  }
  if (values.length > 1) throw new Error('Specify --content-tier exactly once.');
  const tier = values[0] ?? 'smoke';
  if (!CONTENT_TIERS.includes(tier)) {
    throw new RangeError(`Unknown content tier "${tier}"; expected smoke or full.`);
  }
  return tier;
}

export function loadContentManifests(root) {
  return MANIFEST_SOURCES.map(source => ({
    ...source,
    manifest: JSON.parse(readFileSync(resolve(
      source.repository === 'Games' ? resolve(root, '../Games') : root,
      source.directory,
      'manifest.json',
    ), 'utf8')),
  }));
}

export function createContentTargetPlan(tier, sources) {
  if (!CONTENT_TIERS.includes(tier)) {
    throw new RangeError(`Unknown content tier "${tier}"; expected smoke or full.`);
  }
  const includedLabels = tier === 'full' ? new Set(['smoke', 'full']) : new Set(['smoke']);
  const targets = [];
  const counts = { smoke: 0, full: 0, manual: 0 };
  const seenTargets = new Set();

  for (const source of sources) {
    const { manifest, kind, prefix } = source;
    if (manifest?.kind !== kind || !Array.isArray(manifest.entries)) {
      throw new Error(`${kind} manifest has an invalid kind or entries collection.`);
    }
    for (const entry of manifest.entries) {
      if (typeof entry.id !== 'string' || entry.id.length === 0) {
        throw new Error(`${kind} manifest contains an entry without an id.`);
      }
      if (!CI_LABELS.has(entry.ci)) {
        throw new Error(`${kind}:${entry.id} has unknown ci label "${String(entry.ci)}".`);
      }
      counts[entry.ci]++;
      if (!includedLabels.has(entry.ci)) continue;
      const target = `${prefix}:${entry.id}`;
      if (seenTargets.has(target)) throw new Error(`Duplicate content target "${target}".`);
      seenTargets.add(target);
      targets.push(target);
    }
  }

  return Object.freeze({
    tier,
    targets: Object.freeze(targets),
    manifestCounts: Object.freeze(counts),
    selectedCounts: Object.freeze({
      smoke: counts.smoke,
      full: tier === 'full' ? counts.full : 0,
      manual: 0,
    }),
  });
}
