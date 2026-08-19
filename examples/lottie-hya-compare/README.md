# Lottie → HYA comparison

The left pane converts the checked-in Lottie JSON to HYA and renders it through HaiYue WebGPU. The right pane renders the same JSON with the official MIT-licensed `lottie-web` SVG player. One shared clock drives both panes.

The example samples multiple reference frames to union the SVG content bounds, then applies the same automatic fit, user zoom, and pan to both views. Samples in `samples/` are original MIT-licensed HaiYue fixtures covering small and wide compositions.
