export const LIGHTING_SCALING_FIXTURE_FORMAT =
  'haiyue-lighting-scaling-fixture@1';

export const LIGHTING_SCALING_LOCAL_LIGHT_COUNTS =
  Object.freeze([1, 8, 32, 128]);
export const LIGHTING_SCALING_OVERLAPS =
  Object.freeze(['low', 'medium', 'high']);
export const LIGHTING_SCALING_DYNAMIC_RATIOS =
  Object.freeze([0, 0.25, 1]);
export const LIGHTING_SCALING_VIEW_COUNTS =
  Object.freeze([1, 2, 4]);
export const LIGHTING_SCALING_RESOLUTIONS = Object.freeze([
  Object.freeze({ id: '720p', width: 1280, height: 720 }),
  Object.freeze({ id: '1080p', width: 1920, height: 1080 }),
]);

const LIGHT_COLORS = Object.freeze([
  Object.freeze([1, 0.38, 0.22]),
  Object.freeze([0.28, 0.58, 1]),
  Object.freeze([0.45, 1, 0.42]),
  Object.freeze([1, 0.78, 0.28]),
]);
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

/**
 * Versioned camera input shared by every lighting scale case. The terminal
 * keyframe is position-equivalent to frame zero so the 240-frame replay loops
 * without a camera discontinuity.
 */
export const LIGHTING_SCALING_CAMERA_REPLAY = Object.freeze({
  id: 'billiards-3d-lighting-camera-v1',
  fps: 60,
  frameCount: 240,
  keyframes: Object.freeze([
    cameraKeyframe(0, 17, -0.45, 1.08, [-0.8, 0.25, 0]),
    cameraKeyframe(48, 14.5, 0.35, 0.98, [0, 0.15, -0.3]),
    cameraKeyframe(96, 18.5, 1.35, 0.78, [0.75, 0.05, 0]),
    cameraKeyframe(144, 15.5, 2.65, 1.02, [0.2, 0.2, 0.4]),
    cameraKeyframe(192, 19, 4.25, 0.86, [-0.65, 0.1, 0.2]),
    cameraKeyframe(240, 17, Math.PI * 2 - 0.45, 1.08, [-0.8, 0.25, 0]),
  ]),
});

export function createLightingScalingFixtureMatrix() {
  const matrix = [];
  for (const localLightCount of LIGHTING_SCALING_LOCAL_LIGHT_COUNTS) {
    for (const overlap of LIGHTING_SCALING_OVERLAPS) {
      for (const dynamicRatio of LIGHTING_SCALING_DYNAMIC_RATIOS) {
        for (const viewCount of LIGHTING_SCALING_VIEW_COUNTS) {
          for (const resolution of LIGHTING_SCALING_RESOLUTIONS) {
            matrix.push(createLightingScalingFixtureConfiguration({
              localLightCount,
              overlap,
              dynamicRatio,
              viewCount,
              resolution: resolution.id,
            }));
          }
        }
      }
    }
  }
  return Object.freeze(matrix);
}

export function createLightingScalingFixtureConfiguration({
  localLightCount,
  overlap,
  dynamicRatio,
  viewCount,
  resolution,
}) {
  assertSupported(
    LIGHTING_SCALING_LOCAL_LIGHT_COUNTS,
    localLightCount,
    'localLightCount',
  );
  assertSupported(LIGHTING_SCALING_OVERLAPS, overlap, 'overlap');
  assertSupported(
    LIGHTING_SCALING_DYNAMIC_RATIOS,
    dynamicRatio,
    'dynamicRatio',
  );
  assertSupported(LIGHTING_SCALING_VIEW_COUNTS, viewCount, 'viewCount');
  const resolvedResolution = LIGHTING_SCALING_RESOLUTIONS.find(
    candidate => candidate.id === resolution,
  );
  if (!resolvedResolution) {
    throw new RangeError(
      `Unsupported lighting fixture resolution "${String(resolution)}".`,
    );
  }
  const localLights = createLightingScalingLocalLights({
    localLightCount,
    overlap,
    dynamicRatio,
  });
  const dynamicLocalLightCount = localLights.reduce(
    (total, light) => total + Number(light.dynamic),
    0,
  );
  const dynamicPercent = Math.round(dynamicRatio * 100);
  return Object.freeze({
    format: LIGHTING_SCALING_FIXTURE_FORMAT,
    id: `lighting.billiards-3d.${localLightCount}l.${overlap}.`
      + `${dynamicPercent}pct.${viewCount}v.${resolvedResolution.id}`,
    sourceGame: 'billiards-3d',
    sceneRevision: 'lighting-scale-v1',
    localLightCount,
    overlap,
    dynamicRatio,
    dynamicPercent,
    dynamicLocalLightCount,
    actualDynamicRatio: dynamicLocalLightCount / localLightCount,
    viewCount,
    resolution: resolvedResolution,
    viewports: createLightingScalingViewports(
      resolvedResolution.width,
      resolvedResolution.height,
      viewCount,
    ),
    cameraReplay: LIGHTING_SCALING_CAMERA_REPLAY,
    localLights,
  });
}

export function createLightingScalingCameraSample() {
  return {
    radius: 0,
    theta: 0,
    phi: 0,
    target: new Float32Array(3),
  };
}

