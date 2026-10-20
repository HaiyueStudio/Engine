/** Value snapshots: collectors may mutate or replace commands between frames. */
type Command = { color: readonly number[]; clip?: { x: number; y: number; width: number; height: number } | undefined };
export function sameGuiCommand<T extends Command>(a: T | undefined, b: T): boolean {
  if (!a) return false;
  const keys = Object.keys(a) as (keyof T)[];
  if (keys.length !== Object.keys(b).length) return false;
  for (const key of keys) {
    if (key === 'color' || key === 'clip') continue;
    if (a[key] !== b[key]) return false;
  }
  if (!a.color.every((value, i) => value === b.color[i])) return false;
  return a.clip === b.clip || !!(a.clip && b.clip && a.clip.x === b.clip.x &&
    a.clip.y === b.clip.y && a.clip.width === b.clip.width && a.clip.height === b.clip.height);
}
export function snapshotGuiCommand<T extends Command>(command: T): T {
  return { ...command, color: [...command.color], ...(command.clip ? { clip: { ...command.clip } } : {}) };
}
