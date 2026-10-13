# Achievement rules and GPU GUI

Development candidate; not part of the published 0.2.1 registry package. See [API reference](../api/achievements.md).

Import `AchievementRuntime` and optionally `AchievementGui` from `@haiyue/extensions/achievements`. This capability does not import Native or initialize a platform SDK.

```ts
const runtime = new AchievementRuntime({
  definitionVersion: '1',
  profile: 'my-game/test/local/device-guest',
  definitions: [{ id: 'ten-wins', target: 10, titleKey: 'wins.title',
    descriptionKey: 'wins.description', rule: { kind: 'counter', event: 'won', field: 'count' } }],
  storage, // async read(key), atomic write(key, snapshot); one writer per profile
  port, // Native facade or structurally compatible contractVersion: 1 implementation
});
await runtime.initialize();
await runtime.record({ id: 'round-42', type: 'won', values: { count: 1 } });
await runtime.sync(); // explicit gameplay checkpoint, not the frame loop
```

`fact` unlocks a target of 1; `counter` adds a nonnegative safe integer and saturates; `best` takes the highest absolute value. The application evaluates complex conditions and sends a named fact. For time trials, send `fast-solve` only after validating the time, rather than treating a lower time as a higher score.

Retries reuse the same event ID. The default dedupe window remembers the last 256 IDs (configurable up to 10,000); events outside that window can count again. For longer replay histories, restore authoritative stats with `checkpoint({ 'ten-wins': 8 })`. Checkpoints raise values without replaying unlock toasts. This does not promise unlimited exactly-once delivery or combine additive counts across devices. Persist rewards separately with their own idempotency keys.

`snapshot()` returns a defensive copy. Storage errors leave the committed in-memory state unchanged. A rule/target/version change rejects an old save until `migrate(saved, empty)` returns a valid new snapshot. Changing text translations alone does not change rule semantics. `sync()` retries pending absolute progress; a durable receipt transfers responsibility to the platform facade, while errors retain the rule intent. Reporting defaults to a 10 s timeout; pending work and dedupe history are bounded. Subscribe to `error` or catch returned promises.

Create/dispose a runtime per account. Include game, environment, platform app ID and player identity in `profile`; fence an injected port against identity changes while storage work is pending. Never reuse guest facts to automatically grant a newly logged-in player achievements.

`AchievementGui(runtime, { parent, i18n, hiddenKey, lockedKey, unlockedKey })` attaches a scrollable GPU list and an unlock toast. Supply `syncKeys`, `imageLoader` and localized `iconKey` assets as needed. `toast: false` avoids duplicate banners when a platform also shows them. GUI text keys belong to the game; hidden names/descriptions/icons are not rendered before completion. Dispose the presenter/runtime on scene removal, or abort the presenter signal. `initialize()` must finish before constructing the presenter.

See [interactive example](../../examples/achievements/index.html) and [API decision](../for-ai/adr/0121-optional-achievements-runtime.md). Native's public Rubik integration uses first solve, ten solves, a timed 3×3 solve and a hidden mirror achievement. Automatic restore/undo does not count as a manually solved challenge.
