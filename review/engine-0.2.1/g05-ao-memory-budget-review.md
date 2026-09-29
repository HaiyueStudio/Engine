# G05 AO memory budget finding

**Confirmed on AMD and Intel; unresolved.** The [hash-bound evidence](g05-ao-memory-budget-review.json) revalidates the frozen 1080p/128-light moving room with high-quality, full-resolution GTAO. Renderer output, reference/tiled pixel comparison and cleanup pass, but live Deferred allocations are **95,832,328 bytes (91.39 MiB)** against **67,108,864 bytes (64 MiB)** per view/generation. This is allocation overhead, not a leak or device validation error. Total tracked buffer/texture allocation is 171,569,124 bytes, retained separately; neither figure claims driver-resident memory.

## Attribution

| Owner | Bytes |
| --- | ---: |
| Three RGBA16F G-buffer targets + depth32float | 58,060,800 |
| Tile records | 4,308,480 |
| Shared source, view and parameters | 284,672 |
| AO visibility texture/buffer + two neutral buffers | 33,178,376 |

The AO value uses only the red half-float component, but currently persists all four RGBA16F channels in a full-resolution texture and padded storage buffer. The extra channels have no lighting meaning. Layered PBR already uses 16 sampled textures, so replacing the AO storage binding with another sampled texture would break the existing device-limit contract.

## Next implementation direction — not yet applied

1. Keep a half-float visibility value, the frozen AO lighting semantics, source quality settings, G-buffer formats and binding ownership. Change only the private AO visibility representation to single-channel R16F and decode the packed half-floats correctly for even/odd pixel positions and padded rows. CPU writer, all generated resolve/full-forward consumers and private layout-version evidence must change atomically through generators.
2. R16F alone is **insufficient**: the projected Deferred allocation is 70,949,128 bytes, still 3,840,264 bytes above the limit. Introduce a joint per-view plan that charges AO, G-buffer, tile storage and conservative shared overhead before allocating. Keep each stored tile's 128-index layout. Where less total tile storage fits, use the existing same-frame complete-view-list fallback for unstored tiles and expose its counts; no light truncation or hidden quality downgrade. Measure the extra lighting work separately.
3. Account for retained larger tile buffers when AO toggles on, pending/unsubmitted AO slots, four views and two target generations. Shrinking a logical plan must not pretend an older larger allocation disappeared. Reject requests beyond the frozen capacities before allocating; retire referenced resources only after submission completes.
4. Keep auxiliary depth/normal and public AO scratch storage visible in the full allocation inventory. Reuse these only where coverage and normal/depth semantics are proven identical; do not hide them under the Deferred subtotal.

This is a resource optimization within G05's existing outcome, but its private shader packing changes require the serial integration owner to synchronize the narrow write scope/contract before implementation. No budget, version, export, public quality setting or support promise is changed by this review.

## Required verification

- Packed visibility: odd widths, row alignment, neutral header, one/chained AO, all three algorithms; half-float precision and HDR/LDR parity.
- Current G04 AO direct/emissive/IBL/transmission/transparent semantics on both GPUs; source/tile overflow and default Forward guards.
- 720p/1080p, one/four views, toggle/resize, two pending generations, pre-submit destruction and zero residue; all actual records remain within frozen limits.
- Explicit fallback diagnostics and separate CPU/GPU costs; no claim that smaller tile storage is automatically faster.
- Generated-source, shader cost, typecheck/tests and native regression checks, followed by fresh qualification for the final runtime fingerprint.

Both failures and the new regression test are preserved. Cost capture files now contain a separate validation status so a successful image cannot be mistaken for budget acceptance. All 174 performance policy tests pass. Do not begin costly full E/F/G cohorts on a candidate already known to violate this memory contract.

## Follow-up — R16F implementation verified, 2026-09-28

The failure and unimplemented proposal above are historical. The [new checkpoint](g05-r16-checkpoint.md) verifies R16F storage plus joint AO/tile planning on both GPUs at runtime `ce94c512…`: the same workload now uses 66,869,272 Deferred bytes, within the unchanged per-view ceiling. Pending ownership, packed reads and G04 lighting semantics pass. Full-list fallback cost remains significant and performance qualification remains open; the original failed artifacts and this report's original JSON are preserved.
