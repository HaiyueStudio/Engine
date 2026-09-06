import type { PostProcessFrameContext, PostProcessPass } from './PostProcessPass';
import { deferPostProcessDisposal } from './PostProcessSubmission';

export interface TaaHistory {
  readonly width: number;
  readonly height: number;
  readonly format: GPUTextureFormat;
  readonly colors: [GPUTexture, GPUTexture];
  readonly depths: [GPUTexture, GPUTexture];
  readonly colorViews: [GPUTextureView, GPUTextureView];
  readonly depthViews: [GPUTextureView, GPUTextureView];
  readonly bindGroups: [GPUBindGroup | null, GPUBindGroup | null];
  readonly bindGroupSources: [GPUTexture | null, GPUTexture | null];
  readonly bindGroupDepths: [GPUTexture | null, GPUTexture | null];
  readonly bindGroupMotions: [GPUTexture | null, GPUTexture | null];
  readonly previousViewProjection: Float32Array;
  readonly projection: Float32Array;
  readonly jitter: Float32Array;
  readonly uniformBuffer: GPUBuffer;
  readIndex: 0 | 1;
  valid: boolean;
  lastFrameId: number;
  lastSeenFrameId: number;
  cameraId: number;
  near: number;
  far: number;
  reverseZ: boolean;
  isOrthographic: boolean;
}

/** Per-view HDR color and full precision depth, with submission-safe retirement. */
export class TaaHistoryStore {
  readonly histories = new Map<string, TaaHistory>();
  private readonly retired = new Set<TaaHistory>();

  ensure(owner: PostProcessPass, device: GPUDevice, frame: PostProcessFrameContext, format: GPUTextureFormat, uniformBytes: number): TaaHistory {
    for (const [key, history] of this.histories) {
      if (key === frame.viewKey || (frame.frameId >= history.lastSeenFrameId && frame.frameId - history.lastSeenFrameId <= 120)) continue;
      this.retired.add(history);
      this.histories.delete(key);
    }
    const cached = this.histories.get(frame.viewKey);
    if (cached && cached.width === frame.width && cached.height === frame.height && cached.format === format) {
      cached.lastSeenFrameId = frame.frameId;
      this.flushRetired(owner);
      return cached;
    }
    if (cached) this.retired.add(cached);
    this.flushRetired(owner);
    const texture = (kind: string, index: number, textureFormat: GPUTextureFormat): GPUTexture => device.createTexture({
      label: `TaaPass.${frame.viewKey}.${kind}${index}`,
      size: [frame.width, frame.height], format: textureFormat,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    const colors: [GPUTexture, GPUTexture] = [texture('historyColor', 0, 'rgba16float'), texture('historyColor', 1, 'rgba16float')];
    const depths: [GPUTexture, GPUTexture] = [texture('historyDepth', 0, 'r32float'), texture('historyDepth', 1, 'r32float')];
    const history: TaaHistory = {
      width: frame.width, height: frame.height, format, colors, depths,
      colorViews: [colors[0].createView(), colors[1].createView()],
      depthViews: [depths[0].createView(), depths[1].createView()],
      bindGroups: [null, null], bindGroupSources: [null, null], bindGroupDepths: [null, null], bindGroupMotions: [null, null],
      previousViewProjection: new Float32Array(16), projection: new Float32Array(16), jitter: new Float32Array(2),
      uniformBuffer: device.createBuffer({ label: `TaaPass.${frame.viewKey}.params`, size: uniformBytes, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }),
      readIndex: 0, valid: false, lastFrameId: -1, lastSeenFrameId: frame.frameId, cameraId: -1,
      near: Number.NaN, far: Number.NaN, reverseZ: false, isOrthographic: false,
    };
    this.histories.set(frame.viewKey, history);
    return history;
  }

  destroy(owner: PostProcessPass): void {
    const histories = [...this.histories.values(), ...this.retired];
    this.histories.clear();
    this.retired.clear();
    const dispose = (): void => { for (const history of histories) destroyHistory(history); };
    if (!deferPostProcessDisposal(owner, dispose)) dispose();
  }

  private flushRetired(owner: PostProcessPass): void {
    if (this.retired.size === 0) return;
    const histories = [...this.retired];
    if (deferPostProcessDisposal(owner, () => { for (const history of histories) destroyHistory(history); })) this.retired.clear();
    // Direct apply() callers without a submission boundary retain old resources until destroy().
  }
}

function destroyHistory(history: TaaHistory): void {
  history.uniformBuffer.destroy();
  for (const texture of [...history.colors, ...history.depths]) texture.destroy();
}
