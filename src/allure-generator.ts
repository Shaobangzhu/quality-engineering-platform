import { spawnSync } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { exportAllureResults } from './allure-export.js';
import { type ResultContractV1 } from './result-contract-v1.js';

const version = '3.33.0';
const root = resolve(import.meta.dirname, '..');
const cli = join(root, 'node_modules', 'allure', 'cli.js');
const config = {
  name: 'QEP Allure Report',
  open: false,
  plugins: {
    awesome: { options: { singleFile: true, publish: false } },
    agent: { enabled: false }, // Allure 3.33.0 otherwise adds this plugin by default.
  },
};
const reportFiles = ['index.html', 'summary.json', 'test-results.json'];

function runAllure(cwd: string, args: readonly string[]) {
  const result = spawnSync(process.execPath, [cli, '--no-update-notifier', ...args], {
    cwd,
    // Keep Git/CI discovery and user-level settings out of the generated report.
    env: { HOME: cwd, PATH: cwd, TMPDIR: cwd },
    encoding: 'utf8',
    timeout: 120_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Allure CLI failed (${result.signal ?? result.status}): ${result.stderr || result.stdout}`);
  }
  return { exitCode: result.status, stdout: result.stdout };
}

function verifyReport(output: string, counts: ResultContractV1['counts']) {
  const files = readdirSync(output, { withFileTypes: true });
  if (files.length !== reportFiles.length ||
      files.some(file => !file.isFile() || !reportFiles.includes(file.name))) {
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
  const html = readFileSync(index, 'utf8');
  // Awesome 3.33.0 hardcodes this browser analytics block in the report template.
  const analytics = /<script async src="https:\/\/www\.googletagmanager\.com\/gtag\/js\?id=G-LNDJ3J7WT0"><\/script>\s*<script>\s*window\.dataLayer = window\.dataLayer \|\| \[\];[\s\S]*?<\/script>/;
  const localHtml = html.replace(analytics, '');
  const charset = '<meta charset="utf-8">';
  if (!html.startsWith('<!DOCTYPE html>') || !html.includes(charset) ||
      !html.includes('id="allure-single-file-assets"') || !html.includes('window.allureReportDataReady = true') ||
      !html.includes(`"allureVersion":"${version}"`) ||
      localHtml === html || localHtml.includes('www.googletagmanager.com')) {
    throw new Error('Unexpected Allure single-file HTML format.');
  }
  const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline' data:; img-src data: blob:; font-src data:; connect-src data: blob:">`;
  writeFileSync(index, localHtml.replace(charset, `${charset}\n    ${csp}`));
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
    if (runAllure(run, ['--version']).stdout.trim() !== version) {
      throw new Error(`Expected local Allure CLI version ${version}.`);
    }
    const input = join(run, 'allure-results');
    mkdirSync(input);
    for (const file of files) writeFileSync(join(input, file.name), file.bytes);
    writeFileSync(join(run, 'allurerc.json'), JSON.stringify(config));
    const { exitCode } = runAllure(run, ['generate', '--config', 'allurerc.json',
      '--output', 'report.pending', 'allure-results']);

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
    return { version, exitCode, input, report };
  } catch (error) {
    rmSync(run, { recursive: true, force: true });
    throw error;
  }
}
