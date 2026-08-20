/**
 * Experimental WebGPU compute ray-tracing capability.
 *
 * The namespace exports keep each owner boundary visible to consumers and
 * prevent this optional capability from leaking into the extensions root.
 */
export * as rayReference from './ray-tracing/reference/index.js';
export * as rayScene from './ray-tracing/scene/index.js';
export * as rayAcceleration from './ray-tracing/acceleration/index.js';
export * as rayTraversal from './ray-tracing/traversal/index.js';
export * as rayMaterial from './ray-tracing/material/index.js';
export * as rayPathTracing from './ray-tracing/renderer/index.js';
export * as raySampling from './ray-tracing/sampling/index.js';
export * as rayDenoise from './ray-tracing/denoise/index.js';
export * as rayHybrid from './ray-tracing/hybrid/index.js';
export * as rayWorker from './ray-tracing/worker/index.js';
export * as rayLifecycle from './ray-tracing/lifecycle/index.js';
