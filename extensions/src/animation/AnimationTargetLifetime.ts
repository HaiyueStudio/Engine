import type {RenderCommandContext} from '@haiyue/engine/extension-authoring';

interface TargetLease {
  readonly device: GPUDevice;
  readonly release: () => void;
  recordings: number;
  submitted: boolean;
  retired: boolean;
  finished: boolean;
}
interface Recording {readonly targets: Set<TargetLease>; closed: boolean;}
const deviceOwners = new WeakMap<GPUDevice, Set<(device: GPUDevice) => void>>();

/** Private mask/effect ownership through public recording callbacks and the actual device queue. */
export class AnimationTargetLifetime<T extends object> {
  private readonly targets = new Map<T, TargetLease>();
  private readonly retired = new Map<T, TargetLease>();
  private readonly recordings = new WeakMap<RenderCommandContext, Recording>();
  private readonly abandonDevice = (device: GPUDevice): void => {
    for (const [target, lease] of this.targets) if (lease.device === device) this.finish(target, lease);
  };

  own(target: T, device: GPUDevice, release: () => void): void {
    if (this.targets.has(target)) return;
    this.targets.set(target, {device, release, recordings: 0, submitted: false, retired: false, finished: false});
    let owners = deviceOwners.get(device);
    if (!owners) {
      owners = new Set(); deviceOwners.set(device, owners); const live = owners;
      void device.lost.then(() => {for (const owner of [...live]) owner(device); live.clear();});
    }
    owners.add(this.abandonDevice);
  }

  has(target: T, device: GPUDevice): boolean {
    const lease = this.targets.get(target);
    return !!lease && !lease.retired && lease.device === device;
  }

  retain(target: T, context: RenderCommandContext): void {
    const previous = this.recordings.get(context);
    if (previous?.closed) throw new Error('Cannot record animation targets after submission or cancellation.');
    const lease = this.targets.get(target);
    if (!lease || lease.retired || lease.device !== context.device) throw new Error('Animation target is retired or belongs to another device.');
    if (!context.afterSubmit || !context.afterCancel) {
      // Direct hosts own their encoders; retain the existing conservative queue-fence contract.
      lease.submitted = true; return;
    }
    if (previous) {
      if (!previous.targets.has(lease)) {previous.targets.add(lease); lease.recordings++;}
      return;
    }
    const recording: Recording = {targets: new Set([lease]), closed: false};
    this.recordings.set(context, recording); lease.recordings++;
    const close = (submitted: boolean): void => {
      if (recording.closed) return; recording.closed = true;
      for (const value of recording.targets) {value.recordings--; value.submitted ||= submitted;}
      recording.targets.clear(); this.collect();
    };
    try {context.afterCancel(() => close(false)); context.afterSubmit(() => close(true));}
    catch (error) {close(false); throw error;}
  }

  retire(target: T): void {
    const lease = this.targets.get(target);
    if (!lease || lease.retired) return;
    lease.retired = true; this.retired.set(target, lease); this.collect();
  }

  retireAll(): void {
    for (const [target, lease] of this.targets) if (!lease.retired) {lease.retired = true; this.retired.set(target, lease);}
    this.collect();
  }

  private collect(): void {
    const queues = new Map<GPUQueue, Array<[T, TargetLease]>>();
    for (const [target, lease] of this.retired) {
      if (lease.recordings > 0) continue;
      this.retired.delete(target);
      if (!lease.submitted) {this.finish(target, lease); continue;}
      const values = queues.get(lease.device.queue) ?? [];
      values.push([target, lease]); queues.set(lease.device.queue, values);
    }
    for (const [queue, targets] of queues) {
      const finish = (): void => {for (const [target, lease] of targets) this.finish(target, lease);};
      try {void queue.onSubmittedWorkDone().then(finish, finish);} catch {finish();}
    }
  }

  private finish(target: T, lease: TargetLease): void {
    if (lease.finished) return;
    lease.finished = true; this.targets.delete(target); this.retired.delete(target);
    try {lease.release();} finally {
      if (![...this.targets.values()].some(value => value.device === lease.device)) deviceOwners.get(lease.device)?.delete(this.abandonDevice);
    }
  }
}
