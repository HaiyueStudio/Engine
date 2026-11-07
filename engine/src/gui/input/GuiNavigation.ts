import type {GuiRect} from '../GuiTypes';

/** The same directional scoring is used by ordinary focus and keyboard drop selection. */
export function guiDirectionalTarget<T extends {readonly id: string}>(
  current: T, nodes: readonly T[], direction: 'left' | 'right' | 'up' | 'down',
  rectFor: (node: T) => Readonly<GuiRect>, explicit?: string,
): T | null {
  const neighbour = explicit ? nodes.find(node => node.id === explicit && node !== current) : undefined;
  if (neighbour) return neighbour;
  const origin = rectFor(current), horizontal = direction === 'left' || direction === 'right';
  const sign = direction === 'left' || direction === 'up' ? -1 : 1;
  const crossStart = horizontal ? origin.y : origin.x;
  const crossEnd = crossStart + (horizontal ? origin.height : origin.width);
  let best: {node: T; cost: number; angle: number; distance: number} | null = null;
  for (const node of nodes) {
    if (node === current) continue;
    const rect = rectFor(node);
    if (rect.width <= 0 || rect.height <= 0) continue;
    const dx = rect.x + rect.width / 2 - origin.x - origin.width / 2;
    const dy = rect.y + rect.height / 2 - origin.y - origin.height / 2;
    const forward = (horizontal ? dx : dy) * sign;
    if (forward <= 0) continue;
    // Overlapping rows/columns share a directional lane even when widths differ.
    // Distance precedes angular alignment so distant controls cannot skip nearby rows.
    const start = horizontal ? rect.y : rect.x;
    const end = start + (horizontal ? rect.height : rect.width);
    const gap = Math.max(0, crossStart - end, start - crossEnd);
    const cost = forward * forward + gap * gap;
    if (!Number.isFinite(cost) || (best && cost > best.cost)) continue;
    const cross = horizontal ? dy : dx, angle = Math.atan2(Math.abs(cross), forward);
    const distance = dx * dx + dy * dy;
    const order = !best ? -1 : cost - best.cost || angle - best.angle || distance - best.distance
      || (node.id < best.node.id ? -1 : node.id > best.node.id ? 1 : 0);
    if (order < 0) best = {node, cost, angle, distance};
  }
  return best?.node ?? null;
}
