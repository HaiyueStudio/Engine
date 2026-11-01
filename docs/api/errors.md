# Gameplay flow and physics errors

These codes are introduced by the 0.2.3 candidate. Match `EngineError.code` rather than message text. Other runtime errors are listed in the [error index](errors/README.md).

<a id="e-gameplay-invalid-input"></a>
## E_GAMEPLAY_INVALID_INPUT

[Invalid scene-flow input](errors/E_GAMEPLAY_INVALID_INPUT.md): validate the request before changing the current transaction.

<a id="e-scene-flow-aborted"></a>
## E_SCENE_FLOW_ABORTED

[Cancelled preparation](errors/E_SCENE_FLOW_ABORTED.md): the active scene remains available; create a new request when needed.

<a id="e-scene-flow-superseded"></a>
## E_SCENE_FLOW_SUPERSEDED

[Replaced preparation](errors/E_SCENE_FLOW_SUPERSEDED.md): a newer generation owns the pending transition.

<a id="e-physics-shape-cast-unsupported"></a>
## E_PHYSICS_SHAPE_CAST_UNSUPPORTED

[Unsupported shape cast](errors/E_PHYSICS_SHAPE_CAST_UNSUPPORTED.md): the selected driver must provide the optional verified capability.

<a id="e-physics-query-limit"></a>
## E_PHYSICS_QUERY_LIMIT

[Query limit](errors/E_PHYSICS_QUERY_LIMIT.md): too many conservatively filtered candidates; no truncated result is returned.

<a id="e-character-body-ownership"></a>
## E_CHARACTER_BODY_OWNERSHIP

[Character body ownership](errors/E_CHARACTER_BODY_OWNERSHIP.md): supply an unclaimed kinematic body from the same physics world.

<a id="e-gui-collection-limit"></a>
## E_GUI_COLLECTION_LIMIT

[GUI collection limit](errors/E_GUI_COLLECTION_LIMIT.md): invalid geometry, stable identity, tree expansion, row lifecycle or bounded resource input.

<a id="e-audio-capability-unavailable"></a>
## E_AUDIO_CAPABILITY_UNAVAILABLE

[Audio capability unavailable](errors/E_AUDIO_CAPABILITY_UNAVAILABLE.md): initialize and probe the borrowed host before binding stereo emitters; use matching Engine/extensions candidates.
