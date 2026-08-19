import {
  ANIMATION_VECTOR_SHAPE_EXTENSION_ID,
  AnimationFormatError,
  HYA_STATE_MACHINE_EXTENSION_ID,
  type AnimationAudioComponent,
  type AnimationComponent,
  type AnimationComposite,
  type AnimationCompositeLayer,
  type AnimationLayerEffect,
  type AnimationNode,
  type AnimationPath2DComponent,
  type AnimationParticle2DComponent,
  type AnimationShape2DComponent,
  type AnimationSprite2DComponent,
  type AnimationText2DComponent,
  type AnimationVectorGradientPaint,
  type AnimationVectorShapeComponent,
  type AnimationVectorValueTrack,
  type ParsedAnimation,
  type ParsedAnimationTrack,
} from '@haiyue/animation-spec';
import { Entity, Geometry2D, Transform2D } from '@haiyue/engine';
import { ParticleEmitter2D } from '@haiyue/engine/components';
import { createRect2D } from '@haiyue/engine/geometry';
import type { AssetHandle, AssetManager } from '@haiyue/engine/assets';
import type { Animation2DRuntimeStats } from './Animation2DComponent.js';
import type { Animation2DExtensionInstance, Animation2DExtensionRegistry } from './Animation2DExtensionRegistry.js';
import {
  applyVectorPathModifiers,
  tessellateAnimationPath,
  tessellateVectorStrokePath,
  sampleVectorPathMorph,
  type VectorPathMorphComponent,
  type VectorStrokePathComponent,
} from './AnimationPathTessellator.js';
import { AnimationVisual2D } from './AnimationVisual2D.js';
import { AnimationTextRasterizer } from './AnimationTextRasterizer.js';
import { AnimationAudioClip } from './AnimationAudioClip.js';
import { createParticle2DEmitter } from './Particle2DDescriptorAdapter.js';

export interface Animation2DRuntimeVisual {
  readonly component: AnimationVisual2D;
  readonly sourceComponentIndex: number;
  readonly color: [number, number, number, number];
  readonly baseAlpha: number;
  lastAlpha: number;
  readonly pathMorph?: VectorPathMorphComponent;
  lastMorphTime?: number;
  readonly vectorShape?: AnimationVectorShapeComponent;
  readonly vectorPaint?: 'fill' | 'stroke';
  styleAlpha: number;
  lastVectorTime?: number;
  readonly textRasterizer?: AnimationTextRasterizer;
  readonly sourceEffects?: readonly Readonly<AnimationLayerEffect>[];
  lastEffectTime?: number;
  readonly compositeExpansionTracks?: readonly (Readonly<AnimationVectorValueTrack> | undefined)[];
  lastCompositeTime?: number;
  readonly spriteUvRectTrack?: AnimationVectorValueTrack;
  spriteUvRectFrame?: number;
}

type CoreVisualComponent =
  | AnimationShape2DComponent
  | AnimationPath2DComponent
  | AnimationSprite2DComponent
  | AnimationText2DComponent
  | AnimationVectorShapeComponent
  | VectorPathMorphComponent
  | VectorStrokePathComponent;

interface DeferredCoreVisual {
  readonly component: CoreVisualComponent;
  readonly componentIndex: number;
  readonly order: number;
  readonly sourceGroup: string | undefined;
  readonly composite: Readonly<AnimationComposite> | undefined;
  readonly effects: readonly Readonly<AnimationLayerEffect>[] | undefined;
}

let nextRuntimeInstanceId = 1;

export interface Animation2DRuntimeNode {
  readonly source: Readonly<AnimationNode>;
  readonly entity: Entity;
  readonly content: Entity;
  readonly transform: Transform2D;
  readonly visuals: Animation2DRuntimeVisual[];
  readonly deferredVisuals: DeferredCoreVisual[];
  readonly extensions: Animation2DExtensionInstance[];
  readonly particles: ParticleEmitter2D[];
  readonly audio: AnimationAudioClip[];
  readonly initialX: number;
  readonly initialY: number;
  readonly initialRotation: number;
  readonly initialScaleX: number;
  readonly initialScaleY: number;
  readonly initialOpacity: number;
  opacity: number;
}

export class Animation2DRuntime {
  private readonly _root: Entity;
  protected readonly _nodes: Animation2DRuntimeNode[] = [];
  protected readonly _nodesById = new Map<string, Animation2DRuntimeNode>();
  private readonly _tracksByNode = new Map<string, ParsedAnimationTrack[]>();
  private readonly _trackCursors: Int32Array;
  private readonly _trackIndices = new Map<ParsedAnimationTrack, number>();
  protected readonly _opacityMemo = new Map<string, number>();
  private readonly _abortController = new AbortController();
  private readonly _assetHandles: AssetHandle<unknown>[] = [];
  private readonly _fontLoads = new Map<string, {
    state: 'loading' | 'loaded' | 'failed';
    readonly rasterizers: Set<AnimationTextRasterizer>;
  }>();
  private readonly _fontFaces: FontFace[] = [];
  private readonly _instanceId = nextRuntimeInstanceId++;
  private _visualCount = 0;
  private _unsupportedComponentCount = 0;
  private _pendingResourceCount = 0;
  private _failedResourceCount = 0;
  private _textCount = 0;
  private _particleCount = 0;
  private _audioCount = 0;
  private _destroyed = false;
  protected _playing = false;
  protected _speed = 1;
  protected _lastAppliedTime = Number.NaN;

  get stats(): Animation2DRuntimeStats {
    return Object.freeze({
      nodeCount: this._nodes.length,
      visualCount: this._visualCount,
      unsupportedComponentCount: this._unsupportedComponentCount,
      pendingResourceCount: this._pendingResourceCount,
      failedResourceCount: this._failedResourceCount,
      textCount: this._textCount,
      particleCount: this._particleCount,
      audioCount: this._audioCount,
    });
  }

