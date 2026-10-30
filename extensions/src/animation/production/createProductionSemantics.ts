import {SemanticsRuntime} from '../interaction/SemanticsRuntime.js';
import type {RuntimeSemanticsDocument, RuntimeValue, SemanticSnapshot, SemanticSnapshotNode, DataSubscription} from '../interaction/runtime-types.js';
import {snapshotPlainTextData} from '../text/PlainTextData.js';
import {ProductionFrameError} from './FrameTransaction.js';

type Rect = readonly [number, number, number, number];
type Action = 'tap' | 'increase' | 'decrease' | 'focus';
type Snapshot = Omit<SemanticSnapshot, 'nodes' | 'announcements'> & {
  readonly nodes: readonly (Omit<SemanticSnapshotNode, 'actions'> & {readonly bounds: Rect; readonly actions: readonly Action[]})[];
  readonly announcements: readonly Readonly<{node: string; mode: 'polite' | 'assertive'; text: string}>[];
};
interface Options {
  readonly bindings: {readBinding(binding: string): RuntimeValue};
  readonly host?: {update(snapshot: Snapshot): void; subscribeActions(listener: (node: string, action: Action) => void): DataSubscription};
  action(target: string, action: Action): void;
}
interface Frame {readonly revision: number; readonly geometry: Readonly<Record<string, Rect>>; readonly focused?: string;}
function fail(path: string, message: string): never {throw new ProductionFrameError('E_HYA_RUNTIME_SEMANTICS', path, message);}
const isAction = (value: string): value is Action => ['tap', 'increase', 'decrease', 'focus'].includes(value);

/** Adds committed geometry to the original semantic tree; the host and binding owner remain borrowed. */
export function createProductionSemantics(document: RuntimeSemanticsDocument, options: Options): {
  update(frame: Frame): Snapshot; readonly snapshot: Snapshot | null; dispose(): void;
} {
  if (typeof options?.bindings?.readBinding !== 'function' || typeof options.action !== 'function')
    fail('$.semantics', 'semantic bindings and action ports are required');
  if (options.host && (typeof options.host.update !== 'function' || typeof options.host.subscribeActions !== 'function'))
    fail('$.semantics.host', 'the borrowed semantic host must update and subscribe actions');
  const read = options.bindings.readBinding.bind(options.bindings), actionPort = options.action.bind(options);
  const updateHost = options.host?.update.bind(options.host), subscribeHost = options.host?.subscribeActions.bind(options.host);
  let disposed = false, running = false, last: Snapshot | null = null, key: string | undefined;
  let subscription: DataSubscription | undefined;
  const runtime = new SemanticsRuntime(document, {read}, {update() {}}, {
    invoke(target, action) {if (!isAction(action)) fail('$.semantics.action', 'unknown semantic action'); actionPort(target, action);},
  });
  const live = (): void => {if (disposed) throw new ProductionFrameError('E_HYA_RUNTIME_DISPOSED', '$.semantics', 'semantic owner is disposed');};
  const dispose = (): void => {
    if (disposed) return;
    disposed = true; last = null; key = undefined;
    try {if (typeof subscription?.unsubscribe === 'function') subscription.unsubscribe();} finally {subscription = undefined; runtime.dispose();}
  };
  try {
    subscription = subscribeHost?.((node, action) => {
      live();
      if (running) throw new ProductionFrameError('E_HYA_RUNTIME_REENTRANT', '$.semantics.action', 'semantic actions cannot reenter publication');
      const target = last?.nodes.find(value => value.id === node);
      if (!target || target.state.disabled || !isAction(action) || !target.actions.includes(action))
        fail('$.semantics.action', 'action must address an enabled node in the committed snapshot');
      runtime.perform(node, action);
    });
    if (options.host && typeof subscription?.unsubscribe !== 'function') fail('$.semantics.host', 'action subscription must provide unsubscribe');
  } catch (error) {try {dispose();} catch (cleanup) {throw new AggregateError([error, cleanup], 'Semantic creation and cleanup failed');} throw error;}
  return Object.freeze({
    get snapshot() {return last;},
    update(value: Frame): Snapshot {
      live();
      if (running) throw new ProductionFrameError('E_HYA_RUNTIME_REENTRANT', '$.semantics.update', 'semantic update is already active');
      const frame = snapshotPlainTextData(value, '$.semantics.frame', (path, message) => fail(path, message), {strict: true, maxBytes: 64 * 1024 * 1024}) as unknown as Frame;
      if (!frame || typeof frame !== 'object' || Array.isArray(frame) || Object.keys(frame).some(k => !['revision', 'geometry', 'focused'].includes(k))
        || !Number.isSafeInteger(frame.revision) || frame.revision < 0 || !frame.geometry || typeof frame.geometry !== 'object' || Array.isArray(frame.geometry)
        || frame.focused !== undefined && typeof frame.focused !== 'string') fail('$.semantics.frame', 'invalid committed geometry frame');
      running = true;
      const token = runtime.captureFrame(); let committed = false;
      try {
        const raw = runtime.update(); live();
        const nodes = Object.freeze(raw.nodes.map(node => {
          const rect = frame.geometry[node.target];
          if (!Array.isArray(rect) || rect.length !== 4 || rect.some(n => typeof n !== 'number' || !Number.isFinite(n)) || rect[2]! < 0 || rect[3]! < 0)
            fail('$.semantics.geometry.' + node.target, 'visible semantic targets require finite nonnegative geometry');
          const actions = Object.freeze(node.actions.map(action => {if (!isAction(action)) fail('$.semantics.actions', 'unknown semantic action'); return action;}));
          return Object.freeze({...node, actions, state: Object.freeze({...node.state, focused: frame.focused === node.target}), bounds: Object.freeze([...rect]) as Rect});
        }));
        const nextKey = JSON.stringify([nodes, raw.readingOrder, raw.navigationOrder]);
        if (last && nextKey === key) {runtime.restoreFrame(token); committed = true; return last;}
        const announcements = Object.freeze((last ? raw.announcements : []).map(item => {
          if (item.mode !== 'polite' && item.mode !== 'assertive') fail('$.semantics.announcements', 'unknown announcement mode');
          return Object.freeze({...item, mode: item.mode as 'polite' | 'assertive'});
        }));
        const snapshot: Snapshot = Object.freeze({...raw, nodes, announcements});
        runtime.releaseFrame(token); committed = true; last = snapshot; key = nextKey;
        // Borrowed host callbacks run only after logical commit and cannot be replayed as a rollback.
        updateHost?.(snapshot);
        return snapshot;
      } catch (error) {
        if (!committed && !disposed) runtime.restoreFrame(token);
        throw error;
      } finally {running = false;}
    },
    dispose,
  });
}
