export function selectReleaseQualification(matrix, id) {
  const path = matrix.qualificationPaths?.find(item => item.id === id);
  if (!path) throw new Error(`Unknown release qualification path: ${id ?? '(missing)'}`);
  for (const [ids, entries] of [[path.browserIds, matrix.browsers], [path.deviceClassIds, matrix.deviceClasses]]) {
    if (!Array.isArray(ids) || ids.length === 0 || new Set(ids).size !== ids.length
      || ids.some(id => !entries.some(entry => entry.id === id && entry.tier === 'required'))) {
      throw new Error(`Invalid release qualification path: ${path.id}`);
    }
  }
  return path;
}

export function validateLightingReleaseEvidence(result, matrix, identity) {
  const errors = [];
  let path;
  try { path = selectReleaseQualification(matrix, identity?.qualificationPath); }
  catch (error) { return [error.message]; }
  if (!/^[0-9a-f]{40}$/.test(identity.revision ?? '') || identity.dirty !== false) errors.push('formal lighting requires a clean Git revision');
  if (identity.runnerProfile !== path.runnerProfile) errors.push('formal lighting requires the registered release runner profile');
  if (identity.platform !== path.nodePlatform) errors.push('host platform does not match qualification path');
  if (identity.localConsole !== true) errors.push('formal lighting requires a local console session');
  if (!identity.hostname || !identity.operatingSystem || !identity.driver) errors.push('host, OS and driver identity are required');
  if (path.minimumOsMajor && !(Number(identity.osVersion?.split('.')[0]) >= path.minimumOsMajor)) errors.push('macOS version is below the release minimum');
  if (path.minimumOsBuild && !(Number(identity.osVersion?.split('.')[2]) >= path.minimumOsBuild)) errors.push('Windows build is below the release minimum');
  if (!identity.osVersion) errors.push('OS version is required');
  const browser = result.browserEvidence ?? {};
  if (browser.nativeBackend !== true || browser.angleBackend !== path.angleBackend) errors.push('native release graphics backend is required');
  if (!/^(?:Headless)?Chrome\/\d+/.test(browser.product ?? '')) errors.push('Chrome browser identity is required');
  const adapter = result.adapter ?? result.environment?.adapter;
  const name = adapter ? [adapter.vendor, adapter.architecture, adapter.device, adapter.description].join(' ') : '';
  if (!name.trim() || !new RegExp(path.adapterPattern, 'i').test(path.nodePlatform === 'win32' && /^amd$/i.test(adapter?.vendor ?? '') ? `${name} ${identity.driver}` : name)
    || /swiftshader|software|llvmpipe|lavapipe|warp|virtual|remote/i.test(name) || adapter?.isFallbackAdapter === true) {
    errors.push('a physical GPU matching the release path is required');
  }
  const config = result.configuration;
  if (config?.authoredLocalLightCount !== 128 || config?.dynamicRatio !== 1 || config?.viewCount !== 4
    || config?.overlap !== 'high' || config?.resolution?.id !== '720p' || !(result.timing?.rawSamples?.length >= 8)) {
    errors.push('formal lighting requires the full representative 128-light / four-view / 720p workload');
  }
  const gpu = result.metrics?.timing?.gpuTimestamp;
  if (gpu?.status === 'available' && !(gpu.value?.rawSamples?.length >= 2)) errors.push('formal lighting requires at least two GPU samples when timestamp-query is available');
  return errors;
}
