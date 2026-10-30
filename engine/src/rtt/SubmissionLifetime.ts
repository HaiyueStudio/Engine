import type {RenderCommandContext} from '../core/RenderCommandContext';

/** Pins an owned resource through unsubmitted encoders and all submitted queue uses. */
export class SubmissionLifetime {
  private readonly recordings = new Set<object>();
  private submitted = false;
  private retired = false;
  private waiting = false;
  private destroyed = false;
  constructor(private readonly device: GPUDevice, private readonly destroyResource: () => void) {}
  get hasPendingRecordings(): boolean {return this.recordings.size > 0;}
  hasPendingRecordingsOtherThan(token: object | undefined): boolean {
    return this.recordings.size > (token && this.recordings.has(token) ? 1 : 0);
  }
  hasPendingRecordingsNotMatching(matches: (token: object) => boolean): boolean {
    for (const token of this.recordings) if (!matches(token)) return true;
    return false;
  }
  retain(context: RenderCommandContext): void {
    if (context.device !== this.device || !context.afterSubmit || !context.afterCancel) throw new Error('Region caching requires matching submission and cancellation boundaries.');
    this.retainSubmission(context, callback => context.afterSubmit!(callback), callback => context.afterCancel!(callback));
  }
  /** Internal adapter for post passes whose older hosts only expose afterSubmit. */
  retainSubmission(token: object, afterSubmit: (callback:(queue:GPUQueue)=>void)=>void, afterCancel?: (callback:()=>void)=>void): void {
    if (this.retired || this.destroyed) throw new Error('Cannot record a retired resource.');
    if (this.recordings.has(token)) return;
    this.recordings.add(token);
    try {
      afterSubmit(() => {if (!this.recordings.delete(token)) return; this.submitted = true; this.releaseIfReady();});
      afterCancel?.(() => {this.recordings.delete(token); this.releaseIfReady();});
    } catch (error) {this.recordings.delete(token); throw error;}
  }
  retire(): void {this.retired = true; this.releaseIfReady();}
  /** Only for a lost/destroyed device: its encoders cannot be submitted again. */
  abandon(): void {this.retired = true; this.recordings.clear(); this.destroy();}
  private releaseIfReady(): void {
    if (!this.retired || this.recordings.size || this.waiting || this.destroyed) return;
    if (!this.submitted) {this.destroy(); return;}
    this.waiting = true;
    try {void this.device.queue.onSubmittedWorkDone().then(() => this.destroy(), () => this.destroy());}
    catch {this.destroy();}
  }
  private destroy(): void {if (this.destroyed) return; this.destroyed = true; this.destroyResource();}
}
