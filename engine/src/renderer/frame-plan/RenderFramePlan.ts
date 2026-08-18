/** Immutable coordinator input. The compiler owns ordering; the submitter only consumes the result. */
export interface RenderFrameItemInput<T> {
  readonly id: number;
  readonly sort: number;
  readonly order: number;
  readonly payload: T;
}

export interface RenderFramePlanItem<T> {
  readonly id: number;
  readonly index: number;
  readonly payload: T;
}

export interface RenderFramePlan<T> {
  readonly revision: number;
  readonly items: readonly RenderFramePlanItem<T>[];
}

/** Device-free deterministic compiler for frame coordinator output. */
export class RenderFramePlanCompiler<T> {
  private _revision = 0;

  compile(inputs: readonly RenderFrameItemInput<T>[]): RenderFramePlan<T> {
    const ordered = [...inputs].sort(compareInputs);
    const ids = new Set<number>();
    const items = new Array<RenderFramePlanItem<T>>(ordered.length);
    for (let index = 0; index < ordered.length; index++) {
      const input = ordered[index]!;
      if (ids.has(input.id)) throw new Error(`Render frame item id ${input.id} is duplicated.`);
      ids.add(input.id);
      items[index] = Object.freeze({ id: input.id, index, payload: input.payload });
    }
    this._revision = nextRevision(this._revision);
    return Object.freeze({ revision: this._revision, items: Object.freeze(items) });
  }
}

function compareInputs<T>(left: RenderFrameItemInput<T>, right: RenderFrameItemInput<T>): number {
  return left.sort - right.sort || left.order - right.order || left.id - right.id;
}

function nextRevision(current: number): number {
  const next = (current + 1) >>> 0;
  return next === 0 ? 1 : next;
}
