# HYA production composition

The scene uses the focused `@haiyue/extensions/hya-player` entry, real licensed
font/image bytes, and explicit resource leases. `assets.json` pins their source,
license and hashes. Dispose the player before releasing its host resources.

`createHyaPlayer(source, {mode: 'render', scene, host, viewport, region})` can
borrow a region created by `scene.renderView.createRegion(...)`. The host owns
that region's bounds, visibility, update policy and disposal. Supply matching
logical viewport/GUI coordinates. Every producer in a regional pipeline must
have an explicit region, including continuous scene and overlay producers.
Committed paint changes invalidate the borrowed region; advancing an unchanged
clock reuses its pixels. Omitting `region` keeps ordinary direct drawing.

Native correctness, production pacing and physical input are separate evidence
channels; this example alone does not grant release qualification.
