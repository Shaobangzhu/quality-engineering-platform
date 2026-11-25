import { createHash } from 'node:crypto';
import { types } from 'node:util';
import { limitsV1, parseResultV1, type ResultContractV1 } from './result-contract-v1.js';
import { findSuite } from './suite-catalog.js';

export type AllureResultFile = Readonly<{ name: string; bytes: Buffer }>;
export type AllureCaseInput = {
  uuid: string;
  testCaseId: string;
  name: string;
  status: ResultContractV1['cases'][number]['status'];
  labels: { name: string; value: string }[];
  parameters?: { name: string; value: string }[];
};

type AllureIdentity = 'case' | 'execution' | { launchOccurrences: Map<string, number> };

export const allureExportLimits = Object.freeze({
  files: limitsV1.cases,
  fileBytes: 1024,
  totalBytes: 2 * 1024 * 1024,
});

function malformed(): never {
  throw new Error('Invalid result contract v1: expected plain data.');
}

function readDataProperty(value: object, key: PropertyKey): unknown {
  const property = Object.getOwnPropertyDescriptor(value, key);
  if (!property?.enumerable || !Object.hasOwn(property, 'value')) malformed();
  return property.value;
}

function copyScalar(value: unknown) {
  // The longest v1 string is an execution ID (36 + 1 + 82 characters).
  if (typeof value === 'string' && value.length <= 119) return value;
  if (value === null || (typeof value === 'number' && Number.isFinite(value))) return value;
  return malformed();
}

function copyRecord(value: unknown, copyField: (field: unknown, key: string) => unknown = copyScalar) {
  if (value === null || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value)) malformed();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) malformed();
  const keys = Reflect.ownKeys(value);
  if (keys.length > 10) malformed();
  const copy = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    if (typeof key !== 'string' || key.length > 32) malformed();
    copy[key] = copyField(readDataProperty(value, key), key);
  }
  return copy;
}

function copyCases(value: unknown) {
  if (types.isProxy(value) || !Array.isArray(value)) malformed();
  if (value.length > allureExportLimits.files) throw new Error('Allure export file count limit exceeded.');
  if (Reflect.ownKeys(value).length !== value.length + 1) malformed();
  const cases = [];
  for (let index = 0; index < value.length; index++) {
    cases.push(copyRecord(readDataProperty(value, index)));
  }
  return cases;
}

function executionUuid(executionId: string): string {
  const digest = createHash('sha256').update('qep-allure-execution-v1\0').update(executionId).digest();
  // RFC 9562 UUIDv8 version and variant bits.
  digest[6] = (digest[6] & 0x0f) | 0x80;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  const hex = digest.toString('hex', 0, 16);
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
}

/** Convert one Contract v1 object into filename-sorted UTF-8 Allure result files in memory. */
export function exportAllureResults(result: ResultContractV1, identity: AllureIdentity = 'case'): AllureResultFile[] {
  // Revalidate a bounded plain-data copy so serialization cannot invoke input getters or toJSON.
  const copy = copyRecord(result, (value, key) => {
    if (key === 'cases') return copyCases(value);
    if (key === 'counts') return copyRecord(value);
    return copyScalar(value);
  });
  const contract = parseResultV1(Buffer.from(JSON.stringify(copy)));
  const suite = findSuite(contract.suiteId);
  if (!suite) throw new Error('Unsupported Allure export suite.');
  const labels = [
    { name: 'suite', value: suite.id },
    { name: 'qep.repository', value: suite.repository },
  ];

  const files: AllureResultFile[] = [];
  const uuids = new Set<string>();
  const counts = { total: 0, passed: 0, failed: 0, broken: 0, skipped: 0, unknown: 0 };
  let totalBytes = 0;

  for (const { caseId, executionId, status } of contract.cases) {
    const uuid = executionUuid(executionId);
    if (uuids.has(uuid)) throw new Error('Duplicate Allure result UUID.');
    uuids.add(uuid);
    const [, caseDigest] = caseId.split(':');
    const output: AllureCaseInput = {
      uuid, testCaseId: identity === 'execution' ? uuid : caseId,
      name: 'Case ' + caseDigest.slice(0, 12), status, labels,
    };
    // Additional executions in the same launch need distinct retry identities.
    // The caller traverses runs in canonical Run ID order.
    if (typeof identity === 'object') {
      const occurrence = (identity.launchOccurrences.get(caseId) ?? 0) + 1;
      identity.launchOccurrences.set(caseId, occurrence);
      if (occurrence > 1) output.parameters = [{ name: 'qep.executionSlot', value: String(occurrence) }];
    }
    const bytes = Buffer.from(JSON.stringify(output) + '\n');
    if (bytes.length > allureExportLimits.fileBytes) throw new Error('Allure export file size limit exceeded.');
    totalBytes += bytes.length;
    if (totalBytes > allureExportLimits.totalBytes) throw new Error('Allure export aggregate size limit exceeded.');
    files.push({ name: uuid + '-result.json', bytes });
    counts.total++;
    counts[output.status]++;
  }

  for (const key of Object.keys(counts) as (keyof typeof counts)[]) {
    if (counts[key] !== contract.counts[key]) throw new Error('Allure export counts differ from Result Contract v1.');
  }
  return files.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
