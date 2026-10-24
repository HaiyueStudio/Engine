/** Keeps the existing entity/world transform and drawable-local gradient coordinates. */
export function writeAnimationVisualMatrix(target: Float32Array, world: Float32Array, local: readonly [number, number, number, number, number, number] | null): void {
  if (!local) {target.set(world, 0); return;}
  const [a, b, c, d, x, y] = local;
  for (let row = 0; row < 4; row++) {
    target[row] = world[row]! * a + world[row + 4]! * b;
    target[row + 4] = world[row]! * c + world[row + 4]! * d;
    target[row + 8] = world[row + 8]!;
    target[row + 12] = world[row]! * x + world[row + 4]! * y + world[row + 12]!;
  }
}