  constructor(
    owner: Entity,
    private readonly _animation: ParsedAnimation,
    runtimeExtensions?: Animation2DExtensionRegistry,
    private readonly _assetManager?: AssetManager,
  ) {
    for (const id of _animation.extensionsRequired) {
      if (id === HYA_STATE_MACHINE_EXTENSION_ID) continue;
      if (!runtimeExtensions?.has(id)) {
        throw new AnimationFormatError(
          'E_ANIMATION_MISSING_EXTENSION',
          `Required animation runtime extension "${id}" is not registered.`,
          '$.extensionsRequired',
        );
      }
    }
    this._root = new Entity(`${_animation.name ?? 'Animation'} runtime`);
    this._root.addComponent(new Transform2D({ x: -_animation.canvas.width / 2, y: _animation.canvas.height / 2 }));
    owner.addChild(this._root);

    const compositeSources = new Set(_animation.nodes.flatMap(node => compositeLayers(node.composite).map(layer => layer.source)));
    const sourceGroupByNode = resolveSourceGroups(_animation.nodes, compositeSources);
    const compositeByNode = resolveInheritedComposites(_animation.nodes, sourceGroupByNode);
    const effectsByNode = resolveInheritedEffects(_animation.nodes, sourceGroupByNode);
    const sourceNodesById = new Map(_animation.nodes.map(node => [node.id, node]));
    let renderOrder = 0;
    for (const node of _animation.nodes) {
      const transformSource = node.transform;
      const position = transformSource?.position ?? [0, 0];
      const scale = transformSource?.scale ?? [1, 1];
      const transform = new Transform2D({
        x: position[0],
        y: -position[1],
        rotation: -(transformSource?.rotation ?? 0),
        scaleX: scale[0],
        scaleY: scale[1],
      });
      const entity = new Entity(node.name ?? node.id).addComponent(transform);
      const anchor = transformSource?.anchor ?? [0, 0];
      const content = new Entity(`${node.name ?? node.id} anchor`).addComponent(new Transform2D({
        x: -anchor[0],
        y: anchor[1],
      }));
      entity.addChild(content);
      const runtimeNode: Animation2DRuntimeNode = {
        source: node,
        entity,
        content,
        transform,
        visuals: [],
        deferredVisuals: [],
        extensions: [],
        particles: [],
        audio: [],
        initialX: transform.x,
        initialY: transform.y,
        initialRotation: transform.rotation,
        initialScaleX: transform.scaleX,
        initialScaleY: transform.scaleY,
        initialOpacity: transformSource?.opacity ?? 1,
        opacity: transformSource?.opacity ?? 1,
      };
      const sourceComponents = node.components ?? [];
      for (let componentIndex = 0; componentIndex < sourceComponents.length; componentIndex++) {
        const component = sourceComponents[componentIndex]!;
        if (isParticle2DComponent(component)) {
          // Particle2D is rendered by the engine's independent pass. Do not silently
          // bypass animation alpha-composite semantics until both renderers share a graph item protocol.
          if (sourceGroupByNode.has(node.id) || compositeByNode.has(node.id)) {
            this._unsupportedComponentCount++;
            continue;
          }
          const emitter = createParticle2DEmitter(component);
          content.addChild(new Entity(`${entity.name} particles`).addComponent(emitter));
          runtimeNode.particles.push(emitter);
          this._visualCount++;
          this._particleCount++;
          if (component.resource) this._loadTexture(component.resource, handle => { emitter.textureSource = handle; });
          continue;
        }
        if (isAudioComponent(component)) {
          const resource = this._animation.resources.find(candidate => candidate.id === component.resource);
          if (!resource || resource.type !== 'audio') {
            this._unsupportedComponentCount++;
            continue;
          }
          runtimeNode.audio.push(new AnimationAudioClip(resource.uri, component, node, this._animation.duration));
          this._audioCount++;
          continue;
        }
        if (!isCoreVisualComponent(component)) {
          const handler = runtimeExtensions?.get(component.type);
          if (!handler) {
            this._unsupportedComponentCount++;
            continue;
          }
          try {
            const instance = handler.create({
              animation: _animation,
              node,
              component,
              parent: content,
              ...(this._assetManager ? { assetManager: this._assetManager } : {}),
              instanceId: this._instanceId,
              signal: this._abortController.signal,
            });
            if (instance) {
              runtimeNode.extensions.push(instance);
              this._visualCount++;
            }
          } catch (error) {
            this._abortController.abort();
            for (const handle of this._assetHandles) handle.release();
            this._assetHandles.length = 0;
            for (const createdNode of [...this._nodes, runtimeNode]) {
              for (const audio of createdNode.audio) audio.destroy();
              for (const instance of createdNode.extensions) instance.destroy?.();
            }
            this._root.destroy();
            throw error;
          }
          continue;
        }
        const deferred: DeferredCoreVisual = {
          component,
          componentIndex,
          order: renderOrder++,
          sourceGroup: sourceGroupByNode.get(node.id),
          composite: compositeByNode.get(node.id),
          effects: effectsByNode.get(node.id),
        };
        this._visualCount++;
        if (component.type === 'text2d') this._textCount++;
        if (isSourceNodeActiveAt(node, 0, sourceNodesById, _animation.duration)) {
          this._materializeCoreVisual(runtimeNode, deferred);
        } else {
          runtimeNode.deferredVisuals.push(deferred);
        }
      }
      this._nodes.push(runtimeNode);
      this._nodesById.set(node.id, runtimeNode);
    }
    for (const node of this._nodes) {
      const parent = node.source.parent ? this._nodesById.get(node.source.parent)?.content : this._root;
      (parent ?? this._root).addChild(node.entity);
    }
    for (let index = 0; index < _animation.tracks.length; index++) {
      const track = _animation.tracks[index]!;
      let tracks = this._tracksByNode.get(track.node);
      if (!tracks) this._tracksByNode.set(track.node, tracks = []);
      tracks.push(track);
      this._trackIndices.set(track, index);
    }
    this._trackCursors = new Int32Array(_animation.tracks.length);
  }

  apply(time: number, playing = this._playing, speed = this._speed, forceParticleSeek = false): void {
    const discontinuity = forceParticleSeek || (
      !Number.isFinite(this._lastAppliedTime)
        ? time > 1e-6
        : time + 1e-6 < this._lastAppliedTime || Math.abs(time - this._lastAppliedTime) > 0.25
    );
    this._playing = playing;
    this._speed = speed;
    this._opacityMemo.clear();
    for (const node of this._nodes) {
      const start = node.source.start ?? 0;
      const end = start + (node.source.duration ?? this._animation.duration);
      node.entity.disabled = time < start || time > end;
      node.transform.setPosition(node.initialX, node.initialY);
      node.transform.rotation = node.initialRotation;
      node.transform.setScale(node.initialScaleX, node.initialScaleY);
      node.opacity = node.initialOpacity;
      for (const track of this._tracksByNode.get(node.source.id) ?? []) this._applyTrack(node, track, time);
    }
    for (const node of this._nodes) {
      const opacity = this._resolveOpacity(node);
      if (node.deferredVisuals.length > 0 && isRuntimeNodeActive(node, this._nodesById)) {
        for (const deferred of node.deferredVisuals.splice(0)) this._materializeCoreVisual(node, deferred);
      }
      for (const particle of node.particles) {
        if (discontinuity) particle.seek(Math.max(0, time - (node.source.start ?? 0)));
        particle.opacity = opacity;
        particle.playing = playing && !node.entity.disabled;
      }
      for (const audio of node.audio) audio.sync(time, playing && !node.entity.disabled, speed, opacity);
      for (const visual of node.visuals) {
        if (visual.spriteUvRectTrack) {
          const frame = findVectorTrackFrame(visual.spriteUvRectTrack, time);
          if (frame !== visual.spriteUvRectFrame) {
            const offset = frame * 4;
            visual.component.setUvRect([
              visual.spriteUvRectTrack.values[offset]!,
              visual.spriteUvRectTrack.values[offset + 1]!,
              visual.spriteUvRectTrack.values[offset + 2]!,
              visual.spriteUvRectTrack.values[offset + 3]!,
            ]);
            visual.spriteUvRectFrame = frame;
          }
        }
        visual.textRasterizer?.setTime(time);
        if (visual.pathMorph && visual.lastMorphTime !== time) {
          const next = tessellateAnimationPath(sampleVectorPathMorph(visual.pathMorph, time));
          visual.component.geometry.setData(next.positions, next.indices);
          visual.component.revision++;
          visual.lastMorphTime = time;
        }
        if (visual.vectorShape && visual.lastVectorTime !== undefined && visual.lastVectorTime !== time) {
          updateVectorVisual(visual, time);
          visual.lastVectorTime = time;
        }
        if (visual.sourceEffects && visual.lastEffectTime !== time) {
          updateVisualEffects(visual.component, visual.sourceEffects, time);
          visual.component.revision++;
          visual.lastEffectTime = time;
        }
        if (visual.compositeExpansionTracks && visual.lastCompositeTime !== time) {
          for (let index = 0; index < visual.compositeExpansionTracks.length; index++) {
            const track = visual.compositeExpansionTracks[index];
            if (track) visual.component.setCompositeExpansion(index, sampleVectorTrack(track, time)[0] ?? 0);
          }
          visual.lastCompositeTime = time;
        }
        const alpha = visual.styleAlpha * opacity;
        if (Math.abs(alpha - visual.lastAlpha) < 1e-6) continue;
        visual.color[3] = alpha;
        visual.component.revision++;
        visual.lastAlpha = alpha;
      }
      for (const extension of node.extensions) {
        if (extension.apply) extension.apply(time, opacity);
        else extension.setOpacity?.(opacity);
      }
    }
    this._lastAppliedTime = time;
  }

