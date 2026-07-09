interface Counter {
  total: number;
  success: number;
  failure: number;
}

interface MetricsSnapshot {
  submit: Counter;
  estimate: Counter;
  simulate: Counter;
  totalGasUsed: bigint;
}

class Metrics {
  private submitCounter: Counter = { total: 0, success: 0, failure: 0 };
  private estimateCounter: Counter = { total: 0, success: 0, failure: 0 };
  private simulateCounter: Counter = { total: 0, success: 0, failure: 0 };
  private gasUsed = 0n;

  recordSubmit(success: boolean): void {
    this.submitCounter.total += 1;
    if (success) {
      this.submitCounter.success += 1;
    } else {
      this.submitCounter.failure += 1;
    }
  }

  recordEstimate(success: boolean): void {
    this.estimateCounter.total += 1;
    if (success) {
      this.estimateCounter.success += 1;
    } else {
      this.estimateCounter.failure += 1;
    }
  }

  recordSimulate(success: boolean): void {
    this.simulateCounter.total += 1;
    if (success) {
      this.simulateCounter.success += 1;
    } else {
      this.simulateCounter.failure += 1;
    }
  }

  recordGasUsed(gasUsed: bigint): void {
    this.gasUsed += gasUsed;
  }

  getSnapshot(): MetricsSnapshot {
    return {
      submit: { ...this.submitCounter },
      estimate: { ...this.estimateCounter },
      simulate: { ...this.simulateCounter },
      totalGasUsed: this.gasUsed,
    };
  }

  reset(): void {
    this.submitCounter = { total: 0, success: 0, failure: 0 };
    this.estimateCounter = { total: 0, success: 0, failure: 0 };
    this.simulateCounter = { total: 0, success: 0, failure: 0 };
    this.gasUsed = 0n;
  }
}

export const metrics = new Metrics();
