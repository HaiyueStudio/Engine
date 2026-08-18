import {
  Entity,
  PointLight,
  SphericalTransform3D,
  Transform3D,
} from '../../engine/dist/experimental.js';
import { PBR_MAX_LIGHTS } from '../../engine/dist/renderer.js';
import {
  LIGHTING_SCALING_FIXTURE_FORMAT,
  countLightingScalingOverlapsAtPoint,
  createLightingScalingCameraSample,
  sampleLightingScalingCameraReplay,
  sampleLightingScalingLocalLight,
} from './lighting-scaling-fixture.mjs';
import {
  addBilliards3DRealRendererContent,
  hasBilliardsPhysicsMotion,
} from './billiards-3d-real-renderer-content.mjs';

const BILLIARDS_SCENE_SCALE = 32;
const BILLIARDS_TABLE_HEIGHT = 18.2;

export function createLightingScalingRealRendererAdapter(
  fixture,
  sceneDocument = null,
) {
  return fixture === null || fixture === undefined
    ? null
    : new LightingScalingRealRendererAdapter(fixture, sceneDocument);
}

class LightingScalingRealRendererAdapter {
  constructor(fixture, sceneDocument) {
    if (fixture.format !== LIGHTING_SCALING_FIXTURE_FORMAT) {
      throw new TypeError('Invalid real-renderer lighting fixture.');
    }
    this.fixture = fixture;
    this.sceneDocument = sceneDocument;
    this.localLightTransforms = [];
    this.localLightPosition = new Float32Array(3);
    this.cameraTransforms = [];
    this.cameraSamples = [];
    this.replayFrame = 0;
    this.dynamicUpdates = 0;
    this.dynamicUpdatesBaseline = 0;
    this.sceneContent = null;
    this.world = null;
    this.overlapAtTableCenter =
      countLightingScalingOverlapsAtPoint(fixture, [0, 0, 0]);
  }

  get viewCount() {
    return this.fixture.viewCount;
  }

  get id() {
    return this.fixture.id;
  }

  get benchmarkIdentity() {
    return `lighting:${this.fixture.id}`;
  }

  assertViewCount(requestedViewCount) {
    if (requestedViewCount !== undefined
      && requestedViewCount !== this.fixture.viewCount) {
      throw new RangeError(
        'Real-renderer viewCount must match the lighting fixture.',
      );
    }
  }

  resolveTargets({ device, target, targets, createTarget }) {
    let resolvedTargets;
    let ownsTargets = false;
    if (targets) {
      resolvedTargets = [...targets];
    } else if (target) {
      if (this.viewCount !== 1) {
        throw new RangeError(
          'A multi-view lighting fixture requires one target per view.',
        );
      }
      resolvedTargets = [target];
    } else {
      ownsTargets = true;
      resolvedTargets = Array.from(
        { length: this.viewCount },
        () => createTarget(
          device,
          this.fixture.resolution.width,
          this.fixture.resolution.height,
        ),
      );
    }
    if (resolvedTargets.length !== this.viewCount) {
      throw new RangeError(
        `Real-renderer scenario requires ${this.viewCount} targets; `
        + `received ${resolvedTargets.length}.`,
      );
    }
    for (const candidate of resolvedTargets) {
      if (candidate.width !== this.fixture.resolution.width
        || candidate.height !== this.fixture.resolution.height) {
        throw new RangeError(
          `Lighting fixture ${this.fixture.id} requires `
          + `${this.fixture.resolution.width}x${this.fixture.resolution.height}; `
          + `received ${candidate.width}x${candidate.height}.`,
        );
      }
    }
    return { targets: resolvedTargets, ownsTargets };
  }

  async addSceneContent(world, mirrorCount) {
    if (mirrorCount !== 0) {
      throw new RangeError(
        'The billiards lighting scenario does not accept synthetic planar mirrors.',
      );
    }
    this.sceneContent = await addBilliards3DRealRendererContent(
      world,
      this.sceneDocument,
    );
    this.world = world;
    this.addLocalLights(world);
    return this.sceneContent;
  }

