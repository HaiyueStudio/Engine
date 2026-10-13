# Achievements (development candidate)

Entry: `@haiyue/extensions/achievements`. Root exports remain unchanged. Declarations in `extensions/dist/achievements.d.ts` and the public export list are authoritative; this subpath is not yet published.

| API | Contract |
| --- | --- |
| `AchievementRuntime(options)` | Explicit profile/version, 1–1,000 definitions, storage and `contractVersion: 1` port. Supports `fact`, `counter`, `best`. |
| `initialize()` | Loads and validates the profile; await before all rule/UI work. Incompatible saves require `migrate`. |
| `record(fact)` | Atomically persists progress and event ID; resolves false for a retained duplicate. Values are nonnegative safe integers. |
| `checkpoint(values)` | Restores absolute, nondecreasing progress without replaying unlock events. |
| `sync()` | Sends pending absolute progress, validates durable receipts and saves sync state. Defaults to 10 s per report; errors retain intent. |
| `snapshot()` | Defensive copy of versioned records, pending flags and retained event IDs. |
| `subscribe(listener)` | `change`, `unlocked`, `sync`, `error`, `dispose`; returns unsubscribe. |
| `dispose()` | Stops observation and ignores late asynchronous results. Safe to repeat. |
| `AchievementGui(runtime, options)` | Optional scroll list/toast using Engine GUI and an injected I18n. `refresh()` and `dispose()` are explicit; changes also refresh through subscriptions. |

Invalid catalogs/profiles/versions/limits throw during construction. Invalid facts/checkpoints, full queues, storage failures, timeout and disposed operations reject or throw; callers should handle both synchronous precondition errors and rejected promises. No platform SDK or Engine instance is initialized merely by import. Game Center/Steam mapping belongs to the application and Native provider, not this extension.

Storage must atomically replace a snapshot and have one writer per profile. Defaults retain 256 event IDs and queue at most 256 operations (each configurable up to 10,000). This is bounded deduplication, not unlimited exactly-once history. Host code fences account changes and does not import guest history implicitly.

See [guide](../engine-guide/achievements.md), [example](../../examples/achievements/index.html), [decision](../for-ai/adr/0121-optional-achievements-runtime.md), and [API review](../../review/api/achievements-api.json).
