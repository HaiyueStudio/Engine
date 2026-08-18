import type { SceneCreateOptions, SceneOptions, ScenePreset } from './SceneContracts';

export type SceneSystemRole = 'render3d' | 'render2d' | 'gui';

export interface ScenePresetDefinition {
  readonly name: string;
  readonly camera: '3d' | '2d';
  readonly systems: readonly SceneSystemRole[];
}

export const SCENE_PRESETS = Object.freeze({
  '3d': Object.freeze({ name: 'Scene3D', camera: '3d', systems: ['render3d'] as const }),
  '2d': Object.freeze({ name: 'Scene2D', camera: '2d', systems: ['render2d'] as const }),
  gui: Object.freeze({ name: 'GuiScene', camera: '3d', systems: ['gui'] as const }),
  mixed: Object.freeze({ name: 'MixedScene', camera: '3d', systems: ['render3d', 'render2d', 'gui'] as const }),
}) satisfies Readonly<Record<ScenePreset, ScenePresetDefinition>>;

/** Converts a named preset into ordinary SceneOptions; Scene never branches on preset names. */
export function normalizeSceneOptions(input: SceneCreateOptions = {}): SceneOptions {
  if (typeof input !== 'string') return input;
  const preset: ScenePresetDefinition = SCENE_PRESETS[input];
  return {
    name: preset.name,
    camera: { type: preset.camera },
    render3D: preset.systems.includes('render3d'),
    render2D: preset.systems.includes('render2d'),
    gui: preset.systems.includes('gui'),
  };
}

export interface SceneSystemPlanEntry {
  readonly role: SceneSystemRole;
  readonly option: SceneOptions['render3D'] | SceneOptions['render2D'] | SceneOptions['gui'];
}

/** A data-only installation plan, independently testable from World and GPU setup. */
export function createSceneSystemPlan(options: SceneOptions): readonly SceneSystemPlanEntry[] {
  const plan: SceneSystemPlanEntry[] = [];
  if (options.render3D !== false) plan.push({ role: 'render3d', option: options.render3D });
  if (options.render2D) plan.push({ role: 'render2d', option: options.render2D });
  if (options.gui) plan.push({ role: 'gui', option: options.gui });
  return plan;
}
