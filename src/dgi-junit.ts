import { parseJUnit } from './junit.js';
import { check } from './dgi-workspace.js';
import type { ResultContractV1 } from './result-contract-v1.js';

export function checkJUnit(bytes: Buffer, expected: ResultContractV1['counts']) {
  const counts = parseJUnit(bytes);
  for (const key of Object.keys(counts) as (keyof typeof counts)[]) check(counts[key] === expected[key], 'JUnit counts');
}
