# E_GAMEPLAY_INVALID_INPUT

The scene-flow request or configuration is invalid. Concurrency must be an integer from 1 to 16 (default 4); maxRequests from 1 to 4096 (default 256). IDs and asset URLs must be nonempty. A factory must return a fresh, unowned Scene; active, inactive, destroyed and previously claimed scenes cannot be reused.

Correct the input before retrying. Request-shape and limit validation happens before replacing pending work. Once a valid request starts, it supersedes the prior preparation; later factory or resource failures preserve the active scene. Prepared commits are single-use. See [scene flow](../../../extensions/README.md#scene-flow-023-candidate).

Physics shape casts also reject nonfinite vectors, invalid dimensions, collision bits, durations and candidate limits. Character configuration requires a nonzero finite up vector, 1–16 slides, a finite slope angle from 0 to π/2, and finite nonnegative snap/margin distances. Correct these values before retrying; dimensions and clearance use render units at the public boundary. See [character2d](../../../extensions/README.md#character-2d-023-candidate).

Camera controllers require the original Camera2D and Transform2D, finite coordinates and bounds origins, finite nonnegative delta/damping/dead-zone dimensions/bounds dimensions/shake values, positive viewport dimensions and zoom, an invertible planar parent when parented, and interpolation alpha in [0,1]. A duplicate controller, missing/replaced component, conflicting 3D transform or disposed reset/shake operation is invalid. Correct the inputs before retrying; target and presentation use world/render units. See [camera2d](../../../extensions/README.md#camera-2d-023-candidate).
