import assert from 'node:assert/strict';
import test from 'node:test';
import {
  Camera3D,
  Camera2D,
  CartesianTransform3D,
  Entity,
  FrameData,
  Transform2D,
  Transform3D,
  World,
} from '../dist/experimental.js';

function translationMatrix(x, y, z) {
  return new Float32Array([
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    x, y, z, 1,
  ]);
}

test('FrameData separates logical frame ids from phase revisions with opaque tokens', () => {
  const world = new World('FrameEpochWorld');
  const frame = new FrameData();
  const updateToken = frame.beginFrame(world, null, 10, 16);

  assert.equal(frame.frameId, 1);
  assert.equal(frame.phaseRevision, 1);
  assert.equal(frame.transforms.phaseRevision, 1);

  const renderToken = frame.advancePhase();
  assert.equal(frame.frameId, 1, 'advancing a phase must not create another logical frame');
  assert.equal(frame.phaseRevision, 2);
  assert.equal(frame.transforms.phaseRevision, 2);
  assert.notEqual(renderToken, updateToken);
  assert.throws(() => frame.useFrameToken(world, null, updateToken), /does not identify the active FrameData phase/);
  assert.equal(frame.useFrameToken(world, null, renderToken), frame);

  const otherFrame = new FrameData();
  otherFrame.beginFrame(world, null, 10, 16);
  const otherRenderToken = otherFrame.advancePhase();
  assert.notEqual(otherRenderToken, renderToken, 'tokens identify their owning FrameData without allocating objects');
  assert.throws(() => otherFrame.useFrameToken(world, null, renderToken), /does not identify the active FrameData phase/);

  frame.beginFrame(world, null, 26, 16);
  assert.equal(frame.frameId, 2);
  assert.equal(frame.phaseRevision, 3);
  assert.throws(() => frame.useFrameToken(world, null, renderToken), /does not identify the active FrameData phase/);
});

test('FrameData TransformStore computes hierarchy world matrices in typed arrays', () => {
  const world = new World('FrameWorld');
  const parent = new Entity('Parent').addComponent(new Transform3D());
  const child = new Entity('Child').addComponent(new Transform3D());
  parent.getComponent(Transform3D).localMatrix = translationMatrix(2, 0, 0);
  child.getComponent(Transform3D).localMatrix = translationMatrix(0, 3, 0);
  parent.addChild(child);
  world.addEntity(parent);

  const frame = new FrameData().begin(world, null, 1, 16);
  const parentMatrix = frame.transforms.getWorldMatrix(parent);
  const childMatrix = frame.transforms.getWorldMatrix(child);

  assert.equal(parentMatrix[12], 2);
  assert.equal(childMatrix[12], 2);
  assert.equal(childMatrix[13], 3);
  assert.notEqual(childMatrix, child.getComponent(Transform3D).worldMatrix);
  assert.equal(frame.transforms.getWorldVersion(child), child.getComponent(Transform3D).worldVersion);
});

test('TransformStore journals changed world versions for dirty transform subtrees', () => {
  const world = new World('TransformJournalWorld');
  const parentTransform = new Transform3D();
  const parent = new Entity('Parent').addComponent(parentTransform);
  const child = new Entity('Child').addComponent(new Transform3D().setTranslation(0, 2, 0));
  parent.addChild(child);
  world.addEntity(parent);
  const frame = world.frameData.begin(world, null, 0, 0);
  frame.transforms.getWorldMatrix(child);

  parentTransform.setTranslation(4, 0, 0);
  frame.begin(world, null, 1, 16);
  const changed = frame.transforms.flushDirtyWorldVersions();
  assert.deepEqual(new Set(changed), new Set([parent, child]));
  assert.equal(frame.transforms.getWorldMatrix(child)[12], 4);

  frame.begin(world, null, 2, 16);
  assert.equal(frame.transforms.flushDirtyWorldVersions().length, 0, 'the journal is phase-local and stable');
});

test('TransformStore visits overlapping dirty parent and child subtrees once', () => {
  const world = new World('OverlappingTransformJournalWorld');
  const parentTransform = new Transform3D();
  const childTransform = new Transform3D();
  const parent = new Entity('Parent').addComponent(parentTransform);
  const child = new Entity('Child').addComponent(childTransform);
  const grandchild = new Entity('Grandchild').addComponent(new Transform3D());
  child.addChild(grandchild);
  parent.addChild(child);
  world.addEntity(parent);
  const frame = world.frameData.begin(world, null, 0, 0);
  frame.transforms.getWorldMatrix(grandchild);

  parentTransform.setTranslation(1, 0, 0);
  childTransform.setTranslation(0, 2, 0);
  frame.begin(world, null, 1, 16);
  frame.transforms.flushDirtyWorldVersions();

  assert.equal(frame.transforms.lastDirtyTraversalCount, 3);
  assert.equal(frame.transforms.getWorldMatrix(grandchild)[12], 1);
  assert.equal(frame.transforms.getWorldMatrix(grandchild)[13], 2);
});

