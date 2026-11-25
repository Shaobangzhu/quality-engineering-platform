import { SaxesParser } from 'saxes';
import { check } from './dgi-workspace.js';
import { limitsV1, type ResultContractV1 } from './result-contract-v1.js';

type Counts = ResultContractV1['counts'];
const attributes = { tests: 'total', failures: 'failed', errors: 'broken', skipped: 'skipped' } as const;
const suiteAttrs = ['name', 'timestamp', 'hostname', 'time', ...Object.keys(attributes)];
const caseAttrs = ['name', 'classname', 'time'];
const outcomes = new Map<string, 'failed' | 'broken' | 'skipped'>([
  ['failure', 'failed'], ['error', 'broken'], ['skipped', 'skipped'],
]);

// Node emits direct testcase children with no aggregate attributes. Vitest
// emits suite aggregates. Count structural outcomes in both and reconcile
// every aggregate supplied by the reporter with its own subtree.
export function checkJUnit(bytes: Buffer, expected: Counts) {
  const parser = new SaxesParser();
  const counts: Counts = { total: 0, passed: 0, failed: 0, broken: 0, skipped: 0, unknown: 0 };
  const stack: string[] = [];
  const suites: { before: Counts; declared: Record<string, string> }[] = [];
  let outcome: keyof Omit<Counts, 'total'> = 'passed';
  let elements = 0;
  parser.on('doctype', () => check(false, 'JUnit doctype'));
  parser.on('processinginstruction', () => check(false, 'JUnit instruction'));
  parser.on('error', () => check(false, 'JUnit XML'));
  parser.on('opentag', ({ name, attributes: attrs }) => {
    const parent = stack.at(-1);
    check(++elements <= 100_000 && stack.length < 16, 'JUnit complexity');
    if (name === 'testsuites' || name === 'testsuite') {
      check(parent === undefined || (name === 'testsuite' && (parent === 'testsuite' || parent === 'testsuites')), 'JUnit suite');
      check(Object.keys(attrs).every(key => suiteAttrs.includes(key)), 'JUnit suite attributes');
      suites.push({ before: { ...counts }, declared: attrs });
    } else if (name === 'testcase') {
      check(parent === 'testsuite' || parent === 'testsuites', 'JUnit testcase');
      check(Object.keys(attrs).every(key => caseAttrs.includes(key)), 'JUnit case attributes');
      outcome = 'passed';
    } else if (outcomes.has(name)) {
      check(parent === 'testcase' && outcome === 'passed', 'JUnit case outcome');
      check(Object.keys(attrs).every(key => key === 'message' || key === 'type'), 'JUnit outcome attributes');
      outcome = outcomes.get(name)!;
    } else {
      check(!Object.keys(attrs).length && (name === 'system-out' || name === 'system-err') && (parent === 'testcase' || parent === 'testsuite'), 'JUnit element');
    }
    stack.push(name);
  });
  parser.on('closetag', ({ name }) => {
    stack.pop();
    if (name === 'testcase') {
      check(++counts.total <= limitsV1.cases, 'JUnit case limit');
      counts[outcome]++;
    } else if (name === 'testsuites' || name === 'testsuite') {
      const { before, declared } = suites.pop()!;
      for (const [attr, key] of Object.entries(attributes)) {
        if (Object.hasOwn(declared, attr)) check(declared[attr] === String(counts[key] - before[key]), 'JUnit suite count');
      }
    }
  });
  // No text, CDATA, failure messages or stack traces enter the output.
  parser.write(new TextDecoder('utf-8', { fatal: true }).decode(bytes)).close();
  for (const key of Object.keys(counts) as (keyof Counts)[]) check(counts[key] === expected[key], 'JUnit counts');
}
