/** Private physics policy: preserve the original clamp, residual and cap reset.
 * The experimental simulation clock retains backlog and has a different contract.
 */
export class FixedStepClock {
  private accumulator = 0;
  private presentationReset = false;
  private lastTimeMs: number | undefined;

  static validate(step: number, maxSubSteps: number, owner: string): void {
    if (!Number.isFinite(step) || step <= 0) throw new RangeError(`${owner} fixedTimeStep must be a finite number greater than zero.`);
    if (!Number.isSafeInteger(maxSubSteps) || maxSubSteps <= 0) throw new RangeError(`${owner} maxSubSteps must be a positive integer.`);
  }

  static validateDelta(deltaMs: number): void {
    if (!Number.isFinite(deltaMs)) throw new RangeError('Physics frame delta must be finite.');
  }

  alpha(step: number): number { return this.presentationReset ? 1 : Math.min(1, this.accumulator / step); }
  reset(): void { this.accumulator = 0; this.presentationReset = true; this.lastTimeMs = undefined; }

  advance(timeMs: number, deltaMs: number, step: number, maxSubSteps: number, run: (seconds: number) => void): void {
    FixedStepClock.validate(step, maxSubSteps, 'Physics');
    FixedStepClock.validateDelta(deltaMs);
    if (Number.isFinite(timeMs)) {
      const toleranceMs = Math.max(1e-6, Math.abs(timeMs) * Number.EPSILON * 8);
      // A paused World, inactive Scene or stopped/restarted engine has skipped
      // wall time that is absent from this frame's delta. Do not replay its tail.
      if (this.lastTimeMs !== undefined && (timeMs < this.lastTimeMs
        || timeMs - this.lastTimeMs > Math.max(0, deltaMs) + toleranceMs)) this.reset();
      this.lastTimeMs = timeMs;
    }
    if (deltaMs === 0) this.presentationReset = true;
    this.accumulator += Math.min(Math.max(deltaMs / 1000, 0), step * maxSubSteps);
    let steps = 0;
    while (this.accumulator >= step && steps < maxSubSteps) {
      run(step);
      this.presentationReset = false;
      this.accumulator -= step;
      steps++;
    }
    if (steps === maxSubSteps) this.accumulator = 0;
  }
}
