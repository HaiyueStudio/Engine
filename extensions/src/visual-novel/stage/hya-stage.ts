import { parseHyaComposition } from '@haiyue/animation-spec/hya-production';
import type { HyaCompositionDocument } from '@haiyue/animation-spec/hya-production';
import type { AssetManager } from '@haiyue/engine/assets';
import { EngineError, EngineErrorCode } from '@haiyue/engine/core';
import { Entity, System } from '@haiyue/engine/ecs';
import type { World, WorldRuntimeIntegration } from '@haiyue/engine/ecs';
import { GuiRoot } from '@haiyue/engine/gui';
import type { Scene } from '@haiyue/engine/scene';
import { createHyaPlayer } from '../../hya-player.js';
import type { HyaResourcePort } from '../../hya-player';
import type { HyaSemanticSnapshot } from '../../hya-data';
import { VisualNovelStage } from './VisualNovelStage.js';
import type { StageAsset, StageOptions, StageSlot, StageView } from './types';

interface Source {
  /** Immutable content and asset configuration identity shared by all consumers of this source. */
  readonly key: string;
  load(signal: AbortSignal): Promise<StageAsset>;
}
export interface HyaStageOptions extends Omit<StageOptions, 'port' | 'onDispose'> {
  readonly scene: Scene;
  readonly resolve: (assetId: string, variantId?: string) => Source;
  readonly designViewport?: readonly [number, number];
  readonly view?: () => StageView;
  readonly invalidate?: () => void;
}
let nextStage = 0;
const core = 'org.haiyue.animation-core@1';
const validSize = (size: readonly number[]) => size.length === 2 && size.every(value => Number.isFinite(value) && value >= 1);
const invalid = (message: string) => new EngineError(EngineErrorCode.GameplayInvalidInput, message);

/** Fit in logical pixels, then give the direct and retained paths the same device-pixel edges. */
export function layoutStageSlot(
  slot: StageSlot, natural: readonly [number, number], design: readonly [number, number], view: StageView,
) {
  const [x, y, width, height] = slot.bounds;
  const fit = slot.fit === 'contain' ? Math.min(width / natural[0], height / natural[1]) : 0;
  const w = fit ? fit * natural[0] : width;
  const h = fit ? fit * natural[1] : height;
  const [vw, vh] = view.viewport;
  const scale = Math.min(vw / design[0], vh / design[1]);
  const px = (vw - design[0] * scale) / 2 + (x + (width - w) / 2) * scale;
  const py = (vh - design[1] * scale) / 2 + (y + (height - h) / 2) * scale;
  const left = Math.round(px * view.dpr), top = Math.round(py * view.dpr);
  const right = Math.max(left + 1, Math.round((px + w * scale) * view.dpr));
  const bottom = Math.max(top + 1, Math.round((py + h * scale) * view.dpr));
  return {
    x: left / view.dpr, y: top / view.dpr, width: (right - left) / view.dpr, height: (bottom - top) / view.dpr,
  };
}

/** Use a cropped original core camera. Channel targets and authored child transforms stay intact. */
function sourceForSlot(source: HyaCompositionDocument, slot: StageSlot): unknown {
  if (slot.fit !== 'cover') return source;
  const aspect = slot.bounds[2] / slot.bounds[3];
  return { ...source, parts: source.parts.map(part => {
    if (part.extension !== core) return part;
    const document = part.document as unknown as import('@haiyue/animation-spec').AnimationDocument;
    const canvas = document.canvas;
    const width = Math.min(canvas.width, canvas.height * aspect), height = Math.min(canvas.height, canvas.width / aspect);
    if (Math.abs(width - canvas.width) < 1e-8 && Math.abs(height - canvas.height) < 1e-8) return part;
    const existing = new Set(document.nodes.map(node => node.id));
    let root = 'visual-novel-crop';
    while (existing.has(root)) root += '-';
    return {
      ...part, document: {
        ...document, canvas: { ...canvas, width, height },
        nodes: [{ id: root, transform: { position: [(width - canvas.width) / 2, (height - canvas.height) / 2] } },
          ...document.nodes.map(node => node.parent ? node : { ...node, parent: root })],
      },
    };
  }) };
}

function sharedResources(assets: AssetManager, provider: HyaResourcePort): HyaResourcePort {
  return {
    async acquire(request) {
      const key = `visual-novel:resource:${request.kind}:${request.integrity}`;
      const lease = await assets.load(key, signal => provider.acquire({ ...request, signal: signal! }),
        handle => handle.release(), { signal: request.signal });
      const { value, generation, bytes } = lease.value;
      return { value, generation, bytes, release: lease.release };
    },
  };
}

