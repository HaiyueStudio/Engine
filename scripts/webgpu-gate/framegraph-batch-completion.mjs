import { armPolicy } from './framegraph-batch-policy.mjs';
const SLOT_BYTES = 2048, SLOTS = 8;
export function decodeTimestamps(ticks, labels, kinds) { if (ticks.length !== labels.length * 2 || ticks.length !== 6)
    throw Error('Expected three complete timestamped passes'); const passes = labels.map((label, i) => { if (ticks[2 * i + 1] <= ticks[2 * i])
    throw Error('Nonpositive GPU timestamp interval'); return { label, kind: kinds[i], durationMs: Number(ticks[2 * i + 1] - ticks[2 * i]) / 1e6 }; }); return { totalMs: passes.reduce((n, p) => n + p.durationMs, 0), spanMs: Number(ticks.at(-1) - ticks[0]) / 1e6, passes, passLabels: [...labels], timestampTicks: ticks.map(String) }; }
export function createBoundedFrameCompletion({ state, probe, runFrame, arm, now = () => performance.timeOrigin + performance.now() }) {
    const policy = armPolicy(arm);
    if (!probe.supported)
        throw Error('Diagnostic requires timestamp-query');
    const originalDevice = state.device;
    if (state.engine.device !== originalDevice)
        throw Error("Expected the original engine device; cannot isolate diagnostic wait");
    const queue = originalDevice.queue, descriptors = new Map(), savedProbe = { resolve: probe.resolve, readFrame: probe.readFrame };
    const originalSubmit = queue.submit, originalWait = queue.onSubmittedWorkDone;
    const result = { schemaVersion: 1, arm, performanceQualified: false, readbackBytes: SLOT_BYTES * SLOTS, readbackSlots: SLOTS, submitCalls: 0, queueWaitRequests: 0, nativeQueueWaitCalls: 0, engineQueueWaitCalls: 0, cleanupDrainCalls: 0, readbackMaps: 0, batchQueueWaitCalls: 0, inFlightCap: 8, peakInFlightUpperBound: 0, remainingInFlightUpperBound: 0, frames: [], readbacks: [], hooksRestored: false, destroyed: false };
    let current = null, pending = [], sequence = 0, closed = false, outstanding = 0;
    // Every arm uses the same ring capacity and GPU resolve/copy commands.
    probe.readbackBuffer.destroy();
    probe.readbackBuffer = state.device.createBuffer({ label: 'g09.sampling.readback-ring', size: SLOT_BYTES * SLOTS, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    function hook(name, fn) { descriptors.set(name, Object.getOwnPropertyDescriptor(queue, name)); Object.defineProperty(queue, name, { value: fn, configurable: true, writable: true }); }
    function restore() { for (const [name, desc] of descriptors) {
        if (desc)
            Object.defineProperty(queue, name, desc);
        else
            delete queue[name];
    } probe.resolve = savedProbe.resolve; probe.readFrame = savedProbe.readFrame; result.hooksRestored = true; }
    async function flush() {
        if (!pending.length)
            return null;
        const batch = pending, started = now(), batchIndex = result.readbacks.length;
        result.batchQueueWaitCalls++;
        await originalWait.call(queue);
        const fenceEnd = now();
        outstanding = 0;
        for (const item of batch)
            item.frame.completionObservedMs = fenceEnd;
        result.readbackMaps++;
        const mapStart = now();
        await probe.readbackBuffer.mapAsync(GPUMapMode.READ, 0, SLOT_BYTES * SLOTS);
        const mapped = now();
        try {
            const range = probe.readbackBuffer.getMappedRange(0, SLOT_BYTES * SLOTS);
            for (const item of batch) {
                const ticks = [...new BigUint64Array(range, item.slot * SLOT_BYTES, item.labels.length * 2)];
                const sample = decodeTimestamps(ticks, item.labels, item.kinds);
                Object.assign(item.frame, { passSumMs: sample.totalMs, spanMs: sample.spanMs, passes: sample.passes, timestampTicks: sample.timestampTicks, readbackBatchIndex: batchIndex });
                item.sample = sample;
            }
        }
        finally {
            probe.readbackBuffer.unmap();
        }
        const ended = now();
        result.readbacks.push({ index: batchIndex, firstSubmitMs: batch[0].frame.submitAtMs, lastSubmitMs: batch.at(-1).frame.submitAtMs, startMs: started, fenceEndMs: fenceEnd, fenceWaitMs: fenceEnd - started, mapStartMs: mapStart, mappedMs: mapped, endMs: ended, waitMs: mapped - mapStart, decodeMs: ended - mapped, frames: batch.map(x => x.frame.sequence) });
        pending = [];
        return batch.at(-1).sample;
    }
    try {
        hook('submit', function (buffers) { if (!current)
            throw Error('Submission outside diagnostic frame'); if (outstanding >= policy.inFlightCap)
            throw Error('In-flight frame cap exceeded'); outstanding++; current.inFlightUpperBound = outstanding; result.peakInFlightUpperBound = Math.max(result.peakInFlightUpperBound, outstanding); current.submitCalls++; current.submitAtMs = now(); result.submitCalls++; return originalSubmit.call(queue, buffers); });
        hook('onSubmittedWorkDone', function () { result.engineQueueWaitCalls++; return originalWait.call(queue); });
        probe.resolve = function (encoder) { if (this.queryCount !== 6)
            throw Error('Expected exactly three GPU passes'); this.pendingByteSize = this.queryCount * 8; encoder.resolveQuerySet(this.querySet, 0, this.queryCount, this.resolveBuffer, 0); encoder.copyBufferToBuffer(this.resolveBuffer, 0, this.readbackBuffer, current.slot * SLOT_BYTES, this.pendingByteSize); };
        probe.readFrame = async function () { pending.push({ frame: current, slot: current.slot, labels: [...this.passLabels], kinds: [...this.passKinds] }); if (pending.length === policy.readbackEvery)
            return flush(); return null; };
    }
    catch (e) {
        restore();
        probe.destroy();
        result.destroyed = true;
        throw e;
    }
    // The benchmark's explicit wait reads state.device; renderer and retirement callbacks
    // retain state.engine.device. Never suppress the queue's resource-retirement notifications.
    const explicitWait = async () => { if (!current)
        throw Error('Wait outside diagnostic frame'); result.queueWaitRequests++; current.queueWaitStartMs = now(); if (policy.queueWait) {
        result.nativeQueueWaitCalls++;
        await originalWait.call(queue);
        outstanding = 0;
    } current.queueWaitEndMs = now(); };
    const queueView = new Proxy(queue, { get(target, key) { if (key === 'onSubmittedWorkDone')
            return explicitWait; const v = Reflect.get(target, key, target); return typeof v === 'function' ? v.bind(target) : v; } });
    const deviceView = new Proxy(originalDevice, { get(target, key) { if (key === 'queue')
            return queueView; const v = Reflect.get(target, key, target); return typeof v === 'function' ? v.bind(target) : v; } });
    return { result, async runPhase(phase, count) { if (closed || !['warmup', 'measurement'].includes(phase) || !Number.isInteger(count) || count <= 0 || pending.length)
            throw Error('Invalid diagnostic phase'); const start = result.frames.length; for (let index = 0; index < count; index++) {
            current = { phase, index, sequence, slot: sequence % SLOTS, startMs: now(), submitCalls: 0 };
            sequence++;
            result.frames.push(current);
            state.device = deviceView;
            try {
                await runFrame(state, { gpuTimestampProbe: probe });
            }
            finally {
                state.device = originalDevice;
            }
            Object.assign(current, { endMs: now(), cpuMs: state.lastFrameTiming.runtimeFrameMs, queueWaitMs: state.lastFrameTiming.queueWaitMs });
            if (current.submitCalls !== 1)
                throw Error('Frame must have exactly one submission');
            current = null;
        } await flush(); return result.frames.slice(start); }, async close() { if (closed)
            return; closed = true; try {
            result.cleanupDrainCalls++;
            await originalWait.call(queue);
        }
        finally {
            outstanding = 0;
            result.remainingInFlightUpperBound = outstanding;
            restore();
            probe.destroy();
            result.destroyed = true;
        } }, };
}
