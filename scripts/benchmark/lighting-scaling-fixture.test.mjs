import assert from 'node:assert/strict';
import test from 'node:test';

import {
  LIGHTING_SCALING_CAMERA_REPLAY,
  LIGHTING_SCALING_DYNAMIC_RATIOS,
  LIGHTING_SCALING_LOCAL_LIGHT_COUNTS,
  LIGHTING_SCALING_OVERLAPS,
  LIGHTING_SCALING_RESOLUTIONS,
  LIGHTING_SCALING_VIEW_COUNTS,
  countLightingScalingOverlapsAtPoint,
  createLightingScalingCameraSample,
  createLightingScalingFixtureConfiguration,
  createLightingScalingFixtureMatrix,
  sampleLightingScalingCameraReplay,
  sampleLightingScalingLocalLight,
} from './lighting-scaling-fixture.mjs';

test('lighting fixture enumerates the complete 216-case scale matrix', () => {
  const matrix = createLightingScalingFixtureMatrix();
  assert.equal(
    matrix.length,
    LIGHTING_SCALING_LOCAL_LIGHT_COUNTS.length
      * LIGHTING_SCALING_OVERLAPS.length
      * LIGHTING_SCALING_DYNAMIC_RATIOS.length
      * LIGHTING_SCALING_VIEW_COUNTS.length
      * LIGHTING_SCALING_RESOLUTIONS.length,
  );
  assert.equal(new Set(matrix.map(entry => entry.id)).size, matrix.length);
  assert.deepEqual(
    [...new Set(matrix.map(entry => entry.localLightCount))],
    [1, 8, 32, 128],
  );
  assert.deepEqual(
    [...new Set(matrix.map(entry => entry.overlap))],
    ['low', 'medium', 'high'],
  );
  assert.deepEqual(
    [...new Set(matrix.map(entry => entry.dynamicRatio))],
    [0, 0.25, 1],
  );
  assert.deepEqual(
    [...new Set(matrix.map(entry => entry.viewCount))],
    [1, 2, 4],
  );
  assert.deepEqual(
    [...new Set(matrix.map(entry => entry.resolution.id))],
    ['720p', '1080p'],
  );
  assert.ok(matrix.every(Object.isFrozen));
});

test('fixture generation and the 240-frame camera replay are deterministic', () => {
  const options = {
    localLightCount: 32,
    overlap: 'medium',
    dynamicRatio: 0.25,
    viewCount: 4,
    resolution: '1080p',
  };
  assert.deepEqual(
    createLightingScalingFixtureConfiguration(options),
    createLightingScalingFixtureConfiguration(options),
  );
  assert.equal(LIGHTING_SCALING_CAMERA_REPLAY.id, 'billiards-3d-lighting-camera-v1');
  assert.equal(LIGHTING_SCALING_CAMERA_REPLAY.frameCount, 240);

  const sample = createLightingScalingCameraSample();
  const first = sampleLightingScalingCameraReplay(0, 0, 4, sample);
  const firstValues = [
    first.radius,
    first.theta,
    first.phi,
    ...first.target,
  ];
  assert.equal(
    sampleLightingScalingCameraReplay(240, 0, 4, sample),
    sample,
    'sampling reuses caller scratch',
  );
  assert.deepEqual(
    [sample.radius, sample.theta, sample.phi, ...sample.target],
    firstValues,
    'the replay loops to the exact initial camera sample',
  );
  assert.deepEqual(
    [...sampleLightingScalingCameraReplay(-1, 0, 4, sample).target],
    [...sampleLightingScalingCameraReplay(239, 0, 4, sample).target],
  );
});

test('overlap profiles, dynamic selection and local-light motion stay fixed', () => {
  const configurations = LIGHTING_SCALING_OVERLAPS.map(overlap =>
    createLightingScalingFixtureConfiguration({
      localLightCount: 128,
      overlap,
      dynamicRatio: 0.25,
      viewCount: 1,
      resolution: '720p',
    }));
  const centerOverlaps = configurations.map(configuration =>
    countLightingScalingOverlapsAtPoint(configuration, [0, 0, 0]));
  assert.ok(centerOverlaps[0] < centerOverlaps[1]);
  assert.ok(centerOverlaps[1] < centerOverlaps[2]);
  assert.deepEqual(
    LIGHTING_SCALING_LOCAL_LIGHT_COUNTS.map(localLightCount =>
      createLightingScalingFixtureConfiguration({
        localLightCount,
        overlap: 'high',
        dynamicRatio: 0.25,
        viewCount: 1,
        resolution: '720p',
      }).dynamicLocalLightCount),
    [1, 2, 8, 32],
  );

  const dynamicLight = configurations[2].localLights.find(light => light.dynamic);
  const output = new Float32Array(3);
  const frameZero = [...sampleLightingScalingLocalLight(dynamicLight, 0, output)];
  assert.equal(
    sampleLightingScalingLocalLight(dynamicLight, 60, output),
    output,
  );
  assert.notDeepEqual([...output], frameZero);
  assert.deepEqual(
    [...sampleLightingScalingLocalLight(dynamicLight, 240, output)],
    frameZero,
  );
});

test('every 1/2/4 view keeps the selected 720p or 1080p workload', () => {
  for (const resolution of LIGHTING_SCALING_RESOLUTIONS) {
    for (const viewCount of LIGHTING_SCALING_VIEW_COUNTS) {
      const configuration = createLightingScalingFixtureConfiguration({
        localLightCount: 1,
        overlap: 'low',
        dynamicRatio: 0,
        viewCount,
        resolution: resolution.id,
      });
      assert.equal(configuration.viewports.length, viewCount);
      assert.ok(configuration.viewports.every(viewport =>
        viewport.x === 0
        && viewport.y === 0
        && viewport.width === resolution.width
        && viewport.height === resolution.height));
      assert.equal(
        configuration.viewports.reduce(
          (total, viewport) => total + viewport.width * viewport.height,
          0,
        ),
        resolution.width * resolution.height * viewCount,
      );
    }
  }
});

test('fixture rejects values outside the reviewed matrix', () => {
  assert.throws(
    () => createLightingScalingFixtureConfiguration({
      localLightCount: 16,
      overlap: 'high',
      dynamicRatio: 0.25,
      viewCount: 4,
      resolution: '1080p',
    }),
    /localLightCount/,
  );
  assert.throws(
    () => createLightingScalingFixtureConfiguration({
      localLightCount: 32,
      overlap: 'extreme',
      dynamicRatio: 0.25,
      viewCount: 4,
      resolution: '4k',
    }),
    /overlap/,
  );
});
