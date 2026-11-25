import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { verifyLocalAllureHtml } from './allure-generator.js';
import { type AllureResultFile } from './allure-export.js';
import { isRecord } from './metadata.js';
import { type ResultContractV1 } from './result-contract-v1.js';
import { parseStrictJson } from './strict-json.js';

export const reportFileLimits = {
  'index.html': 64 * 1024 * 1024,
  'summary.json': 2 * 1024 * 1024,
  'test-results.json': 4 * 1024 * 1024,
};

type Counts = ResultContractV1['counts'];
type AllureCase = { uuid: string; name: string; status: string; labels: unknown[] };

function readJson(bytes: Buffer) {
  return parseStrictJson(bytes, bytes.length, 16, 10_000);
}

function checkCounts(value: unknown, expected: Counts) {
  if (!isRecord(value) || Object.keys(value).some(key => !Object.hasOwn(expected, key)) ||
      value.total !== expected.total ||
      Object.entries(expected).some(([key, count]) => (Object.hasOwn(value, key) ? value[key] : 0) !== count)) {
    throw new Error('Allure report aggregate count mismatch.');
  }
}

function checkIds(value: unknown, cases: Map<string, AllureCase>) {
  if (!Array.isArray(value) || value.length !== cases.size || new Set(value).size !== cases.size ||
      value.some(id => !cases.has(id))) {
    throw new Error('Allure report case inventory mismatch.');
  }
}

function checkCase(value: unknown, id: string, expected: AllureCase) {
  if (!isRecord(value) || value.id !== id || value.name !== expected.name ||
      value.status !== expected.status || value.environment !== 'default') {
    throw new Error('Allure report case inventory mismatch.');
  }
  return value;
}

// The single-file report embeds the data that the browser actually renders.
function checkEmbedded(html: string, cases: Map<string, AllureCase>, counts: Counts) {
  const assetMarkup = /<script id="allure-single-file-assets" type="application\/json">([^<]+)<\/script>/.exec(html);
  const mainScript = /mainScript\.src = "([a-zA-Z0-9._-]+)";/.exec(html);
  const assets = readJson(Buffer.from(assetMarkup?.[1] ?? ''));
  const app = mainScript && isRecord(assets) ? assets[mainScript[1]] : undefined;
  if (typeof app !== 'string' || !app.startsWith('H4sI')) {
    throw new Error('Incomplete Allure single-file assets.');
  }

  const start = '<script defer>\n      Promise.allSettled([';
  const end = '])\n        .then(function(){\n          window.allureReportDataReady = true;';
  const from = html.indexOf(start);
  const to = html.indexOf(end, from + start.length);
  if (from < 0 || to < 0) throw new Error('Incomplete Allure single-file data.');
  const payload = html.slice(from + start.length, to);
  const token = /d\("([a-zA-Z0-9._/-]+)","([a-zA-Z0-9+/=]+)"\)(,|$)/gy;
  const data = new Map<string, string>();
  while (token.lastIndex < payload.length) {
    const match = token.exec(payload);
    if (!match || data.has(match[1]) || match[1].includes('attachment')) {
      throw new Error('Unexpected Allure single-file data.');
    }
    data.set(match[1], match[2]);
  }
  const read = (name: string) => readJson(Buffer.from(data.get(name) ?? '', 'base64'));
  checkCounts(read('widgets/statistic.json'), counts);
  checkCounts(read('widgets/default/statistic.json'), counts);
  checkIds(read('widgets/nav.json'), cases);
  checkIds(read('widgets/default/nav.json'), cases);
  for (const path of ['widgets/tree.json', 'widgets/default/tree.json']) {
    const tree = read(path);
    if (!isRecord(tree) || !isRecord(tree.leavesById)) throw new Error('Incomplete Allure case tree.');
    checkIds(Object.keys(tree.leavesById), cases);
  }
  const globals = read('widgets/globals.json');
  if (!isDeepStrictEqual(globals, { errors: [], attachments: [] })) throw new Error('Unexpected Allure global data.');

  const prefix = 'data/test-results/';
  checkIds([...data.keys()].filter(name => name.startsWith(prefix)).map(name => {
    if (!name.endsWith('.json')) throw new Error('Unexpected Allure case data.');
    return name.slice(prefix.length, -5);
  }), cases);
  for (const [id, expected] of cases) {
    const actual = checkCase(read(prefix + id + '.json'), id, expected);
    if (!isDeepStrictEqual(actual.labels, expected.labels) || !isRecord(actual.testCase) ||
        actual.testCase.externalId !== expected.uuid || actual.isRetry !== false ||
        !isDeepStrictEqual(actual.attachments, []) || !isDeepStrictEqual(actual.steps, []) ||
        !isDeepStrictEqual(actual.error, {})) {
      throw new Error('Unexpected Allure case data.');
    }
  }
}

export function verifyReportOutput(
  files: Record<keyof typeof reportFileLimits, Buffer>,
  inputs: readonly AllureResultFile[],
  counts: Counts,
) {
  const cases = new Map<string, AllureCase>();
  for (const file of inputs) {
    const item: AllureCase = JSON.parse(file.bytes.toString());
    // Allure 3.33.0 keys its rendered results by MD5 of the Allure input UUID.
    const id = createHash('md5').update(item.uuid).digest('hex');
    if (cases.has(id)) throw new Error('Duplicate Allure case identity.');
    cases.set(id, item);
  }
  const summary = readJson(files['summary.json']);
  if (!isRecord(summary) || summary.plugin !== 'Awesome' || summary.pluginId !== 'awesome' ||
      !isRecord(summary.meta) || summary.meta.singleFile !== true || summary.status !== 'passed' ||
      Object.hasOwn(summary, 'published') ||
      ['commitHref', 'pullRequestHref', 'jobHref', 'ciRunHref'].some(key => summary[key])) {
    throw new Error('Unexpected Allure report format.');
  }
  checkCounts(summary.stats, counts);
  checkIds(summary.newTests, cases);
  const index = readJson(files['test-results.json']);
  if (!isRecord(index) || !isRecord(index.byId) || Object.keys(index).length !== 1) {
    throw new Error('Unexpected Allure case index.');
  }
  checkIds(Object.keys(index.byId), cases);
  for (const [id, expected] of cases) checkCase(index.byId[id], id, expected);
  const html = new TextDecoder('utf-8', { fatal: true }).decode(files['index.html']);
  verifyLocalAllureHtml(html);
  checkEmbedded(html, cases, counts);
}
