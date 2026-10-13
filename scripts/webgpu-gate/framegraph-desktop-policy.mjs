export function recordedLockIntervals(events, sessionId, endMs) {
    const selected = events.filter(e => Number(e.sessionId) === Number(sessionId)).sort((a, b) => Date.parse(a.timeUtc) - Date.parse(b.timeUtc));
    const intervals = [];
    let start = null;
    for (const e of selected) {
        const at = Date.parse(e.timeUtc);
        if (!Number.isFinite(at))
            throw Error('Invalid session event time');
        if (e.id === 4800) {
            if (start !== null)
                throw Error('Repeated lock without unlock');
            start = at;
        }
        else if (e.id === 4801 && start !== null) {
            if (at < start)
                throw Error('Invalid lock order');
            intervals.push({ startMs: start, endMs: at });
            start = null;
        }
    }
    if (start !== null)
        intervals.push({ startMs: start, endMs: Math.max(start, endMs) });
    return intervals;
}
export function lockOverlap(startMs, endMs, intervals) { if (!(endMs >= startMs))
    throw Error('Invalid observation range'); const ms = intervals.reduce((n, x) => n + Math.max(0, Math.min(endMs, x.endMs) - Math.max(startMs, x.startMs)), 0); return { recordedLockedMs: ms, classification: ms === 0 ? 'no-recorded-lock-overlap' : ms >= endMs - startMs ? 'locked-throughout' : 'lock-state-changed' }; }
export function desktopPreflightReasons(snapshot) {
    const reasons = [];
    if (snapshot.screenSaver.active === true && (snapshot.screenSaver.secure === true || Boolean(snapshot.screenSaver.executable)))
        reasons.push('Active screen saver; timeout ' + snapshot.screenSaver.timeoutSeconds + ' seconds' + (snapshot.screenSaver.secure ? ' with password protection' : ''));
    if (snapshot.machineInactivitySeconds > 0)
        reasons.push('Machine inactivity lock is configured: ' + snapshot.machineInactivitySeconds + ' seconds');
    if (snapshot.securityLogReadable !== true)
        reasons.push('Lock/unlock audit log is unavailable');
    if (snapshot.currentlyLocked === true)
        reasons.push('Current session is locked');
    if (snapshot.lockEventsSinceStart > 0)
        reasons.push('Session lock occurred during this run');
    return reasons;
}
