import { comparePortablePixelRecords } from './visual-regression/portable-pixels.mjs';
export const VOLUME_PIXEL_BASELINE_KEYS = Object.freeze([
  'schemaVersion',
  'fixture',
  'width',
  'height',
  'hash',
  'bytes',
  'coverage',
]);

export function compareVolumePixelRecords(current, baseline) {
  const mismatches = [];
  const portable = current.visual || baseline?.visual;
  if (portable) {
    const comparison = comparePortablePixelRecords(current, baseline);
    if (comparison.status !== 'passed') mismatches.push(`Volume visual regression: ${JSON.stringify(comparison)}`);
  }
  for (const key of VOLUME_PIXEL_BASELINE_KEYS.filter(key => !portable || !['hash', 'bytes'].includes(key))) {
    if (current[key] !== baseline?.[key]) {
      mismatches.push(
        `Volume pixel regression at ${key}: expected ${baseline?.[key]}, received ${current[key]}.`,
      );
    }
  }
  return mismatches;
}

export function resolveVolumePixelCandidateMode(environment = process.env) {
  const enabled = environment.VOLUME_CANDIDATE_DIFF === '1';
  const directory = environment.VOLUME_CANDIDATE_DIR?.trim() ?? '';
  if (enabled !== Boolean(directory)) {
    throw new Error(
      'VOLUME_CANDIDATE_DIFF=1 and VOLUME_CANDIDATE_DIR must be provided together.',
    );
  }
  return Object.freeze({ enabled, directory: directory || null });
}