test('FrameData caches Camera3D view projection and frustum planes per frame', () => {
  const world = new World('CameraFrameWorld');
  const cameraEntity = new Entity('Camera').addComponent(new Transform3D()).addComponent(new Camera3D());
  cameraEntity.getComponent(Transform3D).localMatrix = translationMatrix(0, 0, 5);
  world.addEntity(cameraEntity);

  const frame = new FrameData().begin(world, null, 1, 16);
  const camera = cameraEntity.getComponent(Camera3D);
  const cameraFrame = frame.getCamera3D(cameraEntity, camera, { width: 800, height: 400, reverseZ: true });

  assert.equal(camera.aspect, 1, 'view aspect must not mutate the Camera component');
  assert.equal(camera.reverseZ, false, 'view depth convention must not mutate the Camera component');
  assert.equal(cameraFrame.width / cameraFrame.height, 2);
  assert.equal(cameraFrame.worldMatrix[14], 5);
  assert.equal(cameraFrame.viewProjectionMatrix.length, 16);
  assert.equal(cameraFrame.inverseViewProjectionMatrix.length, 16);
  assert.equal(cameraFrame.frustumPlanes.length, 24);
  assert.equal(frame.getCamera3D(cameraEntity, camera, { width: 800, height: 400, reverseZ: true }), cameraFrame);
});

test('FrameData applies view-local projection jitter without mutating Camera3D', () => {
  const world = new World('JitteredCameraFrameWorld');
  const cameraEntity = new Entity('Camera').addComponent(new Transform3D()).addComponent(new Camera3D());
  world.addEntity(cameraEntity);
  const frame = new FrameData().begin(world, null, 1, 16);
  const camera = cameraEntity.getComponent(Camera3D);
  const stableProjection = Float32Array.from(camera.projectionMatrix);

  const unjittered = Float32Array.from(frame.getCamera3D(cameraEntity, camera, {
    width: 800,
    height: 400,
  }).projectionMatrix);
  const jitteredFrame = frame.getCamera3D(cameraEntity, camera, {
    width: 800,
    height: 400,
    projectionJitter: [0.5, -0.25],
  });

  assert.notDeepEqual(Array.from(jitteredFrame.projectionMatrix), Array.from(unjittered));
  assert.deepEqual(Array.from(jitteredFrame.projectionJitter), [0.5, -0.25]);
  assert.deepEqual(Array.from(camera.projectionMatrix), Array.from(stableProjection));
  assert.equal(frame.getCamera3D(cameraEntity, camera, {
    width: 800,
    height: 400,
    projectionJitter: [0.5, -0.25],
  }), jitteredFrame);
  assert.throws(() => frame.getCamera3D(cameraEntity, camera, {
    width: 800,
    height: 400,
    projectionJitter: [Number.NaN, 0],
  }), /finite pixel offsets/);
});

test('TransformStore and Camera frame data reuse result objects across steady-state frames', () => {
  const world = new World('AllocationStableFrameWorld');
  const cameraEntity = new Entity('Camera')
    .addComponent(new Transform3D())
    .addComponent(new Camera3D());
  world.addEntity(cameraEntity);
  const frame = new FrameData().begin(world, null, 1, 16);
  const camera = cameraEntity.getComponent(Camera3D);
  const transformEntry = frame.transforms.getEntry(cameraEntity);
  const cameraFrame = frame.getCamera3D(cameraEntity, camera, 800, 400, true);

  for (let frameId = 2; frameId <= 100; frameId++) {
    frame.begin(world, null, frameId, 16);
    assert.equal(frame.transforms.getEntry(cameraEntity), transformEntry);
    assert.equal(frame.getCamera3D(cameraEntity, camera, 800, 400, true), cameraFrame);
  }

  assert.equal(frame.transforms.activeSlotCount, 1);
  assert.equal(frame.camera3DCacheSize, 1);
  assert.equal(cameraFrame.frameId, frame.frameId);
});

