# NavMesh multilayer conformance corpus

`navmesh-multilayer-corpus.json` is backend-neutral correctness evidence for the
future layered polygon NavMesh. It is deliberately not consumed by the current
Y-up heightfield `NavMesh`, which retains only the highest surface per planar
cell.

The corpus uses world-space XYZ points and an explicit normalized `up` vector.
Regions overlap freely in planar projection; elevation along `up` selects the
surface. Connectivity exists only through a declared portal, so projection
overlap, polygon proximity, bridge stacking, or a cave ceiling never creates an
implicit edge.

The test-only oracle resolves start, target, and dynamic obstacle points against
those regions, builds a directed portal graph, applies query-time portal and
obstacle blocking, and compares the resulting region/portal sequence with the
checked-in expectation. Dynamic obstacles inherit the layer of their resolved
surface and may only block portals incident to that layer.

The JSON is the reusable conformance input. Production backends should emit the
same status, start/target region identity, and portal sequence; they must not
call the oracle as their implementation.
