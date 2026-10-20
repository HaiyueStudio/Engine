import type { NarrativeRuntime } from './NarrativeRuntime';
import type { NarrativeActionRequest, NarrativeVariables } from './types';
export type NarrativeActionHandler = (request: NarrativeActionRequest, signal: AbortSignal) => Promise<NarrativeVariables | void> | NarrativeVariables | void;
export interface NarrativeActionConnection {
  readonly error: unknown;
  retry(): void;
  dispose(): void;
}
/** Explicit allowlist adapter. Hosts must durably deduplicate side effects using request.token. */
export function connectNarrativeActions(runtime: NarrativeRuntime, handlers: Readonly<Record<string, NarrativeActionHandler>>, options: { signal?: AbortSignal } = {}): NarrativeActionConnection {
  let dead = false, generation = 0, error: unknown;
  let controller: AbortController | undefined;
  let unsubscribe = () => {};
  const cancel = () => { generation++; controller?.abort(); };
  const run = () => {
    if (dead) return;
    cancel(); error = undefined;
    const request = runtime.view?.action;
    if (!request) return;
    const current = controller = new AbortController(), id = generation;
    // Deferral permits a handler to acknowledge without re-entering event delivery.
    void Promise.resolve().then(async () => {
      if (dead || id !== generation) return;
      const handler = Object.hasOwn(handlers, request.name) ? handlers[request.name] : undefined;
      if (!handler) throw new Error(`Unregistered narrative action: ${request.name}`);
      const result = await handler(request, current.signal);
      if (!dead && id === generation && !current.signal.aborted) runtime.completeAction(request.id, result ?? {});
    }).catch(cause => { if (!dead && id === generation && !current.signal.aborted) error = cause; });
  };
  const connection: NarrativeActionConnection = {
    get error() { return error; }, retry: run,
    dispose() { if (dead) return; dead = true; cancel(); unsubscribe(); options.signal?.removeEventListener('abort', connection.dispose); },
  };
  if (runtime.disposed || options.signal?.aborted) { dead = true; return connection; }
  unsubscribe = runtime.subscribe(event => {
    if (event.type === 'dispose') connection.dispose();
    else if (event.type === 'change') cancel();
    else if (event.type === 'action') run();
  });
  options.signal?.addEventListener('abort', connection.dispose, { once: true });
  run(); return connection;
}
