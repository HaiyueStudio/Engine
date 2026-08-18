export function resolveLocalPerformanceProfileId(config, nodePlatform, requestedProfile = '') {
  if (requestedProfile) {
    const profile = config.profiles[requestedProfile];
    if (!profile) throw new Error(`Unknown local WebGPU performance profile ${requestedProfile}.`);
    if (!(profile.match?.nodePlatforms ?? []).includes(nodePlatform)) {
      throw new Error(`Local WebGPU performance profile ${requestedProfile} does not run on ${nodePlatform}.`);
    }
    return requestedProfile;
  }
  const matches = Object.entries(config.profiles)
    .filter(([, profile]) => (profile.match?.nodePlatforms ?? []).includes(nodePlatform))
    .map(([id]) => id);
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) {
    throw new Error(`No local WebGPU performance profile is registered for ${nodePlatform}.`);
  }
  throw new Error(
    `Multiple local WebGPU performance profiles match ${nodePlatform}: ${matches.join(', ')}; `
    + 'set WEBGPU_DEVICE_PROFILE or pass --profile.',
  );
}
