import type { DirectionalLight } from '../lighting/DirectionalLight';
import { Frustum } from '../culling/Frustum';
import type { SceneFrameUniformSnapshot } from './SceneFrameUniformLayout';
import { SCENE_RENDER_MAX_LIGHTS, type PbrLightInfo } from './SceneLightData';

export interface SceneLightCandidate {
  readonly id: number;
  readonly info: PbrLightInfo;
  shadow: DirectionalLight | null;
}

export interface SceneLightSelectionStats {
  readonly candidateCount: number;
  readonly rejectedCount: number;
  readonly outsideViewCount: number;
  readonly eligibleCount: number;
  readonly selectedCount: number;
  readonly overflowCount: number;
  readonly replacementCount: number;
}

/** Bounded O(lights * 8) selection. Scores decide admission; IDs keep admitted slots stable. */
export class SceneLightSelection {
  private readonly _previous = new Set<number>();
  private readonly _selected: SceneLightCandidate[] = [];
  private readonly _scores: number[] = [];
  private readonly _frustum = new Frustum();
  private readonly _sphere = { center: [0, 0, 0] as [number, number, number], radius: 0 };

  select(
    candidates: readonly SceneLightCandidate[],
    shadows: readonly DirectionalLight[],
    output: PbrLightInfo[],
    pool: readonly PbrLightInfo[],
    view?: SceneFrameUniformSnapshot,
  ): SceneLightSelectionStats {
    const selected = this._selected, scores = this._scores;
    selected.length = scores.length = 0;
    let rejected = 0, outside = 0, eligible = 0;
    if (view) this._frustum.setFromViewProjection(view.data.subarray(0, 16));
    for (const shadow of shadows) {
      const candidate = candidates.find(light => light.shadow === shadow);
      if (candidate) selected.push(candidate);
    }
    const reserved = selected.length;
    scores.length = reserved;
    scores.fill(Infinity);
    for (const candidate of candidates) {
      const light = candidate.info;
      let score = lightEnergy(light);
      if (!(score > 0)) { rejected++; continue; }
      if (candidate.shadow && shadows.includes(candidate.shadow)) { eligible++; continue; }
      if (view && light.type === 2) {
        this._sphere.center = light.position;
        // A small conservative margin absorbs TAA subpixel movement at the boundary.
        this._sphere.radius = light.range * 1.01;
        if (!this._frustum.containsSphere(this._sphere)) { outside++; continue; }
        const distance = Math.hypot(
          light.position[0] - view.data[48]!,
          light.position[1] - view.data[49]!,
          light.position[2] - view.data[50]!,
        );
        // Approximate projected influence, not attenuation at the camera (which is not a receiver).
        const coverage = Math.min(1, light.range / Math.max(distance, 1e-6));
        score *= coverage * coverage;
      }
      eligible++;
      if (this._previous.has(candidate.id)) score *= 1.1;
      let index = reserved;
      while (index < selected.length && (scores[index]! > score
        || (scores[index] === score && selected[index]!.id < candidate.id))) index++;
      if (index >= SCENE_RENDER_MAX_LIGHTS) continue;
      selected.splice(index, 0, candidate);
      scores.splice(index, 0, score);
      selected.length = Math.min(selected.length, SCENE_RENDER_MAX_LIGHTS);
      scores.length = selected.length;
    }
    // Preserve shadow-map layer indices, then use an order independent of score fluctuations.
    const local = selected.splice(reserved).sort((a, b) => a.id - b.id);
    selected.push(...local);
    let replacements = 0;
    if (this._previous.size) for (const candidate of selected) if (!this._previous.has(candidate.id)) replacements++;
    this._previous.clear();
    output.length = 0;
    for (let index = 0; index < selected.length; index++) {
      const candidate = selected[index]!;
      this._previous.add(candidate.id);
      const info = pool[index]!;
      copyLight(info, candidate.info);
      output.push(info);
    }
    return {
      candidateCount: candidates.length, rejectedCount: rejected, outsideViewCount: outside,
      eligibleCount: eligible, selectedCount: selected.length,
      overflowCount: Math.max(0, eligible - selected.length), replacementCount: replacements,
    };
  }
}

/** Non-finite/negative radiance, invalid directions and nonpositive ranges never enter a shader. */
export function lightEnergy(light: PbrLightInfo): number {
  if (!Number.isFinite(light.intensity) || light.intensity <= 0
    || light.color.some(value => !Number.isFinite(value) || value < 0)) return 0;
  if (light.type === 1 && (!light.direction.every(Number.isFinite)
    || Math.hypot(...light.direction) < 1e-8)) return 0;
  if (light.type === 2 && (!Number.isFinite(light.range) || light.range <= 0
    || !light.position.every(Number.isFinite))) return 0;
  const energy = light.intensity * (0.2126 * light.color[0] + 0.7152 * light.color[1] + 0.0722 * light.color[2]);
  return Number.isFinite(energy) ? energy : 0;
}

export function createLightInfo(): PbrLightInfo {
  return { type: 0, color: [0, 0, 0], intensity: 0, direction: [0, -1, 0], position: [0, 0, 0], range: 10 };
}

function copyLight(out: PbrLightInfo, source: PbrLightInfo): void {
  out.type = source.type; out.intensity = source.intensity; out.range = source.range;
  for (let index = 0; index < 3; index++) {
    out.color[index] = source.color[index]!;
    out.direction[index] = source.direction[index]!;
    out.position[index] = source.position[index]!;
  }
}
