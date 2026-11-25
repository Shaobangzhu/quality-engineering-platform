import assert from 'node:assert/strict';
import { generateAllureReport } from '../../dist/allure-generator.js';
import { createCaseId, createExecutionId, deriveCounts } from '../../dist/result-contract-v1.js';

const suiteId = 'clu-unit';
const runId = 'aaaaaaaa-aaaa-4aaa-baaa-aaaaaaaaaaaa';
const statuses = ['passed', 'failed', 'broken', 'skipped', 'unknown', 'failed'];
const cases = statuses.map((status, index) => {
  const caseId = createCaseId(suiteId, `synthetic/allure#${index}`);
  return { caseId, executionId: createExecutionId(runId, caseId), status };
});
const counts = deriveCounts(cases);
const result = {
  schemaVersion: 1, suiteId, runId, sourceCommit: 'a'.repeat(40),
  executionStatus: 'FAIL', childExitCode: 1, collectionState: 'PARTIAL', cases, counts,
};
const before = structuredClone(result);
const report = generateAllureReport(result);
assert.deepEqual(result, before);
assert.equal(report.exitCode, 0);
console.log(JSON.stringify({ ...report, counts }));