  destroy(): void {
    if (this._destroyed) return;
    this._destroyed = true;
    this._abortController.abort();
    for (const handle of this._assetHandles) handle.release();
    this._assetHandles.length = 0;
    if (typeof document !== 'undefined' && document.fonts) {
      for (const face of this._fontFaces) document.fonts.delete(face);
    }
    this._fontFaces.length = 0;
    this._fontLoads.clear();
    for (const node of this._nodes) {
      for (const visual of node.visuals) visual.textRasterizer?.destroy();
      for (const audio of node.audio) audio.destroy();
      node.audio.length = 0;
      for (const extension of node.extensions) extension.destroy?.();
      node.extensions.length = 0;
    }
    this._root.destroy();
    this._nodes.length = 0;
    this._nodesById.clear();
    this._tracksByNode.clear();
    this._trackIndices.clear();
  }

  setPlaying(playing: boolean): void {
    this._playing = playing;
    if (playing) return;
    for (const node of this._nodes) {
      for (const particle of node.particles) particle.playing = false;
      for (const audio of node.audio) audio.pause();
    }
  }

  private _loadTexture(resourceId: string, apply: (handle: AssetHandle<GPUTexture>) => void): void {
    const resource = this._animation.resources.find(candidate => candidate.id === resourceId);
    if (!resource || resource.type !== 'image' || !this._assetManager) {
      this._failedResourceCount++;
      return;
    }
    this._pendingResourceCount++;
    let request: Promise<AssetHandle<GPUTexture>>;
    try {
      request = this._assetManager.loadTexture(resource.uri, {
        label: `Animation2D:${resource.id}`,
        format: resource.colorSpace === 'linear' ? 'rgba8unorm' : 'rgba8unorm-srgb',
        cacheKey: resource.integrity ?? resource.uri,
        signal: this._abortController.signal,
      });
    } catch {
      this._pendingResourceCount--;
      this._failedResourceCount++;
      return;
    }
    void request.then(handle => {
      if (this._destroyed) { handle.release(); return; }
      this._assetHandles.push(handle);
      apply(handle);
    }).catch(() => {
      if (!this._destroyed) this._failedResourceCount++;
    }).finally(() => {
      this._pendingResourceCount = Math.max(0, this._pendingResourceCount - 1);
    });
  }

  protected _materializeCoreVisual(node: Animation2DRuntimeNode, deferred: DeferredCoreVisual): void {
    let visual: ReturnType<typeof createCoreVisual>;
    try {
      visual = createCoreVisual(
        deferred.component,
        deferred.componentIndex,
        this._instanceId,
        node.source,
        deferred.order,
        deferred.sourceGroup,
        deferred.composite,
        deferred.effects,
      );
    } catch {
      this._unsupportedComponentCount++;
      return;
    }
    node.content.addChild(new Entity(`${node.entity.name} visual`).addComponent(visual.component));
    node.visuals.push(visual.runtime);
    if (deferred.component.type === 'sprite2d') {
      this._loadTexture(deferred.component.resource, handle => visual.component.setTextureHandle(handle));
    } else if (deferred.component.type === 'text2d' && visual.runtime.textRasterizer) {
      this._loadTextFonts(deferred.component, visual.runtime.textRasterizer);
    }
  }

  private _loadTextFonts(component: Readonly<AnimationText2DComponent>, rasterizer: AnimationTextRasterizer): void {
    const descriptors = [
      component.fontResource ? {
        resource: component.fontResource,
        family: component.fontFamily ?? 'sans-serif',
        style: component.fontStyle ?? 'normal',
        weight: component.fontWeight ?? 400,
      } : null,
      ...(component.documents ?? []).map(document => document.fontResource ? {
        resource: document.fontResource,
        family: document.fontFamily ?? component.fontFamily ?? 'sans-serif',
        style: document.fontStyle ?? component.fontStyle ?? 'normal',
        weight: document.fontWeight ?? component.fontWeight ?? 400,
      } : null),
    ].filter((value): value is NonNullable<typeof value> => value !== null);
    for (const descriptor of descriptors) this._loadFont(descriptor, rasterizer);
  }

  private _loadFont(
    descriptor: { resource: string; family: string; style: 'normal' | 'italic'; weight: string | number },
    rasterizer: AnimationTextRasterizer,
  ): void {
    const key = `${descriptor.resource}:${descriptor.family}:${descriptor.style}:${descriptor.weight}`;
    const existing = this._fontLoads.get(key);
    if (existing) {
      if (existing.state === 'loaded') rasterizer.invalidateFont();
      else if (existing.state === 'loading') existing.rasterizers.add(rasterizer);
      return;
    }
    const load = { state: 'loading' as const, rasterizers: new Set([rasterizer]) };
    this._fontLoads.set(key, load);
    const resource = this._animation.resources.find(candidate => candidate.id === descriptor.resource);
    if (!resource || resource.type !== 'binary' || !this._assetManager || typeof FontFace === 'undefined'
      || typeof document === 'undefined' || !document.fonts) {
      this._fontLoads.set(key, { ...load, state: 'failed' });
      this._failedResourceCount++;
      return;
    }
    this._pendingResourceCount++;
    let retainedHandle: AssetHandle<ArrayBuffer> | null = null;
    void this._assetManager.load<ArrayBuffer>(
      `Animation2D.font:${resource.integrity ?? resource.uri}`,
      async signal => {
        const response = await fetch(resource.uri, signal ? { signal } : {});
        if (!response.ok) throw new Error(`Font request failed with HTTP ${response.status}.`);
        return response.arrayBuffer();
      },
      () => {},
      { signal: this._abortController.signal },
    ).then(async handle => {
      retainedHandle = handle;
      if (this._destroyed) { handle.release(); return; }
      const face = new FontFace(descriptor.family, handle.value, {
        style: descriptor.style,
        weight: String(descriptor.weight),
      });
      await face.load();
      if (this._destroyed) { handle.release(); return; }
      document.fonts.add(face);
      this._fontFaces.push(face);
      this._assetHandles.push(handle);
      retainedHandle = null;
      const current = this._fontLoads.get(key);
      if (current) {
        current.state = 'loaded';
        for (const target of current.rasterizers) target.invalidateFont();
        current.rasterizers.clear();
      }
    }).catch(() => {
      retainedHandle?.release();
      if (!this._destroyed) {
        const current = this._fontLoads.get(key);
        if (current) {
          current.state = 'failed';
          current.rasterizers.clear();
        }
        this._failedResourceCount++;
      }
    }).finally(() => {
      this._pendingResourceCount = Math.max(0, this._pendingResourceCount - 1);
    });
  }

