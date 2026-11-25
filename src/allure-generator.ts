import { spawnSync } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { exportAllureResults } from './allure-export.js';
import { type ResultContractV1 } from './result-contract-v1.js';

export const allureVersion = '3.33.0';
export const allureReportName = 'QEP Allure Report';
export const allureHistoryName = 'history.jsonl';
const root = resolve(import.meta.dirname, '..');
const pkg = join(root, 'node_modules', 'allure');
const cli = join(pkg, 'cli.js');
const config = {
  name: allureReportName,
  open: false,
  plugins: {
    awesome: { options: { singleFile: true, publish: false } },
    agent: { enabled: false }, // Allure 3.33.0 otherwise adds this plugin by default.
  },
};
export const allureReportFiles = ['index.html', 'summary.json', 'test-results.json'] as const;
export class AllureGeneratorError extends Error {}

export function historyChartTypes(hasPreviousLaunch: boolean) {
  return hasPreviousLaunch ? ['currentStatus', 'coverageDiff', 'successRateDistribution'] : ['currentStatus'];
}

function runAllure(cwd: string, args: readonly string[]) {
  const result = spawnSync(process.execPath, [cli, '--no-update-notifier', ...args], {
    cwd,
    // Keep Git/CI discovery and user-level settings out of the generated report.
    env: { HOME: cwd, PATH: cwd, TMPDIR: cwd },
    encoding: 'utf8',
    timeout: 120_000,
    killSignal: 'SIGKILL',
  });
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT') {
    throw new AllureGeneratorError('Allure generator timed out.');
  }
  if (result.error) throw new AllureGeneratorError('Unable to execute the local Allure generator.');
  if (result.status !== 0) {
    throw new AllureGeneratorError(`Allure generator failed (${result.signal ?? result.status}).`);
  }
  return { exitCode: result.status, stdout: result.stdout };
}

export function generateAllureInStage(stage: string, history?: { hasPreviousLaunch: boolean }) {
  const metadata = join(pkg, 'package.json');
  if (!lstatSync(pkg, { throwIfNoEntry: false })?.isDirectory() ||
      !lstatSync(cli, { throwIfNoEntry: false })?.isFile() ||
      !lstatSync(metadata, { throwIfNoEntry: false })?.isFile()) {
    throw new AllureGeneratorError('Pinned local Allure generator is missing.');
  }
  const installed = JSON.parse(readFileSync(metadata, 'utf8'));
  if (installed.name !== 'allure' || installed.version !== allureVersion ||
      runAllure(stage, ['--version']).stdout.trim() !== allureVersion) {
    throw new AllureGeneratorError(`Expected local Allure CLI version ${allureVersion}.`);
  }
  // Contract v1 exports no case timings. Allure's time-series charts would
  // display zero timestamps or durations for missing values.
  const stageConfig = history ? {
    ...config, historyPath: allureHistoryName, appendHistory: true,
    plugins: {
      ...config.plugins,
      awesome: { options: { ...config.plugins.awesome.options,
        charts: historyChartTypes(history.hasPreviousLaunch).map(type => ({ type })),
      } },
    },
  } : config;
  writeFileSync(join(stage, 'allurerc.json'), JSON.stringify(stageConfig), { flag: 'wx', mode: 0o600 });
  return runAllure(stage, ['generate', '--config', 'allurerc.json', '--output', 'report.pending', 'allure-results']).exitCode;
}

function verifyReport(output: string, counts: ResultContractV1['counts']) {
  const files = readdirSync(output, { withFileTypes: true });
  if (files.length !== allureReportFiles.length ||
      files.some(file => !file.isFile() || !allureReportFiles.some(name => name === file.name))) {
    throw new Error('Unexpected Allure report inventory.');
  }
  const summary = JSON.parse(readFileSync(join(output, 'summary.json'), 'utf8'));
  if (summary.plugin !== 'Awesome' || summary.pluginId !== 'awesome' ||
      summary.meta?.singleFile !== true || Object.hasOwn(summary, 'published') ||
      ['commitHref', 'pullRequestHref', 'jobHref', 'ciRunHref'].some(key => summary[key])) {
    throw new Error('Unexpected Allure report format.');
  }
  for (const [key, expected] of Object.entries(counts)) {
    const actual = key === 'total' ? summary.stats?.total : (summary.stats?.[key] ?? 0);
    if (actual !== expected) throw new Error(`Unexpected Allure report count for ${key}.`);
  }

  const index = join(output, 'index.html');
  writeFileSync(index, localizeAllureHtml(readFileSync(index, 'utf8')));
}

// Awesome 3.33.0 hardcodes this browser analytics block in the report template.
const analytics = /<script async src="https:\/\/www\.googletagmanager\.com\/gtag\/js\?id=G-LNDJ3J7WT0"><\/script>\s*<script>\s*window\.dataLayer = window\.dataLayer \|\| \[\];[\s\S]*?<\/script>/;
const charset = '<meta charset="utf-8">';
const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline' data:; img-src data: blob:; font-src data:; connect-src data: blob:">`;

export function localizeAllureHtml(html: string) {
  const localHtml = html.replace(analytics, '').replace(charset, `${charset}\n    ${csp}`);
  if (!analytics.test(html) || html.includes(csp)) throw new Error('Unexpected Allure analytics markup.');
  verifyLocalAllureHtml(localHtml);
  return localHtml;
}

export function verifyLocalAllureHtml(html: string) {
  if (!html.startsWith('<!DOCTYPE html>') || !html.includes(charset) ||
      !html.trimEnd().endsWith('</html>') || !html.includes(csp) ||
      !html.includes('id="allure-single-file-assets"') || !html.includes('window.allureReportDataReady = true') ||
      !html.includes(`"allureVersion":"${allureVersion}"`) || html.includes('www.googletagmanager.com')) {
    throw new Error('Unexpected Allure single-file HTML format.');
  }
}

/** Generate a local static report from one validated batch, independently of the test runner. */
export function generateAllureReport(result: ResultContractV1) {
  const files = exportAllureResults(result);
  if (files.length === 0) throw new Error('Allure report requires at least one case.');

  const local = join(root, '.local');
  mkdirSync(local, { recursive: true, mode: 0o700 });
  const storage = lstatSync(local);
  if (!storage.isDirectory() || (storage.mode & 0o022) || storage.uid !== process.getuid?.()) {
    throw new Error('Allure report requires an owner-controlled QEP .local directory.');
  }
  const run = mkdtempSync(join(local, 'allure-'));
  try {
    const input = join(run, 'allure-results');
    mkdirSync(input);
    for (const file of files) writeFileSync(join(input, file.name), file.bytes);
    const exitCode = generateAllureInStage(run);

    if (readdirSync(input).length !== files.length || files.some(({ name, bytes }) => {
      const path = join(input, name);
      return !lstatSync(path).isFile() || !readFileSync(path).equals(bytes);
    })) {
      throw new Error('Allure generator changed the input results.');
    }
    const pending = join(run, 'report.pending');
    verifyReport(pending, result.counts);
    const report = join(run, 'report');
    renameSync(pending, report);
    return { version: allureVersion, exitCode, input, report };
  } catch (error) {
    rmSync(run, { recursive: true, force: true });
    throw error;
  }
}
