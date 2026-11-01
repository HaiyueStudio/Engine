# E_PHYSICS_SHAPE_CAST_UNSUPPORTED

The selected backend does not provide a verified shape cast. Both the optional capability and driver method must be present. The original Box2D adapter supports the frozen box/circle subset. Existing custom drivers remain valid without these optional members; they cannot create a character controller until they implement the capability.

Choose a supported backend or use its original physics APIs. Character creation rejects before taking body ownership. A ray or AABB approximation is never substituted. See [character2d](../../../extensions/README.md#character-2d-023-candidate).
