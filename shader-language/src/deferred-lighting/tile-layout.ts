/** ADR 0109 fixed tile records. Diagnostic limits can reduce occupancy, never change stride. */
export const DEFERRED_TILE_LAYOUT = {
  tileSize: 16,
  workgroupSize: 64,
  capacity: 128,
  headerWords: 4,
  strideWords: 132,
  parameterBytes: 32,
  header: { offset: 0, acceptedCount: 1, overflow: 2, reserved: 3 },
} as const;
