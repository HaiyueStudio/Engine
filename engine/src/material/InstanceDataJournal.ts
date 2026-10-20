/** Private bounded revision journal: one renderer clearing the compatibility
 * dirty range must not consume updates for other users of the same material.
 * Fixed arrays avoid per-instance allocations when a CPU army is updated. */
type Range = { revision: number; start: number; end: number };
type Channel = { revision: number; starts: Float64Array; ends: Float64Array };
const CAPACITY = 32;
const states = new WeakMap<object, { transforms: Channel; colors: Channel }>();
function channel(): Channel {
  return { revision: 0, starts: new Float64Array(CAPACITY), ends: new Float64Array(CAPACITY) };
}
function state(owner: object) {
  let value = states.get(owner);
  if (!value) {
    value = { transforms: channel(), colors: channel() };
    states.set(owner, value);
  }
  return value;
}
export function markInstanceData(owner: object, name: 'transforms' | 'colors', start: number, end: number): void {
  const value = state(owner)[name];
  const index = ++value.revision % CAPACITY;
  value.starts[index] = start;
  value.ends[index] = end;
}
export function instanceDataChanges(owner: object, name: 'transforms' | 'colors', since: number | undefined, count: number): Range {
  const value = state(owner)[name];
  if (since === undefined || since < value.revision - CAPACITY) {
    return { revision: value.revision, start: 0, end: count };
  }
  let start = count, end = 0;
  for (let revision = since + 1; revision <= value.revision; revision++) {
    const index = revision % CAPACITY;
    start = Math.min(start, value.starts[index]!);
    end = Math.max(end, Math.min(count, value.ends[index]!));
  }
  return { revision: value.revision, start, end };
}
