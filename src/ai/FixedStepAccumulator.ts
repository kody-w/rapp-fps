export interface FixedStepAccumulatorSnapshot {
  fixedStepSeconds: number;
  accumulatedSeconds: number;
  completedTicks: number;
  simulatedSeconds: number;
  renderSeconds: number;
}

export class FixedStepAccumulator {
  private accumulatedSeconds = 0;
  private completedTicks = 0;
  private renderSeconds = 0;

  constructor(readonly fixedStepSeconds: number) {
    if (!Number.isFinite(fixedStepSeconds) || fixedStepSeconds <= 0) {
      throw new Error(`Fixed step must be positive and finite; received ${fixedStepSeconds}`);
    }
  }

  advance(renderDeltaSeconds: number, fixedUpdate: (stepSeconds: number) => void): number {
    if (!Number.isFinite(renderDeltaSeconds) || renderDeltaSeconds < 0) {
      throw new Error(`Render delta must be finite and non-negative; received ${renderDeltaSeconds}`);
    }

    this.renderSeconds += renderDeltaSeconds;
    this.accumulatedSeconds += renderDeltaSeconds;
    const epsilon = this.fixedStepSeconds * 1e-9;
    let frameTicks = 0;
    while (this.accumulatedSeconds + epsilon >= this.fixedStepSeconds) {
      fixedUpdate(this.fixedStepSeconds);
      this.accumulatedSeconds -= this.fixedStepSeconds;
      if (Math.abs(this.accumulatedSeconds) <= epsilon) this.accumulatedSeconds = 0;
      this.completedTicks++;
      frameTicks++;
    }
    return frameTicks;
  }

  snapshot(): FixedStepAccumulatorSnapshot {
    return {
      fixedStepSeconds: this.fixedStepSeconds,
      accumulatedSeconds: this.accumulatedSeconds,
      completedTicks: this.completedTicks,
      simulatedSeconds: this.completedTicks * this.fixedStepSeconds,
      renderSeconds: this.renderSeconds,
    };
  }
}