  private _applyTrack(node: Animation2DRuntimeNode, track: ParsedAnimationTrack, time: number): void {
    const trackIndex = this._trackIndices.get(track)!;
    const cursor = findFrame(track.times, time, this._trackCursors[trackIndex] ?? 0);
    this._trackCursors[trackIndex] = cursor;
    const progress = sampleProgress(track, cursor, time);
    const offset = cursor * track.valueSize;
    const nextOffset = Math.min(cursor + 1, track.times.length - 1) * track.valueSize;
    let x = mix(track.values[offset]!, track.values[nextOffset]!, progress);
    let y = track.valueSize === 2 ? mix(track.values[offset + 1]!, track.values[nextOffset + 1]!, progress) : 0;
    if (track.property === 'position' && track.spatialTangents && cursor < track.times.length - 1) {
      const tangentOffset = cursor * 4;
      x = spatialBezier(
        track.values[offset]!,
        track.values[offset]! + track.spatialTangents[tangentOffset]!,
        track.values[nextOffset]! + track.spatialTangents[tangentOffset + 2]!,
        track.values[nextOffset]!,
        progress,
      );
      y = spatialBezier(
        track.values[offset + 1]!,
        track.values[offset + 1]! + track.spatialTangents[tangentOffset + 1]!,
        track.values[nextOffset + 1]! + track.spatialTangents[tangentOffset + 3]!,
        track.values[nextOffset + 1]!,
        progress,
      );
    }
    switch (track.property) {
      case 'position': node.transform.setPosition(x, -y); break;
      case 'rotation': node.transform.rotation = -x; break;
      case 'scale': node.transform.setScale(x, y); break;
      case 'opacity': node.opacity = clamp(x, 0, 1); break;
    }
  }

  protected _resolveOpacity(node: Animation2DRuntimeNode): number {
    const cached = this._opacityMemo.get(node.source.id);
    if (cached !== undefined) return cached;
    const parent = node.source.parent ? this._nodesById.get(node.source.parent) : undefined;
    const result = clamp(node.opacity * (parent ? this._resolveOpacity(parent) : 1), 0, 1);
    this._opacityMemo.set(node.source.id, result);
    return result;
  }

  protected _isNodeActive(node: Animation2DRuntimeNode): boolean {
    return isRuntimeNodeActive(node, this._nodesById);
  }

  /** @internal Applies state-machine-only component channels to the shared visual instance. */
  protected _applyStateMachineVisualChannel(
    node: Animation2DRuntimeNode,
    path: string,
    value: unknown,
  ): boolean {
    const match = /^components\.(\d+)\.(sprite\.uv-rect|vector\.morph|path\.morph)$/u.exec(path);
    if (!match) return false;
    const componentIndex = Number(match[1]);
    if (node.deferredVisuals.length > 0 && this._isNodeActive(node)) {
      const deferred = node.deferredVisuals.filter(item => item.componentIndex === componentIndex);
      node.deferredVisuals.splice(0, node.deferredVisuals.length, ...node.deferredVisuals.filter(
        item => item.componentIndex !== componentIndex,
      ));
      for (const item of deferred) this._materializeCoreVisual(node, item);
    }
    const visuals = node.visuals.filter(visual => visual.sourceComponentIndex === componentIndex);
    if (match[2] === 'sprite.uv-rect') {
      const uv = numericStateMachineValue(value, path, 4);
      for (const visual of visuals) visual.component.setUvRect([uv[0]!, uv[1]!, uv[2]!, uv[3]!]);
      return true;
    }
    const morph = numericStateMachineValue(value, path, 1);
    for (const visual of visuals) {
      if (match[2] === 'path.morph' && visual.pathMorph) {
        const next = tessellateAnimationPath({
          type: 'path2d',
          commands: visual.pathMorph.commands,
          values: morph,
          fill: visual.pathMorph.fill,
          fillRule: visual.pathMorph.fillRule,
          ...(visual.pathMorph.tolerance === undefined ? {} : { tolerance: visual.pathMorph.tolerance }),
        });
        visual.component.geometry.setData(next.positions, next.indices);
        visual.component.revision++;
      } else if (match[2] === 'vector.morph' && visual.vectorShape) {
        const shape = visual.vectorShape;
        let pathValues = morph;
        if (shape.morphRelative) {
          pathValues = new Float32Array(morph.length);
          for (let index = 0; index < morph.length; index++) {
            pathValues[index] = morph[index]! + (shape.values[index] ?? 0);
          }
        }
        updateVectorVisual(visual, 0, pathValues);
      }
    }
    return true;
  }
}

function numericStateMachineValue(value: unknown, bindingPath: string, minimumSize: number): Float32Array {
  if (!(value instanceof Float32Array) || value.length < minimumSize) {
    throw new TypeError(
      `Animation2D state-machine binding "${bindingPath}" requires at least ${minimumSize} Float32 values.`,
    );
  }
  return value;
}

function createEllipseGeometry(width: number, height: number, centerX: number, centerY: number): Geometry2D {
  const segments = 48;
  const positions = new Float32Array((segments + 1) * 2);
  positions[0] = centerX;
  positions[1] = centerY;
  for (let index = 0; index < segments; index++) {
    const angle = index / segments * Math.PI * 2;
    positions[(index + 1) * 2] = centerX + Math.cos(angle) * width / 2;
    positions[(index + 1) * 2 + 1] = centerY + Math.sin(angle) * height / 2;
  }
  const indices = new Uint16Array(segments * 3);
  for (let index = 0; index < segments; index++) {
    indices[index * 3] = 0;
    indices[index * 3 + 1] = index + 1;
    indices[index * 3 + 2] = index + 2 > segments ? 1 : index + 2;
  }
  return new Geometry2D(positions, indices);
}

function isShape2DComponent(component: AnimationComponent): component is AnimationShape2DComponent {
  return component.type === 'shape2d'
    && (component as Partial<AnimationShape2DComponent>).size !== undefined
    && (component as Partial<AnimationShape2DComponent>).fill !== undefined;
}

function isPath2DComponent(component: AnimationComponent): component is AnimationPath2DComponent {
  return component.type === 'path2d'
    && typeof (component as Partial<AnimationPath2DComponent>).commands === 'string'
    && (component as Partial<AnimationPath2DComponent>).values !== undefined;
}

function isSprite2DComponent(component: AnimationComponent): component is AnimationSprite2DComponent {
  return component.type === 'sprite2d'
    && typeof (component as Partial<AnimationSprite2DComponent>).resource === 'string'
    && (component as Partial<AnimationSprite2DComponent>).size !== undefined;
}

function isText2DComponent(component: AnimationComponent): component is AnimationText2DComponent {
  return component.type === 'text2d'
    && typeof (component as Partial<AnimationText2DComponent>).text === 'string'
    && (component as Partial<AnimationText2DComponent>).size !== undefined;
}

function isParticle2DComponent(component: AnimationComponent): component is AnimationParticle2DComponent {
  return component.type === 'particle2d'
    && typeof (component as Partial<AnimationParticle2DComponent>).maxParticles === 'number';
}

function isAudioComponent(component: AnimationComponent): component is AnimationAudioComponent {
  return component.type === 'audio' && typeof (component as Partial<AnimationAudioComponent>).resource === 'string';
}

