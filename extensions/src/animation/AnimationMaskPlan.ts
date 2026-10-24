import {AnimationFormatError} from '@haiyue/animation-spec';
import {ANIMATION_2D_MAX_MASK_PIXELS, assertAnimationMaskBudget, type AnimationMaskBudgetInput} from './AnimationMaskBudget.js';

export interface AnimationMaskPlanSource {readonly dependencies: readonly string[]; readonly transparent: boolean;}
export type AnimationMaskPlanOperation = Readonly<{kind: 'source'; source: string; slot: number}> | Readonly<{kind: 'output'; index: number}>;
export interface AnimationMaskPlan {
  readonly mode: 'eager' | 'streamed'; readonly targetCount: number; readonly sourceCount: number; readonly sourcePasses: number;
  readonly operations: readonly AnimationMaskPlanOperation[];
}
type Budget = Omit<AnimationMaskBudgetInput, 'groupCount'>;
interface Slot {owner: string; pins: number; touched: number;}
interface Pending {readonly key: string; readonly dependencies: readonly string[]; cursor: number; readonly held: number[];}

/** Orders the existing mask draws; it never changes geometry, blend order or shader semantics. */
export function planAnimationMasks(sources: ReadonlyMap<string, AnimationMaskPlanSource>, outputs: readonly (readonly string[])[], budget: Budget): AnimationMaskPlan {
  assertAnimationMaskBudget({...budget, groupCount: 0});
  const graph = new Map([...sources].map(([key, value]) => [key, value.transparent ? [] : [...new Set(value.dependencies)]]));
  const path = `$runtime.views[${JSON.stringify(budget.viewKey)}].maskGroups`;
  const requireSource = (key: string): void => {if (!graph.has(key)) throw new AnimationFormatError('E_ANIMATION_INVALID_FORMAT', `Missing composite source ${JSON.stringify(key)}.`, path);};
  for (const dependencies of [...graph.values(), ...outputs]) for (const key of dependencies) requireSource(key);
  const colors = new Map<string, 1 | 2>(), ordered: string[] = [];
  for (const key of graph.keys()) {
    const stack: {key: string; cursor: number}[] = [{key, cursor: 0}];
    while (stack.length) {
      const frame = stack[stack.length - 1]!;
      if (colors.get(frame.key) === 2) {stack.pop(); continue;}
      colors.set(frame.key, 1); const dependencies = graph.get(frame.key)!;
      if (frame.cursor < dependencies.length) {
        const child = dependencies[frame.cursor++]!;
        if (colors.get(child) === 1) throw new AnimationFormatError('E_ANIMATION_INVALID_FORMAT', `Cyclic composite source ${JSON.stringify(child)}.`, path);
        if (colors.get(child) !== 2) stack.push({key: child, cursor: 0});
      } else {colors.set(frame.key, 2); ordered.push(frame.key); stack.pop();}
    }
  }
  const active = ordered.filter(key => !sources.get(key)!.transparent);
  const capacity = Math.min(budget.maxGroupCount, Math.floor((budget.maxPixels ?? ANIMATION_2D_MAX_MASK_PIXELS) / budget.width / budget.height));
  const operations: AnimationMaskPlanOperation[] = [];
  if (active.length <= capacity) {
    assertAnimationMaskBudget({...budget, groupCount: active.length});
    active.forEach((source, slot) => operations.push(Object.freeze({kind: 'source', source, slot})));
    outputs.forEach((_, index) => operations.push(Object.freeze({kind: 'output', index})));
    return Object.freeze({mode: 'eager', targetCount: active.length, sourceCount: active.length, sourcePasses: active.length, operations: Object.freeze(operations)});
  }

  // Child roots are pinned until their parent is encoded. Completed interiors can
  // be evicted/recomputed; no target is overwritten while a pending draw samples it.
  const costs = new Map<string, number>(), dependencies = new Map<string, readonly string[]>();
  for (const key of ordered) {
    const children = graph.get(key)!.filter(child => !sources.get(child)!.transparent).sort((a, b) => costs.get(b)! - costs.get(a)!);
    dependencies.set(key, children);
    costs.set(key, sources.get(key)!.transparent ? 0 : children.reduce((peak, child, index) => Math.max(peak, index + costs.get(child)!), children.length + 1));
  }
  const slots: Slot[] = [], owners = new Map<string, number>(); let touched = 0, sourcePasses = 0;
  const produce = (key: string): number => {
    const stack: Pending[] = [{key, dependencies: dependencies.get(key)!, cursor: 0, held: []}];
    while (stack.length) {
      const frame = stack[stack.length - 1]!;
      if (owners.has(frame.key)) {stack.pop(); continue;}
      if (frame.cursor < frame.dependencies.length) {
        const child = frame.dependencies[frame.cursor]!, slot = owners.get(child);
        if (slot === undefined) {stack.push({key: child, dependencies: dependencies.get(child)!, cursor: 0, held: []}); continue;}
        slots[slot]!.pins++; slots[slot]!.touched = ++touched; frame.held.push(slot); frame.cursor++; continue;
      }
      let slot = -1;
      for (let index = 0; index < slots.length; index++) if (slots[index]!.pins === 0 && (slot < 0 || slots[index]!.touched < slots[slot]!.touched)) slot = index;
      if (slot < 0) {
        assertAnimationMaskBudget({...budget, groupCount: slots.length + 1});
        slot = slots.length; slots.push({owner: '', pins: 0, touched: 0});
      }
      const previous = slots[slot]!.owner; if (previous) owners.delete(previous);
      slots[slot] = {owner: frame.key, pins: 0, touched: ++touched}; owners.set(frame.key, slot);
      operations.push(Object.freeze({kind: 'source', source: frame.key, slot})); sourcePasses++;
      for (const held of frame.held) slots[held]!.pins--;
      stack.pop();
    }
    return owners.get(key)!;
  };
  outputs.forEach((values, index) => {
    const needed = [...new Set(values)].filter(key => !sources.get(key)!.transparent).sort((a, b) => costs.get(b)! - costs.get(a)!);
    const held: number[] = [];
    for (const key of needed) {const slot = owners.get(key) ?? produce(key); slots[slot]!.pins++; slots[slot]!.touched = ++touched; held.push(slot);}
    operations.push(Object.freeze({kind: 'output', index})); for (const slot of held) slots[slot]!.pins--;
  });
  return Object.freeze({mode: 'streamed', targetCount: slots.length, sourceCount: active.length, sourcePasses, operations: Object.freeze(operations)});
}
