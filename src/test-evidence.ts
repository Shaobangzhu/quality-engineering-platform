export type EvidenceFormat = 'standard' | 'node-spec';

const specFields = ['tests', 'suites', 'pass', 'fail', 'cancelled', 'skipped', 'todo'] as const;

// Consume only bounded lines. Never retain a child's output as an artifact.
export class TestEvidence {
  private pending = '';
  private overlong = false;
  private tap = false;
  private tests = 0;
  private passes = 0;
  private failures?: number;
  private cancelled?: number;
  private tapPlan = false;
  private passedSummary = false;
  private failedSummary = false;
  private specCounts: number[] = [];
  private specComplete = false;

  constructor(private readonly format: EvidenceFormat = 'standard') {}

  add(chunk: string) {
    const lines = chunk.split('\n');
    for (const [i, line] of lines.entries()) {
      if (this.pending.length + line.length > 4096) this.overlong = true;
      if (!this.overlong) this.pending += line;
      if (i === lines.length - 1) break;
      if (!this.overlong) this.line(this.pending.trimEnd());
      else this.specCounts = [];
      this.pending = '';
      this.overlong = false;
    }
  }

  private line(line: string) {
    if (this.format === 'node-spec') {
      this.specLine(line);
      return;
    }
    if (line === 'TAP version 13') this.tap = true;
    if (this.tap && /^1\.\.[1-9]\d*$/.test(line)) this.tapPlan = true;
    if (this.tap && /^(?:not ok |Bail out!)/.test(line)) this.failedSummary = true;
    const tap = /^# (tests|pass|fail|cancelled) (\d+)$/.exec(line);
    if (this.tap && tap) {
      const count = Number(tap[2]);
      if ((tap[1] === 'fail' || tap[1] === 'cancelled') && count > 0) this.failedSummary = true;
      switch (tap[1]) {
        case 'tests': this.tests = count; break;
        case 'pass': this.passes = count; break;
        case 'fail': this.failures = count; break;
        case 'cancelled': this.cancelled = count; break;
      }
    }
    // Jest and Vitest emit one aggregate Tests line, sometimes including skips.
    const summary = /^\s*Tests(?::\s+|\s{2,})(.+)$/.exec(line);
    if (summary) {
      if (/\b[1-9]\d* failed\b/.test(summary[1])) this.failedSummary = true;
      const passed = /\b([1-9]\d*) passed\b/.exec(summary[1]);
      const total = /(?:, (\d+) total|\((\d+)\))$/.exec(summary[1]);
      if (passed && total && Number(passed[1]) <= Number(total[1] ?? total[2])) this.passedSummary = true;
    }
  }

  private specLine(line: string) {
    const count = /^ℹ (tests|suites|pass|fail|cancelled|skipped|todo) (0|[1-9]\d*)$/.exec(line);
    if (count?.[1] === 'tests' && this.specComplete) this.failedSummary = true;
    if (count && (count[1] === 'fail' || count[1] === 'cancelled') && Number(count[2]) > 0) {
      this.failedSummary = true;
    }
    if (count && count[1] === specFields[this.specCounts.length] && Number.isSafeInteger(Number(count[2]))) {
      this.specCounts.push(Number(count[2]));
      return;
    }
    if (this.specCounts.length === specFields.length && /^ℹ duration_ms \d+(?:\.\d+)?$/.test(line)) {
      const [tests, , pass, fail, cancelled, skipped, todo] = this.specCounts;
      if (this.specComplete || tests !== pass + fail + cancelled + skipped + todo) this.failedSummary = true;
      this.specComplete = pass > 0 && fail === 0 && cancelled === 0;
    }
    this.specCounts = count?.[1] === 'tests' && Number.isSafeInteger(Number(count[2])) ? [Number(count[2])] : [];
  }

  result() {
    this.add('\n');
    if (this.failedSummary) return 'failed';
    if (this.format === 'node-spec') return this.specComplete ? 'passed' : 'missing';
    const complete = this.tap ? this.tapPlan && this.tests >= this.passes && this.passes > 0 &&
      this.failures === 0 && this.cancelled === 0 : this.passedSummary;
    return complete ? 'passed' : 'missing';
  }
}