export function sampleLightingScalingCameraReplay(
  frameIndex,
  viewIndex,
  viewCount,
  out,
) {
  if (!Number.isInteger(frameIndex)) {
    throw new TypeError('Lighting camera replay frameIndex must be an integer.');
  }
  if (!Number.isInteger(viewIndex) || viewIndex < 0 || viewIndex >= viewCount) {
    throw new RangeError(
      `Lighting camera replay viewIndex ${viewIndex} is outside ${viewCount} views.`,
    );
  }
  assertSupported(LIGHTING_SCALING_VIEW_COUNTS, viewCount, 'viewCount');
  const frame = positiveModulo(
    frameIndex,
    LIGHTING_SCALING_CAMERA_REPLAY.frameCount,
  );
  const keyframes = LIGHTING_SCALING_CAMERA_REPLAY.keyframes;
  let start = keyframes[0];
  let end = keyframes[1];
  for (let index = 1; index < keyframes.length; index++) {
    const candidate = keyframes[index];
    if (frame < candidate.frame) {
      end = candidate;
      break;
    }
    start = candidate;
  }
  const alpha = (frame - start.frame) / (end.frame - start.frame);
  const viewOffset = viewIndex - (viewCount - 1) * 0.5;
  out.radius = interpolate(start.radius, end.radius, alpha);
  out.theta = interpolate(start.theta, end.theta, alpha)
    + viewOffset * 0.055;
  out.phi = interpolate(start.phi, end.phi, alpha);
  out.target[0] = interpolate(start.target[0], end.target[0], alpha)
    + viewOffset * 0.08;
  out.target[1] = interpolate(start.target[1], end.target[1], alpha);
  out.target[2] = interpolate(start.target[2], end.target[2], alpha);
  return out;
}

export function sampleLightingScalingLocalLight(
  light,
  frameIndex,
  out,
) {
  if (!light.dynamic) {
    out[0] = light.position[0];
    out[1] = light.position[1];
    out[2] = light.position[2];
    return out;
  }
  const time = positiveModulo(
    frameIndex,
    LIGHTING_SCALING_CAMERA_REPLAY.frameCount,
  ) / LIGHTING_SCALING_CAMERA_REPLAY.fps;
  const angle = light.motion.phase + time * light.motion.angularSpeed;
  out[0] = light.position[0] + Math.sin(angle) * light.motion.amplitude;
  out[1] = light.position[1]
    + Math.sin(angle * 0.5) * light.motion.verticalAmplitude;
  out[2] = light.position[2] + Math.cos(angle) * light.motion.amplitude;
  return out;
}

export function countLightingScalingOverlapsAtPoint(
  configuration,
  point,
) {
  let overlaps = 0;
  for (const light of configuration.localLights) {
    const dx = light.position[0] - point[0];
    const dy = light.position[1] - point[1];
    const dz = light.position[2] - point[2];
    if (dx * dx + dy * dy + dz * dz <= light.range * light.range) {
      overlaps++;
    }
  }
  return overlaps;
}

function createLightingScalingLocalLights({
  localLightCount,
  overlap,
  dynamicRatio,
}) {
  const profile = overlap === 'low'
    ? { radius: 13, radiusStep: 2.4, range: 3.5, motion: 0.8 }
    : overlap === 'medium'
      ? { radius: 6, radiusStep: 0.7, range: 9, motion: 1.1 }
      : { radius: 2.2, radiusStep: 0.18, range: 18, motion: 1.6 };
  const dynamicStride = dynamicRatio === 0.25 ? 4 : 1;
  const lights = new Array(localLightCount);
  for (let index = 0; index < localLightCount; index++) {
    const ring = Math.floor(index / 16);
    const angle = index * GOLDEN_ANGLE;
    const radius = profile.radius + ring * profile.radiusStep;
    const dynamic = dynamicRatio === 1
      || (dynamicRatio === 0.25 && index % dynamicStride === 0);
    lights[index] = Object.freeze({
      id: `local-light:${String(index).padStart(3, '0')}`,
      position: Object.freeze([
        Math.sin(angle) * radius,
        2.25 + (index % 5) * 0.32,
        Math.cos(angle) * radius,
      ]),
      color: LIGHT_COLORS[index % LIGHT_COLORS.length],
      intensity: 0.62 + (index % 3) * 0.08,
      range: profile.range,
      dynamic,
      motion: Object.freeze({
        phase: angle * 0.5,
        angularSpeed: 0.55 + (index % 7) * 0.035,
        amplitude: profile.motion,
        verticalAmplitude: profile.motion * 0.22,
      }),
    });
  }
  return Object.freeze(lights);
}

function createLightingScalingViewports(width, height, viewCount) {
  const viewports = new Array(viewCount);
  for (let index = 0; index < viewCount; index++) {
    viewports[index] = Object.freeze({
      x: 0,
      y: 0,
      width,
      height,
      minDepth: 0,
      maxDepth: 1,
    });
  }
  return Object.freeze(viewports);
}

function cameraKeyframe(frame, radius, theta, phi, target) {
  return Object.freeze({
    frame,
    radius,
    theta,
    phi,
    target: Object.freeze(target),
  });
}

function interpolate(start, end, alpha) {
  return start + (end - start) * alpha;
}

function positiveModulo(value, divisor) {
  return ((value % divisor) + divisor) % divisor;
}

function assertSupported(values, value, label) {
  if (!values.includes(value)) {
    throw new RangeError(
      `Unsupported lighting fixture ${label} "${String(value)}".`,
    );
  }
}
