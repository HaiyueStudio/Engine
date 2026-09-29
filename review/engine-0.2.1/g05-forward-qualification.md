# G05 default Forward qualification

**Passed** for the current dirty candidate, not formal G07 release evidence. The [independent raw-file/budget audit](g05-forward-qualification.json) revalidates the complete 12-capture run, original G01 baseline hashes, served source/dist and unchanged configuration.

Each GPU/case has three interleaved cohorts, 120 warmup frames and 300 CPU plus 300 GPU samples per cohort, with at least 120 seconds of idle before each capture. All 24 pre/post host snapshots are speed/scheduler 100. No builds, tests or other GPU suites ran concurrently with these captures. The complete 3,600 CPU and 3,600 GPU samples are retained.

| Device / case | CPU P95 ms | Change vs G01 | GPU P95 ms | Change vs G01 |
| --- | ---: | ---: | ---: | ---: |
| AMD / 1 light | 0.950 | +1.06% | 0.753 | −0.13% |
| AMD / 8 lights | 0.955 | +1.60% | 1.422 | −0.19% |
| Intel / 1 light | 1.140 | +0.44% | 2.685 | +0.73% |
| Intel / 8 lights | 1.190 | +4.39% | 3.594 | −0.93% |

All eight channels satisfy the unchanged ≤5% regression ceiling and existing three-cohort spread/CV criteria. Every capture proves zero Deferred-specific buffer, texture, shader or pipeline creation and zero cleanup residue. No G01-only sub-millisecond exception is borrowed.

This protects the default small-light Forward path. Its legacy 8-light capacity does not establish equivalent-work multi-light Deferred acceleration. Full E/G room and F instance qualification, CPU object attribution, high-overlap costs and final audit remain separate G05 obligations.
