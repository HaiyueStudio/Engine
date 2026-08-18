# HYA capability samples

`manifest.json` is the source of truth for the HYA sample browser. Every `.hya`
file has one unique primary capability so that format and runtime regressions can
be attributed to a focused fixture rather than a large showcase animation.

Regenerate all binary fixtures after editing `scripts/generate-samples.mjs`:

```sh
npm run samples:generate -w ./animation-spec
```

Open `/animation-spec/` through `npm run serve:examples:lan` after building the
`hya-samples` example. The browser also accepts remote HYA/JSON URLs and local
file uploads.

```sh
npm run build:target -- example:hya-samples example:hya-state-machine
npm run preview:target -- example:hya-samples
```

The manifest fixtures cover Tween/transform (`transform-position`), SpriteSheet
(`sprite-sheet-coin`), Path (`spatial-bezier`, `vector-trim-path`,
`vector-path-morph`) and Particle (`particle-emitter`). The independent
`example:hya-state-machine` target covers clips, parameters, transitions and
cross-fade. These targets are the runnable golden paths; documentation does not
copy their source into a second sample tree.

Image-backed samples keep their external payloads under `assets/`. The
`sprite-sheet-coin` fixture uses one 5×5 PNG atlas and one STEP `uvRectTrack`;
it deliberately does not expand the animation into 25 visibility-switched
nodes.

The `3D 视觉效果` category remains intentionally honest about HYA 1.0's 2D
runtime contract. `projected-wire-cube` and `perspective-card-flip` bake 3D
projection into topology-stable vector morph tracks, while `depth-tunnel`
builds perceived depth from phased 2D transforms. They do not imply a camera,
Z-buffer, perspective-correct texture sampling, or hidden-surface removal.

`lottie-precomp-layers` is generated from an actual Lottie `layers`/`assets`
graph instead of a hand-authored HYA node tree. The converter expands each
precomp instance into source-neutral HYA nodes and ordinary tracks while
retaining nested parent transforms, multiplicative opacity, in/out windows,
start time and time stretch. The web runtime therefore has no Lottie-specific
composition branch.
