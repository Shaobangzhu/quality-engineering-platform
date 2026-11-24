export type EvidenceFormat = 'standard' | 'node-spec' | 'dgi-frontend-allure';

const specFields = ['tests', 'suites', 'pass', 'fail', 'cancelled', 'skipped', 'todo'] as const;
const allureLabel = 'Allure audited frontend/unit';
const allureTarget = /^Allure audited frontend\/unit(?=[: \t\r]|$)/;

function allurePassedCount(line: string) {
  // Match the reviewed JSON subset directly. JSON.parse would collapse duplicate
  // keys and could round a fractional or unsafe count before validation.
  const object = /^:[ \t]+\{([^\r\n]*)\}[ \t]*\r?(?![\s\S])/.exec(line.slice(allureLabel.length));
  if (!object) return;
  const seen = new Set<string>();
  let passed: number | undefined;
  for (const entry of object[1]!.split(',')) {
    const field = /^[ \t]*"(passed|failed|broken|unknown|skipped)"[ \t]*:[ \t]*(0|[1-9]\d*)[ \t]*(?![\s\S])/.exec(entry);
    if (!field) return;
    const status = field[1]!;
    const count = Number(field[2]);
    if (seen.has(status) || !Number.isSafeInteger(count) || (status === 'passed' ? count === 0 : count !== 0)) return;
    seen.add(status);
    if (status === 'passed') passed = count;
  }
  return passed;
}

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
  private allurePassed?: number;
  private consolePassed?: number;

  constructor(private readonly format: EvidenceFormat = 'standard') {}

  add(chunk: string) {
    const lines = chunk.split('\n');
    for (const [i, line] of lines.entries()) {
      if (!this.overlong && this.pending.length + line.length > 4096) {
        if (this.format === 'dgi-frontend-allure' &&
          allureTarget.test(this.pending + line.slice(0, allureLabel.length + 1))) this.failedSummary = true;
        this.overlong = true;
      }
      if (!this.overlong) this.pending += line;
      if (i === lines.length - 1) break;
      if (!this.overlong) this.line(this.pending);
      else this.specCounts = [];
      this.pending = '';
      this.overlong = false;
    }
  }

  private line(raw: string) {
    if (this.format === 'dgi-frontend-allure' && allureTarget.test(raw)) {
      const count = allurePassedCount(raw);
      if (count === undefined || this.allurePassed !== undefined) this.failedSummary = true;
      else this.allurePassed = count;
      return;
    }
    const line = raw.trimEnd();
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
      const total = /(?:, (\d+) total|\((\d+)\))$/.exec(summary[1]);
      if (this.format === 'dgi-frontend-allure') {
        if (/\b[1-9]\d* skipped\b/.test(summary[1])) this.failedSummary = true;
        const passed = /\b(\d+) passed\b/.exec(summary[1]);
        if (passed && total) {
          const count = Number(passed[1]);
          if (!Number.isSafeInteger(count) || count !== Number(total[1] ?? total[2]) ||
            (this.consolePassed !== undefined && this.consolePassed !== count)) this.failedSummary = true;
          this.consolePassed = count;
        }
      } else {
        const passed = /\b([1-9]\d*) passed\b/.exec(summary[1]);
        if (passed && total && Number(passed[1]) <= Number(total[1] ?? total[2])) this.passedSummary = true;
      }
    }
    if (this.format === 'dgi-frontend-allure' && /^\s*Test Files\s{2,}.*\b[1-9]\d* failed\b/.test(line)) {
      this.failedSummary = true;
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

  result(stderr?: TestEvidence) {
    this.add('\n');
    stderr?.add('\n');
    if (this.failedSummary || stderr?.failedSummary) return 'failed';
    if (this.format === 'dgi-frontend-allure') {
      // Only stdout can supply positive Allure evidence. Both pipes can veto it.
      const count = this.allurePassed;
      if (count === undefined) return 'missing';
      if (stderr?.allurePassed !== undefined ||
        this.contradictsAllure(count) || stderr?.contradictsAllure(count)) {
        return 'failed';
      }
      return 'passed';
    }
    return this.hasPositiveEvidence() || stderr?.hasPositiveEvidence() ? 'passed' : 'missing';
  }

  private contradictsAllure(count: number) {
    return (this.consolePassed !== undefined && this.consolePassed !== count) ||
      (this.tap && this.hasPositiveEvidence() && (this.passes !== count || this.tests !== count));
  }

  private hasPositiveEvidence() {
    if (this.format === 'node-spec') return this.specComplete;
    return this.tap ? this.tapPlan && this.tests >= this.passes && this.passes > 0 &&
      this.failures === 0 && this.cancelled === 0 : this.passedSummary;
  }
}
