import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { historyChartTypes, verifyLocalAllureHtml } from './allure-generator.js';
import { type AllureCaseInput, type AllureResultFile } from './allure-export.js';
import { isRecord } from './metadata.js';
import { type HistoryPoint } from './report-history.js';
import { type ResultContractV1 } from './result-contract-v1.js';
import { parseStrictJson } from './strict-json.js';

export const reportFileLimits = {
  'index.html': 64 * 1024 * 1024,
  'summary.json': 2 * 1024 * 1024,
  'test-results.json': 4 * 1024 * 1024,
};

type Counts = ResultContractV1['counts'];
type AllureCase = AllureCaseInput & { testCaseHash: string; retryHash: string };
type RenderedHistory = { point: HistoryPoint; previous: readonly HistoryPoint[] };
const md5 = (value: string) => createHash('md5').update(value).digest('hex');

function readJson(bytes: Buffer) {
  return parseStrictJson(bytes, bytes.length, 16, 10_000);
}

function checkCounts(value: unknown, expected: Counts, newCount?: number) {
  if (!isRecord(value) || Object.keys(value).some(key => !Object.hasOwn(expected, key) && !(key === 'new' && newCount !== undefined)) ||
      value.total !== expected.total ||
      (newCount !== undefined && (Object.hasOwn(value, 'new') ? value.new : 0) !== newCount) ||
      Object.entries(expected).some(([key, count]) => (Object.hasOwn(value, key) ? value[key] : 0) !== count)) {
    throw new Error('Allure report aggregate count mismatch.');
  }
}

function checkIds(value: unknown, cases: ReadonlyMap<string, unknown> | ReadonlySet<string>) {
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

function checkHistoryPoint(history: HistoryPoint, cases: Map<string, AllureCase>) {
  if (Object.keys(history.testResults).length !== cases.size) throw new Error('Allure report case inventory mismatch.');
  checkIds(history.knownTestCaseIds, new Set([...cases.values()].map(item => item.testCaseHash)));
  for (const [id, expected] of cases) {
    const item = checkCase(history.testResults[expected.retryHash], id, expected);
    if (!isDeepStrictEqual(item.labels, expected.labels)) throw new Error('Unexpected Allure history case data.');
  }
}

function matchingHistory(previous: readonly HistoryPoint[], retryHash: string) {
  return previous.flatMap(point => Object.hasOwn(point.testResults, retryHash) ? [point.testResults[retryHash]] : []);
}

function checkHistoryWidgets(data: Map<string, string>, read: (name: string) => unknown, counts: Counts, previous: readonly HistoryPoint[]) {
  // Awesome 3.33.0 embeds at most six complete prior history points.
  const assets = previous.slice(0, 6).map(point => [`data/history/${point.uuid}.json`, point] as const);
  if (assets.length !== [...data.keys()].filter(name => name.startsWith('data/history/')).length ||
      assets.some(([name, point]) => !isDeepStrictEqual(read(name), point)) ||
      !isDeepStrictEqual(read('widgets/timeline.json'), [])) {
    throw new Error('Unexpected Allure embedded history data.');
  }
  const charts = read('widgets/charts.json');
  if (!isRecord(charts) || !isRecord(charts.general) || !isDeepStrictEqual(charts.byEnv, {})) {
    throw new Error('Unexpected Allure history charts.');
  }
  const types = Object.values(charts.general).map(chart => {
    if (!isRecord(chart) || typeof chart.type !== 'string') throw new Error('Unexpected Allure history charts.');
    if (chart.type === 'currentStatus') checkCounts(chart.data, counts);
    return chart.type;
  });
  if (!isDeepStrictEqual(types.sort(), historyChartTypes(previous.length > 0).sort())) {
    throw new Error('Unexpected Allure history charts.');
  }
}

// The single-file report embeds the data that the browser actually renders.
function checkEmbedded(html: string, cases: Map<string, AllureCase>, counts: Counts, history?: RenderedHistory, newCount?: number) {
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
  checkCounts(read('widgets/statistic.json'), counts, newCount);
  checkCounts(read('widgets/default/statistic.json'), counts, newCount);
  if (history) checkHistoryWidgets(data, read, counts, history.previous);
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
        actual.testCase.externalId !== expected.testCaseId || actual.testCase.id !== expected.testCaseHash ||
        actual.retryHash !== expected.retryHash || actual.isRetry !== false ||
        !isDeepStrictEqual(actual.attachments, []) || !isDeepStrictEqual(actual.steps, []) ||
        !isDeepStrictEqual(actual.error, {})) {
      throw new Error('Unexpected Allure case data.');
    }
    if (history && (!isDeepStrictEqual(actual.history, matchingHistory(history.previous, expected.retryHash)) ||
        actual.transition !== history.point.testResults[expected.retryHash].transition ||
        ['start', 'stop', 'duration'].some(key => Object.hasOwn(actual, key)))) {
      throw new Error('Unexpected Allure case history.');
    }
  }
  return { data, dataStart: from + start.length, dataEnd: to };
}

export function verifyReportOutput(
  files: Record<keyof typeof reportFileLimits, Buffer>,
  inputs: readonly AllureResultFile[],
  counts: Counts,
  history?: RenderedHistory,
) {
  const cases = new Map<string, AllureCase>();
  const retryHashes = new Set<string>();
  for (const file of inputs) {
    const item: AllureCaseInput = JSON.parse(file.bytes.toString());
    // Allure 3.33.0 keys its rendered results by MD5 of the Allure input UUID.
    const id = md5(item.uuid);
    const testCaseHash = md5(item.testCaseId);
    const parametersHash = md5(item.parameters?.map(({ name, value }) => `${name}:${value}`).join(',') ?? '');
    const retryHash = `${testCaseHash}.${parametersHash}`;
    if (cases.has(id) || retryHashes.has(retryHash)) throw new Error('Duplicate Allure case identity.');
    cases.set(id, { ...item, testCaseHash, retryHash });
    retryHashes.add(retryHash);
  }
  const summary = readJson(files['summary.json']);
  if (!isRecord(summary) || summary.plugin !== 'Awesome' || summary.pluginId !== 'awesome' ||
      !isRecord(summary.meta) || summary.meta.singleFile !== true || summary.status !== 'passed' ||
      Object.hasOwn(summary, 'published') || (history && summary.meta.reportId !== history.point.uuid) ||
      ['commitHref', 'pullRequestHref', 'jobHref', 'ciRunHref'].some(key => summary[key])) {
    throw new Error('Unexpected Allure report format.');
  }
  const newCases = new Set([...cases].filter(([, item]) => !history?.previous.some(point =>
    Object.hasOwn(point.testResults, item.retryHash))).map(([id]) => id));
  const newCount = history ? newCases.size : undefined;
  checkCounts(summary.stats, counts, newCount);
  checkIds(summary.newTests, newCases);
  if (history) checkHistoryPoint(history.point, cases);
  const index = readJson(files['test-results.json']);
  if (!isRecord(index) || !isRecord(index.byId) || Object.keys(index).length !== 1) {
    throw new Error('Unexpected Allure case index.');
  }
  checkIds(Object.keys(index.byId), cases);
  for (const [id, expected] of cases) checkCase(index.byId[id], id, expected);
  const html = new TextDecoder('utf-8', { fatal: true }).decode(files['index.html']);
  verifyLocalAllureHtml(html);
  return { html, ...checkEmbedded(html, cases, counts, history, newCount) };
}
