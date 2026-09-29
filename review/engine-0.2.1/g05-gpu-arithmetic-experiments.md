# G05 GPU candidate experiments — 2026-09-28

Status: **three rejected experiments, original runtime restored**.

1. Squared-distance/back-face rejection and integer power expansion.
2. Reciprocal-square-root normalization added to candidate 1.
3. A read-only uniform alias over the first 255 unchanged source records, with a storage suffix and no extra allocation/upload.

All retained the independent reference shader and passed native AMD/Intel A/B pixel and geometric boundary checks. Short room/AO captures did not establish sufficient Intel improvement. They are not paired/cooled performance qualifications; do not infer speedup from differences among these three-sample captures.

All experimental runtime changes were reverted, and the original generated artifact was restored through its generator. The exact previously validated runtime fingerprint is `6bb2179a2fd27d7893459dd4e52f1d9494d5f440d13ada872a327a04551d9c42`. Rejected runtime bundles and source variants remain archived under `artifacts/engine-0.2.1/g05/runtime-*`; raw captures/logs are hash indexed in [the experiment manifest](g05-gpu-arithmetic-experiments.json).

The first focus attempt stopped during capture 3's cooldown to test candidate 3. Its two completed full AMD captures and the incomplete failed cohort manifest are preserved; they cannot be spliced into the new attempt. The new full focus attempt starts again from cohort 1 on the restored runtime.

No production light/tile ABI, arithmetic, source upload, allocation, public API or performance budget changed in these trials. Full focus sampling uses the complete reference, separate 300 CPU/300 GPU populations, 120-frame warmups and 120-second cooling. This document makes no FPS or G05 completion claim.
