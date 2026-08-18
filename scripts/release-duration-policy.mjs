const MINIMUM_CATALOG_BUILD_TIMEOUT_MS = 1_200_000;
const CATALOG_ENTRY_BUILD_TIMEOUT_MS = 45_000;

export function releaseCatalogBuildTimeout(entryCount) {
  if (!Number.isSafeInteger(entryCount) || entryCount < 1) {
    throw new TypeError('Release catalog entry count must be a positive safe integer.');
  }
  return Math.max(
    MINIMUM_CATALOG_BUILD_TIMEOUT_MS,
    entryCount * CATALOG_ENTRY_BUILD_TIMEOUT_MS,
  );
}