test('FrameData reclaims Transform slots and pools Camera entries during long entity churn', () => {
  const world = new World('FrameDataChurnWorld');
  const frame = new FrameData();
  const banks = [createCameraBank(24, 'A'), createCameraBank(24, 'B')];
  const seenCameraFrames = new Set();
  let activeBank = 0;

  for (const entity of banks[activeBank]) world.addEntity(entity);
  frame.begin(world, null, 1, 16);
  for (const entity of banks[activeBank]) {
    seenCameraFrames.add(frame.getCamera3D(entity, entity.getComponent(Camera3D), 640, 360, false));
  }
  const stableCapacity = frame.transforms.capacity;

  for (let cycle = 0; cycle < 500; cycle++) {
    for (const entity of banks[activeBank]) world.removeEntity(entity);
    activeBank ^= 1;
    for (const entity of banks[activeBank]) world.addEntity(entity);
    frame.begin(world, null, cycle + 2, 16);
    for (const entity of banks[activeBank]) {
      entity.getComponent(Transform3D).setTranslation(cycle & 7, 0, 0);
      seenCameraFrames.add(frame.getCamera3D(entity, entity.getComponent(Camera3D), 640, 360, (cycle & 1) === 0));
    }
    assert.equal(frame.transforms.capacity, stableCapacity);
    assert.equal(frame.transforms.activeSlotCount, 24);
    assert.equal(frame.camera3DCacheSize, 24);
  }

  assert.equal(seenCameraFrames.size, 24, 'camera frame objects should be recycled instead of growing with entity ids');
  for (const entity of banks[activeBank]) world.removeEntity(entity);
  frame.begin(world, null, 1000, 16);
  assert.equal(frame.transforms.activeSlotCount, 0);
  assert.equal(frame.camera3DCacheSize, 0);
  assert.equal(frame.pooledCamera3DCount, 24);
});

test('FrameData caches Camera2D view projection and 2D world matrices per frame', () => {
  const world = new World('Camera2DFrameWorld');
  const cameraEntity = new Entity('Camera2D')
    .addComponent(new Transform2D({ x: 10, y: 20 }))
    .addComponent(new Camera2D({ designWidth: 400, designHeight: 200 }));
  const sprite = new Entity('Sprite').addComponent(new Transform2D({ x: 5, y: 6 }));
  world.addEntity(cameraEntity);
  world.addEntity(sprite);

  const frame = new FrameData().begin(world, null, 1, 16);
  const camera = cameraEntity.getComponent(Camera2D);
  const cameraFrame = frame.getCamera2D(cameraEntity, camera, { width: 800, height: 400 });
  const spriteMatrix = frame.getWorldMatrix2D(sprite);

  assert.equal(camera.width, 400);
  assert.equal(camera.height, 200);
  assert.equal(cameraFrame.worldMatrix[12], 10);
  assert.equal(cameraFrame.worldMatrix[13], 20);
  assert.equal(cameraFrame.viewProjectionMatrix.length, 16);
  assert.equal(spriteMatrix[12], 5);
  assert.equal(spriteMatrix[13], 6);
  assert.equal(frame.getCamera2D(cameraEntity, camera, { width: 800, height: 400 }), cameraFrame);
  frame.begin(world, null, 2, 16);
  assert.equal(frame.getCamera2D(cameraEntity, camera, 800, 400), cameraFrame);
});

function createCameraBank(count, label) {
  return Array.from({ length: count }, (_, index) => new Entity(`${label}-${index}`)
    .addComponent(new Transform3D())
    .addComponent(new Camera3D()));
}

test('Transform components expose explicit local dirty versions', () => {
  const transform = new Transform3D();
  assert.equal(transform.localVersion, 0);
  transform.markDirty();
  assert.equal(transform.localVersion, 1);
  transform.setTranslation(1, 2, 3);
  assert.equal(transform.localVersion, 2);

  const cartesian = new CartesianTransform3D();
  const initial = cartesian.localVersion;
  cartesian.setPosition(1, 2, 3);
  assert.equal(cartesian.localVersion, initial + 1);
});

test('Transform3D world updates are driven by dirty versions', () => {
  const transform = new Transform3D();
  transform.setTranslation(1, 0, 0);
  transform.updateWorldMatrix();
  assert.equal(transform.worldMatrix[12], 1);
  const initialWorldVersion = transform.worldVersion;

  transform.updateWorldMatrix();
  assert.equal(transform.worldVersion, initialWorldVersion);

  transform.localMatrix[12] = 2;
  transform.updateWorldMatrix();
  assert.equal(transform.worldVersion, initialWorldVersion);
  assert.equal(transform.worldMatrix[12], 1);

  transform.markDirty();
  transform.updateWorldMatrix();
  assert.equal(transform.worldVersion, initialWorldVersion + 1);
  assert.equal(transform.worldMatrix[12], 2);
});
