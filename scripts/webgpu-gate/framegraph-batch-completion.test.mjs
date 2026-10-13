import test from 'node:test';
import assert from 'node:assert/strict';
import { ARMS, validateBoundedFrameCompletion } from './framegraph-batch-policy.mjs';
import { createBoundedFrameCompletion } from './framegraph-batch-completion.mjs';
globalThis.GPUBufferUsage = { COPY_DST: 1, MAP_READ: 2 };
globalThis.GPUMapMode = { READ: 1 };
const tick = () => new Promise(r => setImmediate(r));
function fixture({ manual = false, rejectMap = false, rejectFence = false, throwAfterSubmit = false } = {}) {
    let t = 1000, frame = 0, submitted = 0, nativeWaits = 0, maps = 0, jobs = [], waiters = [];
    const resources = [];
    function complete() { const work = jobs; const waiting = waiters; jobs = []; waiters = []; for (const job of work)
        job(); for (const done of waiting)
        done(); }
    const queue = { submit(buffers) { submitted++; jobs.push(...buffers); }, onSubmittedWorkDone() { nativeWaits++; if (rejectFence && nativeWaits === 9)
            return Promise.reject(Error('injected batch fence failure')); const p = new Promise(r => waiters.push(r)); if (!manual)
            queueMicrotask(complete); return p; } };
    const originalSubmit = queue.submit, originalWait = queue.onSubmittedWorkDone;
    const device = { queue, createBuffer({ size }) { const b = { data: new ArrayBuffer(size), mapped: false, destroyed: false, async mapAsync() { maps++; assert.equal(jobs.length, 0, 'Map before queue fence'); if (rejectMap)
                throw Error('injected map failure'); b.mapped = true; }, getMappedRange() { assert.equal(b.mapped, true); return b.data; }, unmap() { b.mapped = false; }, destroy() { b.destroyed = true; } }; resources.push(b); return b; } };
    const probe = { supported: true, queryCount: 6, passLabels: ['scene', 'post', 'output'], passKinds: ['render', 'render', 'render'], readbackBuffer: device.createBuffer({ size: 2048 }), resolveBuffer: {}, querySet: {}, resolve() { }, readFrame() { }, destroy() { this.readbackBuffer.destroy(); } };
    const originalResolve = probe.resolve, originalRead = probe.readFrame, state = { device, engine: { device }, lastFrameTiming: null };
    async function runFrame(s, { gpuTimestampProbe: p }) { frame++; const current = frame; let job; p.resolve({ resolveQuerySet() { }, copyBufferToBuffer(_src, _off, dst, off) { assert.equal(dst.mapped, false); job = () => { assert.equal(dst.mapped, false); new BigUint64Array(dst.data, off, 6).set([0n, 100n, 200n, 300n, 400n, 500n].map(x => x + BigInt(current) * 1000n)); }; } }); queue.submit([job]); void queue.onSubmittedWorkDone().catch(() => { }); if (throwAfterSubmit)
        throw Error('injected render failure'); await s.device.queue.onSubmittedWorkDone(); await p.readFrame(); s.lastFrameTiming = { runtimeFrameMs: 1, queueWaitMs: 1 }; }
    return { state, probe, runFrame, now: () => t += .1, complete, counts: () => ({ submitted, nativeWaits, maps }), verify() { assert.equal(state.device, device); assert.equal(queue.submit, originalSubmit); assert.equal(queue.onSubmittedWorkDone, originalWait); assert.equal(probe.resolve, originalResolve); assert.equal(probe.readFrame, originalRead); assert.ok(resources.every(b => b.destroyed)); assert.equal(jobs.length, 0); } };
}
for (const arm of Object.keys(ARMS))
    test(arm + ' retains timestamps across wrapped slots and partial phase tails', async () => {
        const f = fixture(), s = createBoundedFrameCompletion({ ...f, arm });
        try {
            await s.runPhase('warmup', 5);
            await s.runPhase('measurement', 19);
        }
        finally {
            await s.close();
        }
        validateBoundedFrameCompletion(s.result, { arm, warmup: 5, samples: 19 });
        f.verify();
        assert.equal(f.counts().maps, 4);
        assert.equal(f.counts().nativeWaits, 24 + (ARMS[arm].queueWait ? 24 : 0) + 4 + 1);
        assert.deepEqual(s.result.frames.map(f => f.timestampTicks[0]), Array.from({ length: 24 }, (_, i) => String((i + 1) * 1000)));
        assert.equal(s.result.peakInFlightUpperBound, arm === 'S8' ? 1 : 8);
        const broken = structuredClone(s.result);
        broken.readbacks[1].frames[0] = 0;
        assert.throws(() => validateBoundedFrameCompletion(broken, { arm, warmup: 5, samples: 19 }), /Unbound|repeated/);
        const reused = structuredClone(s.result);
        reused.readbacks[1].firstSubmitMs = reused.readbacks[0].endMs - 1;
        assert.throws(() => validateBoundedFrameCompletion(reused, { arm, warmup: 5, samples: 19 }), /reused/);
        const unbound = structuredClone(s.result);
        unbound.frames[3].completionObservedMs++;
        assert.throws(() => validateBoundedFrameCompletion(unbound, { arm, warmup: 5, samples: 19 }), /Unbound/);
    });
test('B8 cannot submit a ninth frame while its first completion fence is unresolved', async () => { const f = fixture({ manual: true }), s = createBoundedFrameCompletion({ ...f, arm: 'B8' }); const running = s.runPhase('measurement', 17); await tick(); assert.equal(f.counts().submitted, 8); assert.equal(f.counts().maps, 0); await tick(); assert.equal(f.counts().submitted, 8); f.complete(); await tick(); assert.equal(f.counts().submitted, 16); assert.equal(f.counts().maps, 1); f.complete(); await tick(); assert.equal(f.counts().submitted, 17); f.complete(); await running; const closing = s.close(); f.complete(); await closing; validateBoundedFrameCompletion(s.result, { arm: 'B8', warmup: 0, samples: 17 }); f.verify(); });
for (const [option, message] of [['rejectMap', 'map'], ['rejectFence', 'batch fence'], ['throwAfterSubmit', 'render']])
    test(option + ' drains submitted work and restores borrowed hooks', async () => { const f = fixture({ [option]: true }), s = createBoundedFrameCompletion({ ...f, arm: 'B8' }); await assert.rejects(s.runPhase('measurement', 8), new RegExp('injected ' + message + ' failure')); await s.close(); await s.close(); f.verify(); assert.equal(s.result.cleanupDrainCalls, 1); });