  updateScene(world, time, delta) {
    world.update(time, delta);
  }

  addLocalLights(world) {
    for (const descriptor of this.fixture.localLights) {
      const transform = new Transform3D().setTranslation(
        descriptor.position[0] * BILLIARDS_SCENE_SCALE,
        BILLIARDS_TABLE_HEIGHT
          + descriptor.position[1] * BILLIARDS_SCENE_SCALE,
        descriptor.position[2] * BILLIARDS_SCENE_SCALE,
      );
      this.localLightTransforms.push(transform);
      world.addEntity(new Entity(`real-${descriptor.id}`)
        .addComponent(transform)
        .addComponent(new PointLight({
          color: descriptor.color,
          range: descriptor.range * BILLIARDS_SCENE_SCALE,
          intensity: descriptor.intensity,
        })));
    }
  }

  createCameraTransform(viewIndex) {
    const sample = sampleLightingScalingCameraReplay(
      0,
      viewIndex,
      this.viewCount,
      createLightingScalingCameraSample(),
    );
    mapCameraSampleToBilliardsScene(sample);
    const transform = new SphericalTransform3D({
      radius: sample.radius,
      theta: sample.theta,
      phi: sample.phi,
      target: [sample.target[0], sample.target[1], sample.target[2]],
    });
    this.cameraTransforms.push(transform);
    this.cameraSamples.push(sample);
    return transform;
  }

  createCameraOptions() {
    return { near: 1, far: 3_000 };
  }

  createViewOptions(viewIndex) {
    const viewport = this.fixture.viewports[viewIndex];
    return {
      key: `${this.fixture.id}:view:${viewIndex}`,
      loadOp: 'clear',
      viewport,
      scissor: {
        x: viewport.x,
        y: viewport.y,
        width: viewport.width,
        height: viewport.height,
      },
    };
  }

  resetMetrics() {
    this.replayFrame = 0;
    this.applyReplayFrame(false);
    this.replayFrame = 0;
    this.dynamicUpdatesBaseline = this.dynamicUpdates;
  }

  applyReplayFrame(countDynamicUpdates = true) {
    const frame = this.replayFrame;
    for (let index = 0; index < this.cameraTransforms.length; index++) {
      const sample = sampleLightingScalingCameraReplay(
        frame,
        index,
        this.viewCount,
        this.cameraSamples[index],
      );
      mapCameraSampleToBilliardsScene(sample);
      this.cameraTransforms[index]
        .setTarget(sample.target[0], sample.target[1], sample.target[2])
        .set(sample.radius, sample.theta, sample.phi);
    }
    for (let index = 0; index < this.fixture.localLights.length; index++) {
      const descriptor = this.fixture.localLights[index];
      if (!descriptor.dynamic) continue;
      const position = sampleLightingScalingLocalLight(
        descriptor,
        frame,
        this.localLightPosition,
      );
      this.localLightTransforms[index].setTranslation(
        position[0] * BILLIARDS_SCENE_SCALE,
        BILLIARDS_TABLE_HEIGHT + position[1] * BILLIARDS_SCENE_SCALE,
        position[2] * BILLIARDS_SCENE_SCALE,
      );
      if (countDynamicUpdates) this.dynamicUpdates++;
    }
    this.replayFrame = (frame + 1) % this.fixture.cameraReplay.frameCount;
  }

