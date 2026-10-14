# Achievement lab

GPU GUI example for local facts, counters, best scores, hidden achievements, English/Chinese text and durable progress. Buttons simulate game facts; no real Steam/Game Center requests occur. `?verify=1` uses isolated memory, checks duplicate delivery and localized GUI rendering, and publishes a machine-readable result.

```sh
npm run build:target -- example:achievements
node scripts/verify-achievements-example.mjs
```

Normal mode stores the example profile in browser localStorage. Clear that example storage manually to restart the demonstration. No real platform reset API is exposed.
