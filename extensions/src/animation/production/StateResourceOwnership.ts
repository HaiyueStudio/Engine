import type {ChannelOwnershipPort, RuntimeChannel, RuntimeValue} from '../../hya-state-machine/v2/runtime-types.js';
import {ProductionFrameError} from './FrameTransaction.js';

/** Validates original mixer transfers inside its transaction; the existing whole-frame resource stage owns all handles. */
export class ProductionStateResourceOwnership implements ChannelOwnershipPort {
  private transaction: number | undefined;
  private transfers = 0;
  private disposed = false;
  constructor(private readonly validate: (channel: RuntimeChannel, next: RuntimeValue) => void) {}
  begin(id: number): void {
    if (this.disposed || this.transaction !== undefined || !Number.isSafeInteger(id)) this.fail();
    this.transaction = id; this.transfers = 0;
  }
  transfer(change: Readonly<{channel: RuntimeChannel; previous: RuntimeValue; next: RuntimeValue}>): void {
    if (this.disposed || this.transaction === undefined) this.fail();
    this.validate(change.channel, change.next); this.transfers++;
  }
  commit(id: number): void {if (this.transaction !== id) this.fail(); this.transaction = undefined; this.transfers = 0;}
  rollback(id: number): void {if (this.transaction !== id) return; this.transaction = undefined; this.transfers = 0;}
  reset(): void {this.transaction = undefined; this.transfers = 0;}
  dispose(): void {this.disposed = true; this.reset();}
  private fail(): never {throw new ProductionFrameError('E_HYA_RUNTIME_TRANSACTION', '$.state.resources', 'state resource transfer requires its original frame transaction');}
}
