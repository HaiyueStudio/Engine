// Request the optional benchmark feature without changing the player's simple render profile.
const requestDevice = GPUAdapter.prototype.requestDevice;
GPUAdapter.prototype.requestDevice = function(options = {}) {
  const requiredFeatures = new Set(options.requiredFeatures ?? []);
  if (this.features.has('timestamp-query')) requiredFeatures.add('timestamp-query');
  return requestDevice.call(this, { ...options, requiredFeatures: [...requiredFeatures] });
};
await import('./bundle.js');
