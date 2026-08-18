import type { IEngine } from '../core/IEngine';
import { Camera3D } from '../components/Camera3D';
import { FixedScreenTransform3D } from '../components/FixedScreenTransform3D';
import { System } from '../ecs/System';
import type { Entity } from '../ecs/Entity';
import type { World } from '../ecs/World';

export interface FixedScreenTransform3DSystemOptions {
  cameraEntity: Entity;
}

interface VisibleRect {
  canvasX: number;
  canvasY: number;
  screenX: number;
  screenY: number;
  width: number;
  height: number;
  canvasWidth: number;
  canvasHeight: number;
}

export class FixedScreenTransform3DSystem extends System {
  private readonly engine: IEngine;
  private readonly cameraEntity: Entity;
  private _visibleRect: VisibleRect | null = null;

  constructor(engine: IEngine, options: FixedScreenTransform3DSystemOptions) {
    super({ all: [FixedScreenTransform3D] });
    this.engine = engine;
    this.cameraEntity = options.cameraEntity;
    this.priority = -1000;
  }

  override update(world: World, time: number, delta: number): this {
    this._visibleRect = this.getVisibleRect();
    return super.update(world, time, delta);
  }

  override handle(entity: Entity): this {
    const transform = entity.getComponent(FixedScreenTransform3D);
    const camera = this.cameraEntity.getComponent(Camera3D);
    if (!transform || !camera || camera.projectionType !== 'orthographic') return this;

    const visible = this._visibleRect ?? this.getVisibleRect();
    const width = transform.width;
    const height = transform.height;
    const canvasX = transform.left != null
      ? visible.canvasX + transform.left
      : transform.right != null
        ? visible.canvasX + visible.width - transform.right - width
        : visible.canvasX + (visible.width - width) * 0.5;
    const canvasY = transform.top != null
      ? visible.canvasY + transform.top
      : transform.bottom != null
        ? visible.canvasY + visible.height - transform.bottom - height
        : visible.canvasY + (visible.height - height) * 0.5;

    transform.screenRect.x = visible.screenX + (canvasX - visible.canvasX);
    transform.screenRect.y = visible.screenY + (canvasY - visible.canvasY);
    transform.screenRect.width = width;
    transform.screenRect.height = height;

    const orthoWidth = camera.orthoRight - camera.orthoLeft;
    const orthoHeight = camera.orthoTop - camera.orthoBottom;
    const centerX = canvasX + width * 0.5;
    const centerY = canvasY + height * 0.5;
    const worldX = camera.orthoLeft + centerX / visible.canvasWidth * orthoWidth;
    const worldY = camera.orthoTop - centerY / visible.canvasHeight * orthoHeight;
    const worldW = width / visible.canvasWidth * orthoWidth * transform.localScale[0];
    const worldH = height / visible.canvasHeight * orthoHeight * transform.localScale[1];
    transform.setPosition(worldX, worldY, transform.z);
    transform.setScale(worldW, worldH, transform.localScale[2]);
    return this;
  }

  private getVisibleRect(): VisibleRect {
    const canvas = (this.engine as IEngine & { canvas?: HTMLCanvasElement }).canvas;
    if (!canvas || typeof canvas.getBoundingClientRect !== 'function' || typeof window === 'undefined') {
      return {
        canvasX: 0,
        canvasY: 0,
        screenX: 0,
        screenY: 0,
        width: this.engine.displayWidth,
        height: this.engine.displayHeight,
        canvasWidth: this.engine.displayWidth,
        canvasHeight: this.engine.displayHeight,
      };
    }

    const rect = canvas.getBoundingClientRect();
    const screenLeft = Math.max(0, rect.left);
    const screenTop = Math.max(0, rect.top);
    const screenRight = Math.min(window.innerWidth, rect.right);
    const screenBottom = Math.min(window.innerHeight, rect.bottom);
    const width = Math.max(1, screenRight - screenLeft);
    const height = Math.max(1, screenBottom - screenTop);

    return {
      canvasX: screenLeft - rect.left,
      canvasY: screenTop - rect.top,
      screenX: screenLeft,
      screenY: screenTop,
      width,
      height,
      canvasWidth: Math.max(1, rect.width || this.engine.displayWidth),
      canvasHeight: Math.max(1, rect.height || this.engine.displayHeight),
    };
  }
}
