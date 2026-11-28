/** Private synchronous teardown: invalidate first, finish independent owners, then report. */
export class Cleanup {
  private errors: unknown[] | undefined;
  run(action: () => unknown): void {
    try { action(); } catch (error) { (this.errors ??= []).push(error); }
  }
  complete(message: string): void {
    if (this.errors?.length === 1) throw this.errors[0];
    if (this.errors?.length) throw new AggregateError(this.errors, message);
  }
}
