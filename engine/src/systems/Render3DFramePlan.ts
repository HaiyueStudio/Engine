export type Render3DFramePassKind = 'prepare' | 'compute' | 'render' | 'postprocess' | 'cleanup';

export interface Render3DFramePassSnapshot {
  name: string;
  kind: Render3DFramePassKind;
}

interface Render3DFramePass extends Render3DFramePassSnapshot {
  run(): void;
}

export class Render3DFramePlan {
  private readonly _passes: Render3DFramePass[] = [];
  private readonly _snapshot: Render3DFramePassSnapshot[] = [];
  private readonly _passPool: Render3DFramePass[] = [];
  private readonly _snapshotPool: Render3DFramePassSnapshot[] = [];
  private _cursor = 0;

  clear(): this {
    this._passes.length = 0;
    this._snapshot.length = 0;
    this._cursor = 0;
    return this;
  }

  add(name: string, kind: Render3DFramePassKind, run: () => void): this {
    const index = this._cursor++;
    let pass = this._passPool[index];
    let snapshot = this._snapshotPool[index];
    if (!pass || !snapshot) {
      pass = { name, kind, run };
      snapshot = { name, kind };
      this._passPool.push(pass);
      this._snapshotPool.push(snapshot);
    } else {
      pass.name = name;
      pass.kind = kind;
      pass.run = run;
      snapshot.name = name;
      snapshot.kind = kind;
    }
    this._passes.push(pass);
    this._snapshot.push(snapshot);
    return this;
  }

  execute(): void {
    for (const pass of this._passes) {
      pass.run();
    }
  }

  get snapshot(): readonly Render3DFramePassSnapshot[] {
    return this._snapshot;
  }
}