  captureMetrics(render3d, frames) {
    if (!this.sceneContent || !this.world) {
      throw new Error('Lighting scenario metrics require loaded billiards content.');
    }
    const submittedLights = render3d._pbrSceneLightingContext.lights;
    const submittedAmbientLightCount =
      submittedLights.filter(light => light.type === 0).length;
    const submittedDirectionalLightCount =
      submittedLights.filter(light => light.type === 1).length;
    const submittedLocalLightCount =
      submittedLights.filter(light => light.type === 2).length;
    const submittedLightCount = submittedLights.length;
    const provenance = this.sceneContent.provenance;
    const authoredAmbientLightCount = provenance.ambientLightCount;
    const authoredDirectionalLightCount = provenance.directionalLightCount;
    const authoredTotalLightCount = this.fixture.localLightCount
      + authoredAmbientLightCount
      + authoredDirectionalLightCount;
    const rendererLocalLightCapacity = Math.max(
      0,
      PBR_MAX_LIGHTS
        - authoredAmbientLightCount
        - authoredDirectionalLightCount,
    );
    return {
      lightingFixtureId: this.fixture.id,
      lightingFixtureFormat: this.fixture.format,
      lightingSourceGame: this.fixture.sourceGame,
      lightingSceneRevision: this.fixture.sceneRevision,
      lightingCameraReplayId: this.fixture.cameraReplay.id,
      lightingCameraReplayFrameCount: this.fixture.cameraReplay.frameCount,
      lightingResolution: this.fixture.resolution.id,
      lightingWidth: this.fixture.resolution.width,
      lightingHeight: this.fixture.resolution.height,
      lightingViewCount: this.fixture.viewCount,
      lightingOverlap: this.fixture.overlap,
      lightingOverlapAtTableCenter: this.overlapAtTableCenter,
      lightingDynamicRatio: this.fixture.dynamicRatio,
      lightingDynamicLocalLightCount: this.fixture.dynamicLocalLightCount,
      lightingDynamicUpdatesPerFrame:
        (this.dynamicUpdates - this.dynamicUpdatesBaseline) / frames,
      authoredAmbientLightCount,
      authoredDirectionalLightCount,
      authoredLocalLightCount: this.fixture.localLightCount,
      authoredTotalLightCount,
      submittedAmbientLightCount,
      submittedDirectionalLightCount,
      submittedLightCount,
      submittedTotalLightCount: submittedLightCount,
      submittedLocalLightCount,
      unsubmittedTotalLightCount: Math.max(
        0,
        authoredTotalLightCount - submittedLightCount,
      ),
      unsubmittedLocalLightCount: Math.max(
        0,
        this.fixture.localLightCount - submittedLocalLightCount,
      ),
      rendererTotalLightCapacity: PBR_MAX_LIGHTS,
      rendererLocalLightCapacity,
      realContentProvenance: provenance,
      sourceSceneEntityCount: provenance.sourceSceneEntityCount,
      runtimeWorldEntityCount: this.world.entities.size,
      realContentMeshCount: provenance.meshCount,
      realContentGeometryCount: provenance.geometryCount,
      realContentMaterialCount: provenance.materialCount,
      realContentPhysicsBodyCount: provenance.physicsBodyCount,
      sourceSceneSkippedComponentCount: provenance.skippedComponentCount,
      sourceSceneIntentionallySkippedComponentCount:
        provenance.intentionallySkippedComponentCount,
      sourceSceneUnsupportedMaterialMeshCount:
        provenance.unsupportedMaterialMeshCount,
      sourceSceneUnsupportedMaterialAffectedEntityCount:
        provenance.unsupportedMaterialAffectedEntityCount,
      physicsSyncProbeEntity: this.sceneContent.physicsProbe.entityName,
      physicsSyncChanged3DTransform:
        hasBilliardsPhysicsMotion(this.sceneContent),
      rendererAbiChanged: false,
    };
  }
}

function mapCameraSampleToBilliardsScene(sample) {
  sample.radius *= BILLIARDS_SCENE_SCALE;
  sample.target[0] *= BILLIARDS_SCENE_SCALE;
  sample.target[1] = BILLIARDS_TABLE_HEIGHT
    + sample.target[1] * BILLIARDS_SCENE_SCALE;
  sample.target[2] *= BILLIARDS_SCENE_SCALE;
  return sample;
}
