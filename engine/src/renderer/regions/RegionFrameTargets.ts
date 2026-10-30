import type {IEngine} from '../../core/IEngine';
import {RegionColorTarget,type RegionColorTargetSpec} from './RegionColorTarget';

/** Reuses allocation capacity, but each presentation must overwrite all working pixels. */
export class RegionFrameTargets {
  private current:RegionColorTarget|undefined;
  private disposed=false;
  constructor(private readonly engine:IEngine){}
  acquire(spec:RegionColorTargetSpec):RegionColorTarget {
    if(this.disposed)throw Error('Region frame target owner is disposed.');
    const current=this.current;
    if(current&&current.device===this.engine.device&&Object.keys(spec).every(k=>spec[k as keyof RegionColorTargetSpec]===current.spec[k as keyof RegionColorTargetSpec]))return current;
    const next=RegionColorTarget.createWorking(this.engine,spec);
    this.current=next;current?.retire();return next;
  }
  dispose(abandon=false):void {
    if(this.disposed)return;this.disposed=true;
    if(abandon)this.current?.abandon();else this.current?.retire();this.current=undefined;
  }
}