function isVectorStrokePathComponent(component: AnimationComponent): component is VectorStrokePathComponent {
  const candidate = component as Partial<VectorStrokePathComponent>;
  const inlinePath = typeof candidate.commands === 'string'
    && /^[MLQCZ]+$/.test(candidate.commands)
    && candidate.commands[0] === 'M'
    && Array.isArray(candidate.values)
    && candidate.values.length === strokePathValueCount(candidate.commands)
    && candidate.values.every(value => typeof value === 'number' && Number.isFinite(value));
  const sourcePath = typeof candidate.sourceComponent === 'number'
    && Number.isSafeInteger(candidate.sourceComponent)
    && candidate.sourceComponent >= 0;
  return component.type === 'org.haiyue.vector-stroke@1'
    && (inlinePath || sourcePath)
    && Array.isArray(candidate.color)
    && candidate.color.length === 4
    && candidate.color.every(value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1)
    && typeof candidate.width === 'number' && Number.isFinite(candidate.width) && candidate.width > 0
    && (candidate.lineCap === 'butt' || candidate.lineCap === 'round' || candidate.lineCap === 'square')
    && (candidate.lineJoin === 'miter' || candidate.lineJoin === 'round' || candidate.lineJoin === 'bevel')
    && typeof candidate.miterLimit === 'number' && Number.isFinite(candidate.miterLimit) && candidate.miterLimit >= 1
    && (candidate.tolerance === undefined
      || (typeof candidate.tolerance === 'number' && Number.isFinite(candidate.tolerance) && candidate.tolerance > 0));
}

function isVectorPathMorphComponent(component: AnimationComponent): component is VectorPathMorphComponent {
  const candidate = component as Partial<VectorPathMorphComponent>;
  return component.type === 'org.haiyue.vector-path-morph@1'
    && typeof candidate.commands === 'string'
    && /^[MLQCZ]+$/.test(candidate.commands)
    && (Array.isArray(candidate.times) || candidate.times instanceof Float32Array) && candidate.times.length > 0
    && Array.from(candidate.times).every(value => typeof value === 'number' && Number.isFinite(value))
    && (Array.isArray(candidate.values) || candidate.values instanceof Float32Array)
    && typeof candidate.valueSize === 'number' && Number.isSafeInteger(candidate.valueSize) && candidate.valueSize > 0
    && candidate.values.length === candidate.times.length * candidate.valueSize
    && Array.from(candidate.values).every(value => typeof value === 'number' && Number.isFinite(value))
    && (candidate.interpolation === 'step' || candidate.interpolation === 'linear' || candidate.interpolation === 'cubic-bezier')
    && Array.isArray(candidate.fill) && candidate.fill.length === 4;
}

function strokePathValueCount(commands: string): number {
  let count = 0;
  for (const command of commands) count += command === 'M' || command === 'L' ? 2 : command === 'Q' ? 4 : command === 'C' ? 6 : 0;
  return count;
}

function isCoreVisualComponent(component: AnimationComponent): component is CoreVisualComponent {
  return isShape2DComponent(component) || isPath2DComponent(component) || isSprite2DComponent(component)
    || isText2DComponent(component) || isVectorShapeComponent(component)
    || isVectorStrokePathComponent(component) || isVectorPathMorphComponent(component);
}

function isVectorShapeComponent(component: AnimationComponent): component is AnimationVectorShapeComponent {
  return component.type === ANIMATION_VECTOR_SHAPE_EXTENSION_ID
    && typeof (component as Partial<AnimationVectorShapeComponent>).commands === 'string';
}

function createCoreVisual(
  component: CoreVisualComponent,
  componentIndex: number,
  instanceId: number,
  node: Readonly<AnimationNode>,
  order: number,
  sourceGroup: string | undefined,
  composite: Readonly<AnimationComposite> | undefined,
  effects: readonly Readonly<AnimationLayerEffect>[] | undefined,
): { component: AnimationVisual2D; runtime: Animation2DRuntimeVisual } {
  let geometry: Geometry2D;
  let color: [number, number, number, number];
  let textMaterial: AnimationTextRasterizer | null = null;
  let gradient: import('./AnimationVisual2D').AnimationVisualGradient | null = null;
  let vectorPaint: 'fill' | 'stroke' | undefined;
  if (component.type === 'path2d') {
    geometry = tessellateAnimationPath(component);
    color = [...component.fill];
  } else if (component.type === 'org.haiyue.vector-path-morph@1') {
    geometry = tessellateAnimationPath(sampleVectorPathMorph(component, component.times[0] ?? 0));
    color = [...component.fill];
  } else if (component.type === 'org.haiyue.vector-stroke@1') {
    geometry = tessellateVectorStrokePath(resolveVectorStrokePath(component, node));
    color = [...component.color];
  } else if (component.type === ANIMATION_VECTOR_SHAPE_EXTENSION_ID) {
    const initialTime = component.morph?.times[0] ?? firstVectorModifierTime(component) ?? 0;
    const pathValues = sampleVectorShapePath(component, initialTime);
    const resolvedPath = resolveVectorPath(component, pathValues, initialTime, component.fill !== undefined);
    if (component.fill) {
      geometry = resolvedPath.commands.length === 0 ? emptyGeometry2D() : tessellateRuntimeFillPath({
        type: 'path2d', commands: resolvedPath.commands, values: resolvedPath.values,
        fill: [1, 1, 1, 1], fillRule: component.fillRule ?? 'nonzero',
        ...(component.tolerance === undefined ? {} : { tolerance: component.tolerance }),
      });
      vectorPaint = 'fill';
      if (component.fill.kind === 'solid') color = [...component.fill.color];
      else {
        color = [1, 1, 1, 1];
        gradient = createRuntimeGradient(component.fill);
      }
    } else {
      const stroke = component.stroke!;
      geometry = resolvedPath.commands.length === 0 ? emptyGeometry2D() : tessellateVectorStrokePath({
        type: 'org.haiyue.vector-stroke@1', commands: resolvedPath.commands, values: resolvedPath.values,
        color: stroke.color, width: stroke.width, lineCap: stroke.lineCap, lineJoin: stroke.lineJoin,
        miterLimit: stroke.miterLimit,
        ...(component.tolerance === undefined ? {} : { tolerance: component.tolerance }),
        ...(stroke.dash ? { dash: stroke.dash } : {}),
        ...(stroke.dashOffset === undefined ? {} : { dashOffset: stroke.dashOffset }),
      }, true);
      vectorPaint = 'stroke';
      color = stroke.gradient ? [1, 1, 1, 1] : [...stroke.color];
      if (stroke.gradient) gradient = createRuntimeGradient(stroke.gradient);
    }
  } else {
    const position = component.position ?? [0, 0];
    const centerX = position[0];
    const centerY = -position[1];
    geometry = component.type === 'shape2d' && component.shape === 'ellipse'
      ? createEllipseGeometry(component.size[0], component.size[1], centerX, centerY)
      : createRect2D({ width: component.size[0], height: component.size[1], x: centerX, y: centerY });
    color = component.type === 'shape2d' ? [...component.fill]
      : component.type === 'sprite2d' ? [...(component.tint ?? [1, 1, 1, 1])] : [1, 1, 1, 1];
    if (component.type === 'text2d') {
      textMaterial = new AnimationTextRasterizer(component);
    }
  }
  const visual = new AnimationVisual2D({
    geometry,
    color,
    instanceId,
    nodeId: sourceGroup ?? node.id,
    order,
    sourceOnly: sourceGroup !== undefined,
    ...(composite ? { composite } : {}),
    ...(component.type === 'sprite2d' ? { requiresTexture: true, uvRect: component.uvRect ?? [0, 0, 1, 1] } : {}),
    ...(component.type === 'text2d' ? { requiresTexture: true, textMaterial } : {}),
    ...(gradient ? { gradient } : {}),
    ...(effects?.length ? { effects: createVisualEffects(effects, 0) } : {}),
  });
  const initialStyleAlpha = component.type === ANIMATION_VECTOR_SHAPE_EXTENSION_ID
    ? initialVectorStyleAlpha(component)
    : visual.color[3];
  const compositeExpansionTracks = composite
    ? compositeLayers(composite).map(layer => layer.expansionTrack)
    : [];
  return {
    component: visual,
    runtime: {
      component: visual,
      sourceComponentIndex: componentIndex,
      color: visual.color,
      baseAlpha: visual.color[3],
      styleAlpha: initialStyleAlpha,
      lastAlpha: Number.NaN,
      ...(component.type === 'org.haiyue.vector-path-morph@1' ? { pathMorph: component, lastMorphTime: component.times[0] ?? 0 } : {}),
      ...(component.type === ANIMATION_VECTOR_SHAPE_EXTENSION_ID ? {
        vectorShape: component,
        vectorPaint: vectorPaint!,
        ...(isVectorShapeDynamic(component) ? { lastVectorTime: Number.NaN } : {}),
      } : {}),
      ...(textMaterial ? { textRasterizer: textMaterial } : {}),
      ...(effects?.length ? { sourceEffects: effects, lastEffectTime: 0 } : {}),
      ...(compositeExpansionTracks.some(track => track !== undefined) ? {
        compositeExpansionTracks,
        lastCompositeTime: Number.NaN,
      } : {}),
      ...(component.type === 'sprite2d' && component.uvRectTrack ? {
        spriteUvRectTrack: component.uvRectTrack,
        spriteUvRectFrame: -1,
      } : {}),
    },
  };
}

