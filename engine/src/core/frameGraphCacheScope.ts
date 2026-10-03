import type { RenderCommandContext } from './RenderCommandContext';
import type { RenderViewSnapshot } from './RenderView';

const identities = new WeakMap<object, number>();
let nextIdentity = 0;
function identity(value: object | undefined): number {
  if (!value) return 0;
  let id = identities.get(value);
  if (id === undefined) { id = ++nextIdentity; identities.set(value, id); }
  return id;
}
function viewScope(view: RenderViewSnapshot | undefined): unknown {
  if (!view) return null;
  return [view.key, identity(view.target), view.width, view.height, view.displayWidth, view.displayHeight,
    view.target?.width, view.target?.height, view.target?.format, view.sampleCount, view.reverseZ,
    view.loadOp, view.postProcessEnabled, view.viewport, view.scissor];
}
/** Physical bindings are always resolved afresh; these values fence structural configuration changes. */
export function frameGraphCacheScope(context: RenderCommandContext, view = context.view): string {
  return JSON.stringify([viewScope(view), context.viewFamily?.views.map(viewScope) ?? []]);
}
