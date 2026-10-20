# Narrative · The Last Signal

A minimal GPU GUI story with three decisions and two endings. English/Chinese JSON packs reuse i18n;
illustrations are self-authored SVG assets. The runtime has no DOM dependency.

- Rescue: an action transfers control to the host's encounter state. Victory returns to the good ending; defeat reaches silence.
- Relay: spends a battery, changes trust, then reaches the good ending.
- Leave: reaches silence directly.
- Save/load can restore dialogue, choices, pending encounters and endings. New story uses a fresh run ID.
- The sample reward handler stores token/result in one localStorage entry, demonstrating host-owned idempotency.

```sh
npm run build -w ./extensions
npm run build:target -- example:narrative
```

Serve the Engine repository on localhost; open `examples/narrative/index.html`.
Add `?verify=1` for deterministic GUI pointer fixtures covering branches, two endings, pending-action restore,
host-state return, language/image switching and GPU validation. `#result` contains JSON; `#error` reports failure.
The verifier creates namespaced demonstration reward records in localStorage; it does not overwrite the manual save slot.

GUI and action adapters abort before Engine destruction. The host owns persistence, game states and side effects.
This is not a video player, narrative editor or Native-device acceptance result.

[Guide](../../docs/engine-guide/narrative.md) · [API](../../docs/api/narrative.md)