function createVisualEffects(
  effects: readonly Readonly<AnimationLayerEffect>[],
  time: number,
): import('./AnimationVisual2D').AnimationVisualEffect[] {
  return effects.map(effect => ({ kind: effect.kind, values: sampleEffectValues(effect, time) }));
}

function updateVisualEffects(
  visual: AnimationVisual2D,
  effects: readonly Readonly<AnimationLayerEffect>[],
  time: number,
): void {
  const count = Math.min(visual.effects.length, effects.length);
  for (let index = 0; index < count; index++) {
    const sampled = sampleEffectValues(effects[index]!, time);
    const target = visual.effects[index]!.values;
    if (target.length === sampled.length) target.set(sampled);
  }
}

function sampleEffectValues(effect: Readonly<AnimationLayerEffect>, time: number): Float32Array {
  switch (effect.kind) {
    case 'tint': {
      const black = effect.blackTrack ? sampleVectorTrack(effect.blackTrack, time) : effect.black;
      const white = effect.whiteTrack ? sampleVectorTrack(effect.whiteTrack, time) : effect.white;
      const amount = effect.amountTrack ? sampleVectorTrack(effect.amountTrack, time)[0] ?? effect.amount : effect.amount;
      return new Float32Array([
        black[0] ?? effect.black[0], black[1] ?? effect.black[1], black[2] ?? effect.black[2],
        white[0] ?? effect.white[0], white[1] ?? effect.white[1], white[2] ?? effect.white[2],
        clamp(amount, 0, 1),
      ]);
    }
    case 'fill': {
      const color = effect.colorTrack ? sampleVectorTrack(effect.colorTrack, time) : effect.color;
      const opacity = effect.opacityTrack ? sampleVectorTrack(effect.opacityTrack, time)[0] ?? effect.opacity ?? 1 : effect.opacity ?? 1;
      return new Float32Array([
        color[0] ?? effect.color[0], color[1] ?? effect.color[1], color[2] ?? effect.color[2], color[3] ?? effect.color[3],
        clamp(opacity, 0, 1),
      ]);
    }
    case 'opacity': {
      const opacity = effect.opacityTrack ? sampleVectorTrack(effect.opacityTrack, time)[0] ?? effect.opacity : effect.opacity;
      return new Float32Array([clamp(opacity, 0, 1)]);
    }
    case 'color-matrix':
      return new Float32Array(effect.matrixTrack ? sampleVectorTrack(effect.matrixTrack, time) : effect.matrix);
    case 'blur': {
      const radius = effect.radiusTrack ? sampleVectorTrack(effect.radiusTrack, time) : effect.radius;
      return new Float32Array([Math.max(0, radius[0] ?? effect.radius[0]), Math.max(0, radius[1] ?? effect.radius[1])]);
    }
    case 'drop-shadow': {
      const color = effect.colorTrack ? sampleVectorTrack(effect.colorTrack, time) : effect.color;
      const opacity = effect.opacityTrack ? sampleVectorTrack(effect.opacityTrack, time)[0] ?? effect.opacity : effect.opacity;
      const offset = effect.offsetTrack ? sampleVectorTrack(effect.offsetTrack, time) : effect.offset;
      const blur = effect.blurTrack ? sampleVectorTrack(effect.blurTrack, time)[0] ?? effect.blur : effect.blur;
      return new Float32Array([
        color[0] ?? effect.color[0], color[1] ?? effect.color[1], color[2] ?? effect.color[2], color[3] ?? effect.color[3],
        clamp(opacity, 0, 1), offset[0] ?? effect.offset[0], offset[1] ?? effect.offset[1], Math.max(0, blur),
      ]);
    }
  }
}

function updateVectorVisual(
  visual: Animation2DRuntimeVisual,
  time: number,
  pathOverride?: Readonly<Float32Array>,
): void {
  const shape = visual.vectorShape!;
  const paint = visual.vectorPaint!;
  const pathValues = pathOverride ?? sampleVectorShapePath(shape, time);
  let geometryChanged = shape.morph !== undefined || hasAnimatedVectorModifier(shape);
  if (paint === 'fill') {
    const fill = shape.fill!;
    if (geometryChanged) {
      const resolvedPath = resolveVectorPath(shape, pathValues, time, true);
      const next = !resolvedPath.commands.length ? emptyGeometry2D() : tessellateRuntimeFillPath({
        type: 'path2d', commands: resolvedPath.commands, values: resolvedPath.values,
        fill: [1, 1, 1, 1], fillRule: shape.fillRule ?? 'nonzero',
        ...(shape.tolerance === undefined ? {} : { tolerance: shape.tolerance }),
      });
      visual.component.geometry.setData(next.positions, next.indices);
    }
    if (fill.kind === 'solid') {
      const sampledColor = fill.colorTrack ? sampleVectorTrack(fill.colorTrack, time) : fill.color;
      visual.color[0] = sampledColor[0] ?? fill.color[0];
      visual.color[1] = sampledColor[1] ?? fill.color[1];
      visual.color[2] = sampledColor[2] ?? fill.color[2];
      const sampledOpacity = fill.opacityTrack
        ? sampleVectorTrack(fill.opacityTrack, time)[0] ?? fill.opacity ?? 1
        : fill.opacity ?? 1;
      visual.styleAlpha = clamp((sampledColor[3] ?? fill.color[3]) * sampledOpacity, 0, 1);
    } else {
      updateRuntimeGradient(visual, fill, time);
      visual.styleAlpha = 1;
    }
  } else {
    const stroke = shape.stroke!;
    const width = stroke.widthTrack ? sampleVectorTrack(stroke.widthTrack, time)[0] ?? stroke.width : stroke.width;
    const dashOffset = stroke.dashOffsetTrack
      ? sampleVectorTrack(stroke.dashOffsetTrack, time)[0] ?? stroke.dashOffset ?? 0
      : stroke.dashOffset;
    geometryChanged ||= stroke.widthTrack !== undefined || stroke.dashOffsetTrack !== undefined;
    if (geometryChanged) {
      const resolvedPath = resolveVectorPath(shape, pathValues, time, false);
      const next = !resolvedPath.commands.length ? emptyGeometry2D() : tessellateVectorStrokePath({
        type: 'org.haiyue.vector-stroke@1', commands: resolvedPath.commands, values: resolvedPath.values,
        color: stroke.color, width, lineCap: stroke.lineCap, lineJoin: stroke.lineJoin,
        miterLimit: stroke.miterLimit,
        ...(shape.tolerance === undefined ? {} : { tolerance: shape.tolerance }),
        ...(stroke.dash ? { dash: stroke.dash } : {}),
        ...(dashOffset === undefined ? {} : { dashOffset }),
      }, true);
      visual.component.geometry.setData(next.positions, next.indices);
    }
    const sampledColor = stroke.colorTrack ? sampleVectorTrack(stroke.colorTrack, time) : stroke.color;
    visual.color[0] = stroke.gradient ? 1 : sampledColor[0] ?? stroke.color[0];
    visual.color[1] = stroke.gradient ? 1 : sampledColor[1] ?? stroke.color[1];
    visual.color[2] = stroke.gradient ? 1 : sampledColor[2] ?? stroke.color[2];
    const sampledOpacity = stroke.opacityTrack
      ? sampleVectorTrack(stroke.opacityTrack, time)[0] ?? stroke.opacity ?? 1
      : stroke.opacity ?? 1;
    visual.styleAlpha = stroke.gradient ? 1 : clamp((sampledColor[3] ?? stroke.color[3]) * sampledOpacity, 0, 1);
    if (stroke.gradient) updateRuntimeGradient(visual, stroke.gradient, time);
  }
  visual.component.revision++;
}

