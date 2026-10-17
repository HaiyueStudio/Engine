/** Preserve measured cache activity before its owner retires diagnostic records. */
export function releaseChurnScope(tracker, scope, history) {
  retainOwnerCaches(tracker, scope.owner, history);
  scope.release();
}

export function releaseChurnOwner(tracker, owner, history) {
  retainOwnerCaches(tracker, owner, history);
  tracker.releaseOwner(owner);
}

function retainOwnerCaches(tracker, owner, history) {
  history.push(...tracker.getDebugSnapshot().caches.filter(cache => cache.owner === owner));
}

export function aggregateChurnCacheHistory(history) {
  const byLabel = new Map();
  for (const cache of history) {
    const current = byLabel.get(cache.label) ?? { label: cache.label, hits: 0, misses: 0, peakEntries: 0 };
    current.hits += cache.hits;
    current.misses += cache.misses;
    current.peakEntries = Math.max(current.peakEntries, cache.peakEntries);
    byLabel.set(cache.label, current);
  }
  return [...byLabel.values()].sort((a, b) => a.label.localeCompare(b.label));
}
