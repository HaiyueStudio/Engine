import type {GuiLayoutBinding} from './types.js';
interface Counters {solves: number; solvedNodes: number; measurements: number; sessions: number;}
const counters = new WeakMap<GuiLayoutBinding, Counters>();
/** Internal structural verifier; deliberately absent from the public source entry. */
export function registerGuiLayoutCounters(binding: GuiLayoutBinding, value: Counters): void {counters.set(binding, value);}
export function readGuiLayoutCounters(binding: GuiLayoutBinding): Readonly<Counters> {const value = counters.get(binding); if (!value) throw new Error('Unknown GUI binding.'); return Object.freeze({...value});}
