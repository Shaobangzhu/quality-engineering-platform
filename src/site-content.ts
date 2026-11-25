import { isDeepStrictEqual } from 'node:util';
import { isRecord } from './metadata.js';
import { type verifyReportOutput } from './report-output.js';
import { sha256 } from './result-contract-v1.js';

// The localized Awesome 3.33.0 shell includes the CSP and all pinned JS
// assets. Later launches include additional chart assets.
const firstLaunchShell = '58ffd32a3016c350599e9e76c98fe349803f50a4dd4fad319508fd6bc9b985d3';
const historyLaunchShell = '85ae27b953a2c2c517be9b34243c36a4ea6a7bb7a8f361355657743ab0e07209';
const widgets = new Set([
  'statistic', 'pie_chart', 'charts', 'categories', 'resolution-categories', 'timeline',
  'tree', 'nav', 'search-index', 'tree-filters', 'environments', 'variables',
  'allure_environment', 'quality-gate', 'globals',
  'default/statistic', 'default/pie_chart', 'default/tree', 'default/nav',
  'default/search-index', 'default/categories', 'default/resolution-categories', 'default/variables',
].map(name => 'widgets/' + name + '.json'));
const generatedData = /^data\/(?:test-results\/[a-f0-9]{32}|test-env-groups\/[a-f0-9]{32}\.[a-f0-9]{32}|history\/[a-f0-9-]{36})\.json$/;
const launchUuid = /("(?:reportUuid|jobRunUid)":")[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}(?=")/g;
const launchCreatedAt = /("createdAt":)\d{1,16}(?=,)/;
const launchCacheKey = /("cacheKey":")\d{1,16}(?=")/;
const emptyWidgets = {
  'widgets/variables.json': {},
  'widgets/default/variables.json': {},
  'widgets/allure_environment.json': [],
  'widgets/quality-gate.json': {},
};
const caseFields = new Set([
  'id', 'name', 'status', 'retryHash', 'testCaseHash', 'parametersHash', 'environmentHash', 'flaky', 'muted',
  'known', 'isRetry', 'labels', 'groupedLabels', 'parameters', 'links', 'steps', 'error', 'testCase',
  'environment', 'setup', 'teardown', 'history', 'retries', 'breadcrumbs', 'retry', 'transition', 'titlePath',
  'retriesCount', 'retriesStatusChange', 'attachments', 'order', 'categories',
]);
const emptyCaseFields = ['links', 'setup', 'teardown', 'retries', 'titlePath', 'categories'];

function readData(encoded: string) {
  return JSON.parse(Buffer.from(encoded, 'base64').toString()) as unknown;
}

export function approvedSiteContent(
  { html, data, dataStart, dataEnd }: ReturnType<typeof verifyReportOutput>,
  hasPreviousLaunch: boolean,
) {
  const prefix = html.slice(0, dataStart)
    .replace(launchCreatedAt, '$1TIME')
    .replace(launchCacheKey, '$1TIME')
    .replace(launchUuid, '$1UUID');
  if (sha256(prefix + html.slice(dataEnd)) !== (hasPreviousLaunch ? historyLaunchShell : firstLaunchShell)) return false;
  for (const [name, encoded] of data) {
    if (!widgets.has(name) && !generatedData.test(name)) return false;
    if (name.startsWith('data/test-results/')) {
      // The report verifier has already checked identity, provenance, labels,
      // history, steps, errors and attachments for these case objects.
      const item = readData(encoded);
      if (!isRecord(item) || Object.keys(item).some(key => !caseFields.has(key)) ||
        emptyCaseFields.some(key => !isDeepStrictEqual(item[key], []))) return false;
    }
  }
  return Object.entries(emptyWidgets).every(([name, expected]) => {
    const encoded = data.get(name);
    return encoded !== undefined && isDeepStrictEqual(readData(encoded), expected);
  });
}
