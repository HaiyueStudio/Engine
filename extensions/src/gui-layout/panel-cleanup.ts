/** Complete every independent GUI owner cleanup before reporting observer failures. */
export class GuiCleanup {
  private readonly errors: unknown[] = [];
  run(action: () => void): void {try {action();} catch (error) {this.errors.push(error);}}
  complete(message: string, failure?: {readonly cause: unknown}): void {
    if (this.errors.length) throw new AggregateError(failure ? [failure.cause, ...this.errors] : this.errors, message);
    if (failure) throw failure.cause;
  }
}
