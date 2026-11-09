import type {GuiRect} from '../GuiTypes';
import {isGuiControl} from '../GuiControlIdentity';

interface DirectionalNode {readonly id: string; readonly parent?: DirectionalNode | null; readonly rect?: Readonly<GuiRect>;}

/** The same directional scoring is used by ordinary focus and keyboard drop selection. */
export function guiDirectionalTarget<T extends DirectionalNode>(
  current: T, nodes: readonly T[], direction: 'left' | 'right' | 'up' | 'down',
  rectFor: (node: T) => Readonly<GuiRect>, explicit?: string,
): T | null {
  const neighbour = explicit ? nodes.find(node => node.id === explicit && node !== current) : undefined;
  if (neighbour) return neighbour;
  const origin = rectFor(current), horizontal = direction === 'left' || direction === 'right';
  const sign = direction === 'left' || direction === 'up' ? -1 : 1;
  const crossStart = horizontal ? origin.y : origin.x;
  const crossEnd = crossStart + (horizontal ? origin.height : origin.width);
  const ancestors = new Set<DirectionalNode>();
  const scrollScopes = new Map<DirectionalNode, number>();
  for (let node = current.parent; node; node = node.parent) {
    ancestors.add(node);
    if (isGuiControl<DirectionalNode & {axis: string}>(node, 'GuiScrollView') && node.axis === (horizontal ? 'horizontal' : 'vertical'))
      scrollScopes.set(node, scrollScopes.size);
  }
  const ranks = new Map(scrollScopes);
  const scopeRank = (node: DirectionalNode | null | undefined): number => {
    if (!node) return scrollScopes.size;
    const cached = ranks.get(node);
    if (cached !== undefined) return cached;
    const rank = scopeRank(node.parent); ranks.set(node, rank); return rank;
  };
  // Local rectangles share their ancestor viewport's layout plane, independent
  // of the caller's host projection. Shared viewports may reveal the next row;
  // a completely clipped row in another viewport cannot steal outside focus.
  const clips = new Map<DirectionalNode, Readonly<GuiRect> | null>();
  const clipFor = (node: DirectionalNode | null | undefined): Readonly<GuiRect> | null => {
    if (!node) return null;
    if (clips.has(node)) return clips.get(node)!;
    let clip = clipFor(node.parent);
    if (!ancestors.has(node) && node.rect && isGuiControl(node, 'GuiScrollView')) {
      const r = node.rect;
      if (!clip) clip = r;
      else {
        const x = Math.max(clip.x, r.x), y = Math.max(clip.y, r.y);
        clip = {x, y, width: Math.max(0, Math.min(clip.x + clip.width, r.x + r.width) - x),
          height: Math.max(0, Math.min(clip.y + clip.height, r.y + r.height) - y)};
      }
    }
    clips.set(node, clip); return clip;
  };
  let best: {node: T; rank: number; lane: number; cost: number; angle: number; distance: number} | null = null;
  for (const node of nodes) {
    if (node === current || ancestors.has(node)) continue;
    const clip = clipFor(node.parent), local = node.rect;
    if (clip && local && (Math.min(local.x + local.width, clip.x + clip.width) <= Math.max(local.x, clip.x)
      || Math.min(local.y + local.height, clip.y + clip.height) <= Math.max(local.y, clip.y))) continue;
    const rect = rectFor(node);
    if (rect.width <= 0 || rect.height <= 0) continue;
    const dx = rect.x + rect.width / 2 - origin.x - origin.width / 2;
    const dy = rect.y + rect.height / 2 - origin.y - origin.height / 2;
    const forward = (horizontal ? dx : dy) * sign;
    if (forward <= 0) continue;
    // Traverse the current viewport along its scroll axis before leaving it.
    // An offscreen preceding row must not lose to a fixed toolbar over its clip.
    const rank = scopeRank(node);
    if (best && rank > best.rank) continue;
    // Prefer the same row/column before a closer diagonal in another lane.
    // At least half of the smaller cross-axis extent must overlap: tiny edge
    // intersections between neighbouring rows must not count as the same lane.
    const start = horizontal ? rect.y : rect.x;
    const end = start + (horizontal ? rect.height : rect.width);
    const overlap = Math.min(crossEnd, end) - Math.max(crossStart, start);
    const lane = overlap > 0 && overlap * 2 >= Math.min(crossEnd - crossStart, end - start) ? 0 : 1;
    if (best && rank === best.rank && lane > best.lane) continue;
    const gap = Math.max(0, crossStart - end, start - crossEnd);
    const cost = forward * forward + gap * gap;
    if (!Number.isFinite(cost) || (best && rank === best.rank && lane === best.lane && cost > best.cost)) continue;
    const cross = horizontal ? dy : dx, angle = Math.atan2(Math.abs(cross), forward);
    const distance = dx * dx + dy * dy;
    const order = !best ? -1 : rank - best.rank || lane - best.lane || cost - best.cost || angle - best.angle || distance - best.distance
      || (node.id < best.node.id ? -1 : node.id > best.node.id ? 1 : 0);
    if (order < 0) best = {node, rank, lane, cost, angle, distance};
  }
  return best?.node ?? null;
}
