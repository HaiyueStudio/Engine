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
  const scored = nodes.filter(node => node !== current).map(node => {
    const rect = rectFor(node), dx = rect.x + rect.width / 2 - origin.x - origin.width / 2;
    const dy = rect.y + rect.height / 2 - origin.y - origin.height / 2;
    const forward = (horizontal ? dx : dy) * sign, cross = horizontal ? dy : dx;
    return {node, forward, angle: Math.atan2(Math.abs(cross), forward), distance: dx * dx + dy * dy};
  }).filter(item => item.forward > 0);
  scored.sort((a, b) => a.angle - b.angle || a.distance - b.distance || (a.node.id < b.node.id ? -1 : a.node.id > b.node.id ? 1 : 0));
  return scored[0]?.node ?? null;
}
