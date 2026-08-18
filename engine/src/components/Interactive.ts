import { Component, UniqueCheckType } from '../ecs/Component';
import { Entity } from '../ecs/Entity';

export interface InteractiveEvent {
  /** Ephemeral event object reused by InteractionSystem; copy values that must outlive the callback. */
  type: 'pointerenter' | 'pointerleave' | 'pointerdown' | 'pointerup' | 'pointermove' | 'click';
  entity: Entity;
  /** World-space intersection point. */
  point: Float32Array;
  /** Distance from ray origin to hit point. */
  distance: number;
  /** World-space face normal at the hit point. */
  normal: Float32Array;
  nativeEvent: PointerEvent | MouseEvent;
}

export type InteractiveHandler = (e: InteractiveEvent) => void;

export interface InteractiveOptions {
  /**
   * When true the object is completely invisible to raycasting:
   * rays pass through it and no events are fired for it.
   * It also does not occlude other objects behind it.
   */
  penetrable?: boolean;
  onPointerEnter?: InteractiveHandler;
  onPointerLeave?: InteractiveHandler;
  onPointerDown?: InteractiveHandler;
  onPointerUp?: InteractiveHandler;
  onPointerMove?: InteractiveHandler;
  onClick?: InteractiveHandler;
}

export class Interactive extends Component {
  static override UniqueCheckType = UniqueCheckType.SYMBOL | UniqueCheckType.REPLACE;
  static override UniqueSymbol = Symbol.for('Interactive');

  penetrable: boolean;
  onPointerEnter: InteractiveHandler | null;
  onPointerLeave: InteractiveHandler | null;
  onPointerDown: InteractiveHandler | null;
  onPointerUp: InteractiveHandler | null;
  onPointerMove: InteractiveHandler | null;
  onClick: InteractiveHandler | null;

  constructor(options: InteractiveOptions = {}) {
    super('Interactive');
    this.penetrable    = options.penetrable    ?? false;
    this.onPointerEnter = options.onPointerEnter ?? null;
    this.onPointerLeave = options.onPointerLeave ?? null;
    this.onPointerDown  = options.onPointerDown  ?? null;
    this.onPointerUp    = options.onPointerUp    ?? null;
    this.onPointerMove  = options.onPointerMove  ?? null;
    this.onClick        = options.onClick        ?? null;
  }
}