function sampleVectorShapePath(
  shape: Readonly<AnimationVectorShapeComponent>,
  time: number,
): Float32Array {
  if (!shape.morph) return shape.values instanceof Float32Array
    ? shape.values
    : new Float32Array(shape.values);
  const sampled = sampleVectorTrack(shape.morph, time);
  if (!shape.morphRelative) return sampled;
  for (let index = 0; index < sampled.length; index++) {
    sampled[index] = (sampled[index] ?? 0) + (shape.values[index] ?? 0);
  }
  return sampled;
}

function createRuntimeGradient(paint: AnimationVectorGradientPaint): import('./AnimationVisual2D').AnimationVisualGradient {
  return {
    kind: paint.kind === 'linear-gradient' ? 'linear' : 'radial',
    start: [paint.start[0], -paint.start[1]],
    end: [paint.end[0], -paint.end[1]],
    stops: new Float32Array(paint.stops),
    opacity: paint.opacity ?? 1,
  };
}

function updateRuntimeGradient(visual: Animation2DRuntimeVisual, paint: AnimationVectorGradientPaint, time: number): void {
  const gradient = visual.component.gradient ??= createRuntimeGradient(paint);
  const start = paint.startTrack ? sampleVectorTrack(paint.startTrack, time) : paint.start;
  const end = paint.endTrack ? sampleVectorTrack(paint.endTrack, time) : paint.end;
  const stops = paint.stopsTrack ? sampleVectorTrack(paint.stopsTrack, time) : paint.stops;
  gradient.start[0] = start[0] ?? paint.start[0];
  gradient.start[1] = -(start[1] ?? paint.start[1]);
  gradient.end[0] = end[0] ?? paint.end[0];
  gradient.end[1] = -(end[1] ?? paint.end[1]);
  if (gradient.stops.length !== stops.length) gradient.stops = new Float32Array(stops);
  else gradient.stops.set(stops);
  gradient.opacity = paint.opacityTrack
    ? sampleVectorTrack(paint.opacityTrack, time)[0] ?? paint.opacity ?? 1
    : paint.opacity ?? 1;
}

function initialVectorStyleAlpha(component: AnimationVectorShapeComponent): number {
  if (component.fill) return component.fill.kind === 'solid'
    ? component.fill.color[3] * (component.fill.opacity ?? 1)
    : 1;
  const stroke = component.stroke!;
  return stroke.gradient ? 1 : stroke.color[3] * (stroke.opacity ?? 1);
}

function isVectorShapeDynamic(component: AnimationVectorShapeComponent): boolean {
  if (component.morph || hasAnimatedVectorModifier(component)) return true;
  if (component.fill) return component.fill.kind === 'solid'
    ? component.fill.colorTrack !== undefined || component.fill.opacityTrack !== undefined
    : component.fill.startTrack !== undefined || component.fill.endTrack !== undefined
      || component.fill.stopsTrack !== undefined || component.fill.opacityTrack !== undefined;
  const stroke = component.stroke!;
  return stroke.colorTrack !== undefined || stroke.opacityTrack !== undefined || stroke.widthTrack !== undefined
    || stroke.dashOffsetTrack !== undefined || (stroke.gradient !== undefined && (
      stroke.gradient.startTrack !== undefined || stroke.gradient.endTrack !== undefined
      || stroke.gradient.stopsTrack !== undefined || stroke.gradient.opacityTrack !== undefined
    ));
}

function resolveVectorPath(
  component: AnimationVectorShapeComponent,
  values: readonly number[] | Float32Array,
  time: number,
  closeOpen: boolean,
) {
  if (!component.modifiers?.length) return { commands: component.commands, values: new Float32Array(values) };
  return applyVectorPathModifiers(
    component.commands,
    values,
    component.tolerance ?? 0.35,
    component.modifiers.map(modifier => modifier.kind === 'round-corners'
      ? {
        kind: modifier.kind,
        radius: modifier.radiusTrack ? sampleVectorTrack(modifier.radiusTrack, time)[0] ?? modifier.radius : modifier.radius,
      }
      : {
        kind: modifier.kind,
        start: modifier.startTrack ? sampleVectorTrack(modifier.startTrack, time)[0] ?? modifier.start : modifier.start,
        end: modifier.endTrack ? sampleVectorTrack(modifier.endTrack, time)[0] ?? modifier.end : modifier.end,
        offset: modifier.offsetTrack ? sampleVectorTrack(modifier.offsetTrack, time)[0] ?? modifier.offset : modifier.offset,
        mode: modifier.mode,
      }),
    closeOpen,
  );
}

function hasAnimatedVectorModifier(component: AnimationVectorShapeComponent): boolean {
  return component.modifiers?.some(modifier => modifier.kind === 'round-corners'
    ? modifier.radiusTrack !== undefined
    : modifier.startTrack !== undefined || modifier.endTrack !== undefined || modifier.offsetTrack !== undefined) ?? false;
}

function firstVectorModifierTime(component: AnimationVectorShapeComponent): number | undefined {
  for (const modifier of component.modifiers ?? []) {
    const track = modifier.kind === 'round-corners'
      ? modifier.radiusTrack
      : modifier.startTrack ?? modifier.endTrack ?? modifier.offsetTrack;
    if (track) return track.times[0];
  }
  return undefined;
}

function emptyGeometry2D(): Geometry2D {
  // Geometry2D deliberately rejects empty buffers; a zero-area triangle keeps
  // the renderer contract valid while producing no fragments for an empty trim.
  return new Geometry2D(new Float32Array(6), new Uint16Array([0, 1, 2]));
}

function tessellateRuntimeFillPath(component: AnimationPath2DComponent): Geometry2D {
  try {
    return tessellateAnimationPath(component);
  } catch (error) {
    if (error instanceof RangeError && (
      error.message === 'Animation path contains no drawable closed contour.'
      || error.message === 'Animation path tessellation produced no triangles.'
    )) return emptyGeometry2D();
    throw error;
  }
}

