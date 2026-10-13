export const ARMS = Object.freeze({ S8: Object.freeze({ queueWait: true, readbackEvery: 8, inFlightCap: 8 }), B8: Object.freeze({ queueWait: false, readbackEvery: 8, inFlightCap: 8 }) });
export function armPolicy(arm) { if (!Object.hasOwn(ARMS, arm))
    throw Error('Unknown batch arm: ' + arm); return ARMS[arm]; }
export function validateBoundedFrameCompletion(d, { arm, warmup, samples }) {
    const p = armPolicy(arm), n = warmup + samples, batches = Math.ceil(warmup / 8) + Math.ceil(samples / 8);
    if (d.arm !== arm || d.frames.length !== n || d.submitCalls !== n || d.queueWaitRequests !== n || d.nativeQueueWaitCalls !== (p.queueWait ? n : 0) || d.engineQueueWaitCalls !== n || d.batchQueueWaitCalls !== batches || d.cleanupDrainCalls !== 1)
        throw Error('Synchronization count mismatch');
    if (d.readbackMaps !== batches || d.readbacks.length !== batches || d.readbackBytes !== 16384 || d.readbackSlots !== 8 || d.inFlightCap !== 8)
        throw Error('Unequal ring or batch resources');
    if (d.peakInFlightUpperBound !== (p.queueWait ? 1 : Math.min(8, Math.max(warmup, samples))))
        throw Error('In-flight bound mismatch');
    let seq = 0, previous = null, lastGpuEnd = null;
    for (const [phase, count] of [['warmup', warmup], ['measurement', samples]]) {
        const ff = d.frames.filter(f => f.phase === phase);
        if (ff.length !== count)
            throw Error('Missing phase frames');
        for (let i = 0; i < count; i++) {
            const f = ff[i];
            if (f.sequence !== seq++ || f.index !== i || f.slot !== f.sequence % 8 || f.submitCalls !== 1 || f.passes?.length !== 3 || f.timestampTicks?.length !== 6)
                throw Error('Frame identity mismatch');
            if (!(f.endMs >= f.startMs && f.submitAtMs >= f.startMs && f.submitAtMs <= f.endMs && f.passSumMs > 0 && f.spanMs > 0 && f.inFlightUpperBound >= 1 && f.inFlightUpperBound <= 8))
                throw Error('Invalid frame or bound');
            if (previous && f.startMs < previous.endMs)
                throw Error('Overlapping host frame encoding');
            if (p.queueWait && f.inFlightUpperBound !== 1)
                throw Error('Serial control exceeded one outstanding frame');
            const ticks = f.timestampTicks.map(BigInt);
            if (Math.abs(Number(ticks[5] - ticks[0]) / 1e6 - f.spanMs) > 1e-9 || ticks.some((t, i) => i > 0 && t < ticks[i - 1]))
                throw Error('GPU span/order mismatch');
            if (lastGpuEnd !== null && ticks[0] < lastGpuEnd)
                throw Error('GPU timestamp order changed');
            lastGpuEnd = ticks[5];
            for (let j = 0; j < 3; j++)
                if (ticks[j * 2 + 1] <= ticks[j * 2] || Math.abs(Number(ticks[j * 2 + 1] - ticks[j * 2]) / 1e6 - f.passes[j].durationMs) > 1e-9)
                    throw Error('Timestamp decode mismatch');
            if (Math.abs(f.passes.reduce((s, x) => s + x.durationMs, 0) - f.passSumMs) > 1e-9)
                throw Error('Pass sum mismatch');
            const b = d.readbacks[f.readbackBatchIndex];
            if (!b?.frames.includes(f.sequence) || f.completionObservedMs !== b.fenceEndMs)
                throw Error('Unbound completion');
            previous = f;
        }
    }
    const expected = [];
    let first = 0;
    for (const count of [warmup, samples]) {
        for (let i = 0; i < count; i += 8)
            expected.push(Array.from({ length: Math.min(8, count - i) }, (_, j) => first + i + j));
        first += count;
    }
    let end = -Infinity;
    for (let i = 0; i < batches; i++) {
        const b = d.readbacks[i], ids = expected[i], ff = ids.map(j => d.frames[j]);
        if (b.index !== i || JSON.stringify(b.frames) !== JSON.stringify(ids))
            throw Error('Missing, repeated or cross-phase readback');
        if (!(b.firstSubmitMs === ff[0].submitAtMs && b.lastSubmitMs === ff.at(-1).submitAtMs && b.firstSubmitMs >= end && b.startMs >= b.lastSubmitMs && b.fenceEndMs >= b.startMs && b.mapStartMs >= b.fenceEndMs && b.mappedMs >= b.mapStartMs && b.endMs >= b.mappedMs))
            throw Error('Batch reused before completion');
        if (Math.abs(b.fenceWaitMs - (b.fenceEndMs - b.startMs)) > 1e-6 || Math.abs(b.waitMs - (b.mappedMs - b.mapStartMs)) > 1e-6)
            throw Error('Wait channel mismatch');
        end = b.endMs;
    }
    if (!d.destroyed || !d.hooksRestored || d.remainingInFlightUpperBound !== 0)
        throw Error('Incomplete cleanup');
    return true;
}
