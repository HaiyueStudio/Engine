# E_CHARACTER_BODY_OWNERSHIP

A controller requires an existing Transform2D and an unclaimed kinematic box/circle Physics2DBody in the supplied Physics2DSystem's World. Dynamic bodies are never converted. Removed, replaced, disabled or destroyed targets release their controller registration at the next fixed step. Commands on a disposed controller reject.

Create the controller after attaching its entity and system to the same World. Dispose it before handing its body to another controller. The controller releases its own listener and restores an unchanged borrowed velocity; it never destroys the supplied entity, body, physics system or World. See [character2d](../../../extensions/README.md#character-2d-023-candidate).
