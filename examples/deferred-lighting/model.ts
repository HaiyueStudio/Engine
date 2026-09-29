export type LightingPath = 'forward' | 'reference' | 'tiled';
export const LIGHT_COUNTS = [1, 8, 9, 32, 128, 256, 512, 1024] as const;
export type Vec3 = [number, number, number];
export function parseCount(value: string | null): number { const n = Number(value); return LIGHT_COUNTS.some(count => count === n) ? n : 128; }
export function parsePath(value: string | null): LightingPath { return value === 'forward' || value === 'reference' ? value : 'tiled'; }
export function makeLights() {
  let seed = 20260929;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  return Array.from({ length: 1024 }, (_, index) => ({
    position: [random() * 20 - 10, .8 + random() * 3.5, random() * 17 - 9] as Vec3,
    phase: random() * Math.PI * 2,
    color: (index % 3 === 0 ? [1, .2, .05] : index % 3 === 1 ? [.08, .7, 1] : [.55, .14, 1]) as Vec3,
  }));
}
export function lightPosition(base: Vec3, phase: number, time: number, overlap: boolean): Vec3 {
  const scale = overlap ? .22 : 1;
  return [base[0] * scale + Math.sin(time * .65 + phase) * .5, base[1] + Math.sin(time * .5 + phase) * .3, base[2] * scale + Math.cos(time * .65 + phase) * .5];
}
