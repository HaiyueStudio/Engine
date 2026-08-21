/** A normalized Motion3 entry declared by `model3.json#FileReferences.Motions`. */
export interface CubismModel3MotionReference {
  readonly id: string;
  readonly group: string;
  readonly index: number;
  readonly file: string;
  readonly fadeInTime?: number;
  readonly fadeOutTime?: number;
  readonly sound?: string;
}

/**
 * Flatten the grouped Cubism model3 motion table without loading proprietary runtime code.
 * The stable id can be used by tools and example UIs as an action-selection value.
 */
export function listCubismModel3Motions(value: unknown): readonly CubismModel3MotionReference[] {
  if (value === undefined || value === null) return Object.freeze([]);
  if (!isRecord(value)) throw new TypeError('model3 FileReferences.Motions must be an object.');
  const motions: CubismModel3MotionReference[] = [];
  for (const [group, entries] of Object.entries(value)) {
    if (!Array.isArray(entries)) throw new TypeError(`model3 motion group "${group}" must be an array.`);
    entries.forEach((entry, index) => {
      if (!isRecord(entry) || typeof entry.File !== 'string' || entry.File.length === 0) throw new TypeError(`model3 motion group "${group}" entry ${index} requires File.`);
      const fadeInTime = optionalFiniteNumber(entry.FadeInTime, group, index, 'FadeInTime');
      const fadeOutTime = optionalFiniteNumber(entry.FadeOutTime, group, index, 'FadeOutTime');
      if (entry.Sound !== undefined && typeof entry.Sound !== 'string') throw new TypeError(`model3 motion group "${group}" entry ${index} Sound must be a string.`);
      motions.push(Object.freeze({
        id: `${encodeURIComponent(group)}:${index}`,
        group,
        index,
        file: entry.File,
        ...(fadeInTime === undefined ? {} : { fadeInTime }),
        ...(fadeOutTime === undefined ? {} : { fadeOutTime }),
        ...(typeof entry.Sound === 'string' ? { sound: entry.Sound } : {}),
      }));
    });
  }
  return Object.freeze(motions);
}

function optionalFiniteNumber(value: unknown, group: string, index: number, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new TypeError(`model3 motion group "${group}" entry ${index} ${field} must be a non-negative finite number.`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