function sampleVectorTrack(track: AnimationVectorValueTrack, time: number): Float32Array {
  const frameCount = track.times.length;
  if (frameCount === 0 || track.valueSize <= 0) return new Float32Array();
  const frame = findVectorTrackFrame(track, time);
  const next = Math.min(frame + 1, frameCount - 1);
  let progress = 0;
  if (next !== frame && track.interpolation !== 'step') {
    const start = track.times[frame]!;
    const end = track.times[next]!;
    progress = clamp((time - start) / Math.max(end - start, 1e-8), 0, 1);
    if (track.interpolation === 'cubic-bezier' && track.easings) {
      const offset = frame * 4;
      progress = cubicBezierYForX(
        progress,
        track.easings[offset] ?? 0.333,
        track.easings[offset + 1] ?? 0.333,
        track.easings[offset + 2] ?? 0.667,
        track.easings[offset + 3] ?? 0.667,
      );
    }
  }
  const result = new Float32Array(track.valueSize);
  const fromOffset = frame * track.valueSize;
  const toOffset = next * track.valueSize;
  for (let index = 0; index < track.valueSize; index++) {
    const from = track.values[fromOffset + index] ?? 0;
    result[index] = mix(from, track.values[toOffset + index] ?? from, progress);
  }
  return result;
}

function findVectorTrackFrame(track: AnimationVectorValueTrack, time: number): number {
  let low = 0;
  let high = track.times.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (track.times[middle]! <= time) low = middle;
    else high = middle - 1;
  }
  return low;
}

function isSourceNodeActiveAt(
  node: Readonly<AnimationNode>,
  time: number,
  nodesById: ReadonlyMap<string, Readonly<AnimationNode>>,
  animationDuration: number,
): boolean {
  let cursor: Readonly<AnimationNode> | undefined = node;
  while (cursor) {
    const start = cursor.start ?? 0;
    const end = start + (cursor.duration ?? animationDuration);
    if (time < start || time > end) return false;
    cursor = cursor.parent ? nodesById.get(cursor.parent) : undefined;
  }
  return true;
}

function isRuntimeNodeActive(
  node: Animation2DRuntimeNode,
  nodesById: ReadonlyMap<string, Animation2DRuntimeNode>,
): boolean {
  let cursor: Animation2DRuntimeNode | undefined = node;
  while (cursor) {
    if (cursor.entity.disabled) return false;
    cursor = cursor.source.parent ? nodesById.get(cursor.source.parent) : undefined;
  }
  return true;
}

function resolveVectorStrokePath(
  component: VectorStrokePathComponent,
  node: Readonly<AnimationNode>,
): VectorStrokePathComponent {
  if (typeof component.commands === 'string' && component.values !== undefined) return component;
  const sourceIndex = component.sourceComponent;
  const source = typeof sourceIndex === 'number' ? node.components?.[sourceIndex] : undefined;
  if (!source || !isPath2DComponent(source)) throw new TypeError('Lottie stroke extension references a missing path2d source component.');
  return { ...component, commands: source.commands, values: source.values };
}

function resolveSourceGroups(nodes: readonly Readonly<AnimationNode>[], sources: ReadonlySet<string>): Map<string, string> {
  const byId = new Map(nodes.map(node => [node.id, node]));
  const result = new Map<string, string>();
  for (const node of nodes) {
    let cursor: Readonly<AnimationNode> | undefined = node;
    while (cursor) {
      if (sources.has(cursor.id)) { result.set(node.id, cursor.id); break; }
      cursor = cursor.parent ? byId.get(cursor.parent) : undefined;
    }
  }
  return result;
}

function resolveInheritedEffects(
  nodes: readonly Readonly<AnimationNode>[],
  sourceGroups: ReadonlyMap<string, string>,
): Map<string, readonly Readonly<AnimationLayerEffect>[]> {
  const byId = new Map(nodes.map(node => [node.id, node]));
  const result = new Map<string, readonly Readonly<AnimationLayerEffect>[]>();
  for (const node of nodes) {
    const sourceBoundary = sourceGroups.get(node.id);
    let cursor: Readonly<AnimationNode> | undefined = node;
    while (cursor) {
      if (cursor.effects?.length) { result.set(node.id, cursor.effects); break; }
      if (cursor.id === sourceBoundary) break;
      cursor = cursor.parent ? byId.get(cursor.parent) : undefined;
    }
  }
  return result;
}

function resolveInheritedComposites(
  nodes: readonly Readonly<AnimationNode>[],
  sourceGroups: ReadonlyMap<string, string>,
): Map<string, Readonly<AnimationComposite>> {
  const byId = new Map(nodes.map(node => [node.id, node]));
  const result = new Map<string, Readonly<AnimationComposite>>();
  for (const node of nodes) {
    const sourceBoundary = sourceGroups.get(node.id);
    let cursor: Readonly<AnimationNode> | undefined = node;
    while (cursor) {
      if (cursor.composite) { result.set(node.id, cursor.composite); break; }
      if (cursor.id === sourceBoundary) break;
      cursor = cursor.parent ? byId.get(cursor.parent) : undefined;
    }
  }
  return result;
}

function compositeLayers(composite: Readonly<AnimationComposite> | undefined): readonly Readonly<AnimationCompositeLayer>[] {
  if (!composite) return [];
  return 'layers' in composite ? composite.layers : [composite];
}

function findFrame(times: Float32Array, time: number, previous: number): number {
  if (times.length <= 1 || time <= times[0]!) return 0;
  if (time >= times[times.length - 1]!) return times.length - 1;
  let cursor = Math.min(previous, times.length - 2);
  if (time >= times[cursor]! && time < times[cursor + 1]!) return cursor;
  let low = 0;
  let high = times.length - 1;
  while (low + 1 < high) {
    const middle = (low + high) >>> 1;
    if (times[middle]! <= time) low = middle;
    else high = middle;
  }
  return low;
}

function sampleProgress(track: ParsedAnimationTrack, frame: number, time: number): number {
  if (frame >= track.times.length - 1 || track.interpolation === 'step') return 0;
  const start = track.times[frame]!;
  const end = track.times[frame + 1]!;
  const linear = clamp((time - start) / Math.max(end - start, 1e-8), 0, 1);
  if (track.interpolation !== 'cubic-bezier' || !track.easings) return linear;
  const offset = frame * 4;
  return cubicBezierYForX(
    linear,
    track.easings[offset]!, track.easings[offset + 1]!,
    track.easings[offset + 2]!, track.easings[offset + 3]!,
  );
}

function cubicBezierYForX(x: number, x1: number, y1: number, x2: number, y2: number): number {
  let t = x;
  for (let iteration = 0; iteration < 5; iteration++) {
    const estimate = bezier(t, x1, x2) - x;
    const derivative = bezierDerivative(t, x1, x2);
    if (Math.abs(derivative) < 1e-5) break;
    t = clamp(t - estimate / derivative, 0, 1);
  }
  return bezier(t, y1, y2);
}

function bezier(t: number, a: number, b: number): number {
  const inverse = 1 - t;
  return 3 * inverse * inverse * t * a + 3 * inverse * t * t * b + t * t * t;
}

function bezierDerivative(t: number, a: number, b: number): number {
  const inverse = 1 - t;
  return 3 * inverse * inverse * a + 6 * inverse * t * (b - a) + 3 * t * t * (1 - b);
}

function mix(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function spatialBezier(start: number, control1: number, control2: number, end: number, t: number): number {
  const inverse = 1 - t;
  return inverse * inverse * inverse * start
    + 3 * inverse * inverse * t * control1
    + 3 * inverse * t * t * control2
    + t * t * t * end;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
