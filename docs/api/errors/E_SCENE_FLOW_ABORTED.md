# E_SCENE_FLOW_ABORTED

Preparation was cancelled by its signal, `cancel()`, prepared disposal, flow disposal, device loss or destruction of its target Scene. It cannot be committed. Pending resources and callbacks are retired; the existing active Scene is preserved.

Cancellation is an expected control path. Handle it without resubmitting the cancelled transaction. A factory that ignores its signal may finish later; a fresh Scene returned after cancellation is still destroyed. See [scene flow](../../../extensions/README.md#scene-flow-023-candidate).
