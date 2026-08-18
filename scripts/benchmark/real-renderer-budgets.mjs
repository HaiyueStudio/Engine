export function resolveRealRendererStructuralBudgets(entityCount, dynamicRatio, viewCount) {
  const sceneFrameBytes = viewCount * 272;
  const mainDraws = (Math.ceil(entityCount * 2 / 7) + 5) * viewCount;
  // The shadow pass is camera-independent and restores stable object-table
  // slot order before direct instancing. The reference scene has one geometry
  // and compatible shadow pipeline, so traversal churn must not fragment it.
  const shadowDraws = dynamicRatio > 0 ? 1 : 0;
  const uploadCalls = dynamicRatio === 0
    ? viewCount
    : dynamicRatio <= 0.01
      ? interpolateEnrolledEntityBudget(entityCount, 6, 11) + viewCount
      : dynamicRatio <= 0.1
        ? interpolateEnrolledEntityBudget(entityCount, 11, 24) + viewCount
        : interpolateEnrolledEntityBudget(entityCount, 10, 10) + viewCount;
  const legacyUploadBytes = dynamicRatio === 0
    ? 0
    : dynamicRatio <= 0.01
      ? interpolateEnrolledEntityBudget(entityCount, 752, 4_416)
      : dynamicRatio <= 0.1
        ? interpolateEnrolledEntityBudget(entityCount, 5_984, 37_312)
        : interpolateEnrolledEntityBudget(entityCount, 46_432, 180_816);
  // Stage 10 deliberately added one 16-byte deformationFlags vec4 to the
  // Mesh3D and shadow object-table ABI. The slot counts below come from the
  // benchmark's gpuBufferLabel classification at the 256/1000 entity anchors;
  // Depth and PBR already carried the same flags in the legacy enrollment.
  // Keeping this cost separate makes future ABI growth reviewable instead of
  // hiding it in an unexplained upload-byte threshold.
  const deformationFlagsBytes = dynamicRatio === 0
    ? 0
    : dynamicRatio <= 0.01
      ? interpolateEnrolledEntityBudget(entityCount, 4 * 16, 11 * 16)
      : dynamicRatio <= 0.1
        ? interpolateEnrolledEntityBudget(entityCount, 33 * 16, 162 * 16)
        : interpolateEnrolledEntityBudget(entityCount, 257 * 16, 1_000 * 16);
  const uploadBytes = sceneFrameBytes + legacyUploadBytes + deformationFlagsBytes;
  const renderPasses = viewCount * 2 + (dynamicRatio > 0 ? 1 : 0);
  return Object.freeze({
    mainDraws,
    shadowDraws,
    totalDraws: mainDraws + shadowDraws,
    uploadCalls,
    uploadBytes,
    uploadBytesBreakdown: Object.freeze({
      sceneFrame: sceneFrameBytes,
      legacyObjectAndUniforms: legacyUploadBytes,
      deformationFlags: deformationFlagsBytes,
    }),
    renderPasses,
  });
}

export function resolvePlanarReflectionStructuralBudgets(
  entityCount,
  mirrorCount,
  maxBounces,
  viewCount,
) {
  const reflectionViews = Math.min(
    16,
    recursiveReflectionViewCount(mirrorCount, maxBounces, viewCount),
  );
  const sourceDrawsPerView = Math.ceil(entityCount * 2 / 7) + 6;
  // With two or more mirrors the benchmark's opposing clip planes retain at
  // most one transparent material lane in a reflected view. A single mirror
  // retains the complete reference scene.
  const reflectionDrawsPerView = mirrorCount === 1
    ? sourceDrawsPerView
    : Math.ceil(entityCount / 7) + 6;
  const shadowDraws = Math.ceil(entityCount / 1_000);
  const postProcessDraws = viewCount;
  const totalDraws =
    sourceDrawsPerView * viewCount
    + reflectionDrawsPerView * reflectionViews
    + shadowDraws
    + postProcessDraws;
  const entityScale = Math.max(0, Math.min(1, (entityCount - 1_000) / 9_000));
  const uploadCalls = Math.ceil(48 + entityScale * 48);
  // The 10K anchor is the exact post-Stage-10 label-classified total. The
  // previous 200,000-byte envelope absorbed all but 80 bytes of the deliberate
  // Mesh3D/shadow deformation ABI expansion; keep the deterministic boundary
  // exact so another object-record widening is visible.
  const uploadBytes = Math.ceil(50_000 + entityScale * 150_080);
  const renderPasses = reflectionViews + viewCount * 2 + 1;
  return Object.freeze({
    reflectionViews,
    totalDraws,
    uploadCalls,
    uploadBytes,
    renderPasses,
  });
}

/**
 * Structural budgets are enrolled at the smoke (256) and long (1000) fixtures.
 * Interpolation keeps fixed renderer costs visible instead of pretending every
 * upload scales linearly from zero entities.
 */
function interpolateEnrolledEntityBudget(
  entityCount,
  budgetAt256,
  budgetAt1000,
) {
  if (entityCount <= 256) return budgetAt256;
  return Math.ceil(
    budgetAt256
      + (entityCount - 256) * (budgetAt1000 - budgetAt256) / (1_000 - 256),
  );
}

function recursiveReflectionViewCount(mirrorCount, maxBounces, viewCount) {
  if (mirrorCount <= 0 || maxBounces <= 0 || viewCount <= 0) return 0;
  if (mirrorCount === 1) return viewCount;
  let count = 0;
  let depthViews = mirrorCount * viewCount;
  for (let depth = 0; depth < maxBounces && count < 16; depth++) {
    count += depthViews;
    depthViews *= mirrorCount - 1;
  }
  return count;
}
