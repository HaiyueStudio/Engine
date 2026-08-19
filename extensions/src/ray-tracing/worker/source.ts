export function createRayAccelerationWorkerSource(rayTracingModuleUrl: string): string {
  return `
const modulePromise = import(${JSON.stringify(rayTracingModuleUrl)});
const active = new Set();
const cancelled = new Set();
let runtimePromise = modulePromise.then(module => new module.RayAccelerationWorkerRuntime());
self.addEventListener('message', async event => {
  const request = event.data;
  if (!request || request.version !== 1 || typeof request.id !== 'number') return;
  if (request.type === 'cancel') { if (active.has(request.id)) cancelled.add(request.id); return; }
  active.add(request.id);
  try {
    const runtime = await runtimePromise;
    if (request.type === 'releaseRayAccelerationOwner') {
      const released = runtime.release(request.ownerId);
      if (!cancelled.delete(request.id)) self.postMessage({ version: 1, id: request.id, ok: true, value: { released } });
      return;
    }
    if (request.type !== 'buildRayAcceleration') return;
    const value = runtime.build(request.request);
    if (cancelled.delete(request.id)) return;
    const transfer = value.packed ? Object.values(value.packed.buffers).map(buffer => buffer.data) : [];
    self.postMessage({ version: 1, id: request.id, ok: true, value }, transfer);
  } catch (error) {
    if (cancelled.delete(request.id)) return;
    self.postMessage({ version: 1, id: request.id, ok: false, error: {
      name: 'EngineError', domain: 'worker', code: 'E_WORKER_PROTOCOL_INVALID',
      message: error instanceof Error ? error.message : String(error), recoverable: false,
      recovery: 'terminate-runtime', context: { requestType: request.type }, path: 'rayTracing.worker.runtime',
      cause: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : undefined,
    }});
  } finally { active.delete(request.id); cancelled.delete(request.id); }
});
self.addEventListener('close', async () => { (await runtimePromise).destroy(); });
`.trim();
}