/** Bind to the existing World update and AssetManager. Scene Flow's world teardown owns automatic disposal. */
export function createHyaStage(options: HyaStageOptions): VisualNovelStage {
  const { scene } = options, assets = scene.engine.assetManager;
  if (!assets || scene.world.destroyed || scene.state === 'destroying') throw invalid('The stage requires a live scene and its AssetManager.');
  const design = options.designViewport ?? [1280, 720] as const;
  if (!validSize(design)) throw invalid('Invalid stage design viewport.');
  const view = options.view ?? (() => {
    const snapshot = scene.renderView.snapshot();
    return { viewport: [snapshot.displayWidth, snapshot.displayHeight], dpr: snapshot.width / snapshot.displayWidth } satisfies StageView;
  });
  const id = ++nextStage;
  let sequence = 0;
  let stage: VisualNovelStage;
  const hook: WorldRuntimeIntegration = { onDetach() { stage.dispose(); } };
  class FrameSystem extends System {
    override update(_world: World, _time: number, delta: number): this {
      const current = view();
      if (validSize(current.viewport)) {
        // The engine reports milliseconds. Limit catch-up on a resumed tab to its normal interactive span.
        stage.frame({ ...current, sequence: ++sequence, deltaSeconds: Math.min(.25, Math.max(0, delta / 1000)) });
      }
      return this;
    }
  }
  const clock = new FrameSystem(() => false, undefined, 'Visual novel stage clock');
  stage = new VisualNovelStage({
    ...options,
    onDispose: () => {
      scene.world.removeRuntimeIntegration(hook);
      if (!scene.world.destroyed) scene.world.removeSystem(clock);
    },
    port: {
      acquire(slot, signal) {
        const entry = options.resolve(slot.assetId, slot.variantId);
        if (!entry.key?.trim()) throw invalid(`Missing source key for "${slot.assetId}".`);
        return assets.load(`visual-novel:source:${entry.key}`, async ownerSignal => {
          const definition = await entry.load(ownerSignal!);
          if (!validSize(definition.designSize)) throw invalid(`Invalid design size for "${slot.assetId}".`);
          return { ...definition, source: parseHyaComposition(definition.source).document };
        }, () => {}, { signal });
      },
      async create(asset, slot, instance, signal, fail) {
        const composition = asset.source as HyaCompositionDocument;
        const source = sourceForSlot(composition, slot);
        const current = view();
        const bounds = layoutStageSlot(slot, asset.designSize, design, current);
        const viewport = [Math.max(1, bounds.width), Math.max(1, bounds.height)] as const;
        const region = scene.renderView.createRegion({
          id: `visual-novel:${id}:${instance}:${slot.id}`, bounds, visible: false, updateMode: 'demand', clearMode: 'on-update',
        });
        const gui = scene.guiSystem;
        const needsRoot = gui && composition.parts.some(part =>
          part.extension === 'org.haiyue.interaction@1' || part.extension === 'org.haiyue.layout-2d@1');
        const root = needsRoot ? new GuiRoot({ id: `visual-novel-gui:${id}:${instance}`, visible: false }) : undefined;
        const anchor = root ? new Entity('Visual novel slot GUI').addComponent(root) : undefined;
        let active = true, visible = false, attached = false;
        let lastSemantics: HyaSemanticSnapshot | undefined;
        let dirty = false;
        try {
          const host = asset.host?.(slot);
          const resources = host?.resources && sharedResources(assets, host.resources);
          const semantics = host?.semantics;
          const player = await createHyaPlayer(source, {
            mode: 'render', scene, region, signal, viewport, dpr: current.dpr, ...(root ? { root } : {}),
            host: {
              ...host, ...(resources ? { resources } : {}),
              ...(semantics ? { semantics: {
                update(snapshot: HyaSemanticSnapshot) {
                  lastSemantics = snapshot;
                  if (visible) semantics.update(snapshot);
                },
                subscribeActions(callback: (node: string, action: 'tap' | 'increase' | 'decrease' | 'focus') => void) {
                  return semantics.subscribeActions((node, action) => { if (visible) callback(node, action); });
                },
              } } : {}),
              capabilities: new Set(composition.parts.map(part => part.extension)),
              events: () => {}, // Accept events from the committed frame only.
              invalidate(reason) {
                if (!active) return;
                dirty = true;
                host?.invalidate?.(reason);
                options.invalidate?.();
              },
              diagnostic(diagnostic) {
                if (!active || signal.aborted) return;
                if (diagnostic.code.startsWith('E_') && !diagnostic.code.endsWith('_PENDING')) fail(diagnostic);
                host?.diagnostic?.(diagnostic);
              },
            },
          });
          return {
            advance: request => player.advance(request),
            seek: time => player.seek(time),
            setVisible(next) {
              if (anchor && next && !attached) { scene.add(anchor); attached = true; }
              region.setVisible(next);
              root?.root.setVisible(next);
              visible = next;
              if (next && lastSemantics) semantics?.update(lastSemantics);
            },
            resize(next) {
              const bounds = layoutStageSlot(slot, asset.designSize, design, next);
              region.setBounds(bounds);
              return [Math.max(1, bounds.width), Math.max(1, bounds.height)];
            },
            configure(data) {
              if (!Object.keys(data).length) return;
              if (!player.data) throw invalid(`Slot "${slot.id}" has data but its HYA declares no data bindings.`);
              player.data.run(write => {
                for (const [key, value] of Object.entries(data)) {
                  const parameter = asset.parameters && Object.hasOwn(asset.parameters, key) ? asset.parameters[key] : undefined;
                  if (parameter) write.set(parameter.instance, parameter.path, value);
                  else write.setBinding(key, value);
                }
              });
            },
            takeInvalidation() { const result = dirty; dirty = false; return result; },
            dispose() {
              active = false;
              visible = false;
              try { player.dispose(); }
              finally { try { anchor?.destroy(); } finally { region.dispose(); } }
            },
          };
        } catch (error) {
          active = false;
          anchor?.destroy();
          region.dispose();
          throw error;
        }
      },
      ...(options.invalidate ? { invalidate: options.invalidate } : {}),
    },
  });
  scene.addSystem(clock, false);
  scene.world.addRuntimeIntegration(hook);
  return stage;
}
