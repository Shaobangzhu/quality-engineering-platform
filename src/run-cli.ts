import packageMetadata from '#package' with { type: 'json' };
import { adaptDgiAllure } from './dgi-allure.js';
import { planCli } from './plan.js';
import { reportCli } from './report-cli.js';
import { resultsCli } from './results.js';
import { runSuiteCli } from './runner.js';
import { siteCli } from './site-cli.js';
import { workspaceCli } from './workspace.js';

const help = `Usage: qe [help | --help | --version]
       qe plan --suite <id> --source <absolute-path> --sha <40-char-sha> [--json]
       qe workspace --suite <id> --source <absolute-path> --sha <40-char-sha> [--json]
       qe run --suite <id> --source <absolute-path> --sha <40-char-sha> [--execute [--install-deps] [--clu-junit]] [--timeout-ms <ms>] [--json]
       qe candidate build --source <absolute-clu-path> --sha <40-char-sha>
       qe candidate verify --sha <40-char-sha>
       qe candidate inject --source <absolute-dgi-path> --sha <reviewed-dgi-sha> --candidate-sha <clu-producer-sha> --integrity <sha512-sri> [--install-deps]
       qe consumer plan|run --clu-source <absolute-path> --clu-sha <40-char-sha> --dgi-source <absolute-path> --dgi-sha <40-char-sha>
       qe consumer run --execute --install-deps <same selectors> [--timeout-ms <ms>]
       qe results collect --run-id <qep-run-uuid>
       qe results verify --run-id <qep-run-uuid>
       qe report plan|build|verify --run-id <qep-run-uuid> [--run-id <qep-run-uuid> ...]
       qe site plan|verify --run-id <qep-run-uuid> [--run-id <qep-run-uuid> ...]
       qe site promote --run-id <qep-run-uuid> [--run-id <qep-run-uuid> ...] --publish
       qe adapt-dgi --run-id <qep-run-uuid>

  adapt-dgi     Verify audited DGI unit evidence and print Contract v1 JSON.
  help, --help  Show this help message.
  --version     Show the QEP version.
  plan          Validate a source checkout and print an execution plan.
  workspace     Provision a detached local checkout for one run.
  run           Plan by default. Execute one catalog suite with --execute.
  candidate     Build, verify or inject a private CLU candidate artifact.
  consumer      Plan or run the sequential CLU-to-DGI compatibility gate.
  report        Plan, build or verify a local Allure report for explicitly selected runs.
  site          Plan, explicitly promote or verify an accepted report on the static site.`;

type CliResult = { exitCode: number; stdout?: string; stderr?: string };

export function runCli(args: readonly string[]): CliResult | Promise<CliResult> {
  const [command, extra] = args;

  if (command === 'report') return reportCli(args.slice(1));
  if (command === 'site') return siteCli(args.slice(1));
  if (command === 'consumer') {
    return import('./consumer.js').then(({ consumerCli }) => consumerCli(args.slice(1))).catch((error: unknown) => ({
      exitCode: 2, stderr: error instanceof Error ? error.message : 'Unable to evaluate the CLU consumer.',
    }));
  }
  if (command === 'candidate') {
    return import('./clu-candidate.js').then(({ candidateCli }) => candidateCli(args.slice(1))).catch((error: unknown) => ({
      exitCode: 2, stderr: error instanceof Error ? error.message : 'Unable to process the CLU candidate.',
    }));
  }

  if (command === 'results') {
    if (args.length !== 4 || (extra !== 'collect' && extra !== 'verify') || args[2] !== '--run-id') {
      return { exitCode: 2, stderr: 'Supply results collect|verify --run-id <qep-run-uuid>.' };
    }
    try {
      return { exitCode: 0, stdout: resultsCli(extra, args[3]) };
    } catch {
      return { exitCode: 2, stderr: 'Invalid or unavailable run evidence or result files.' };
    }
  }

  if (command === 'adapt-dgi') {
    if (args.length !== 3 || extra !== '--run-id') return { exitCode: 2, stderr: 'Supply --run-id <qep-run-uuid>.' };
    try {
      return { exitCode: 0, stdout: JSON.stringify(adaptDgiAllure(args[2]).result) };
    } catch (error) {
      return { exitCode: 2, stderr: error instanceof Error ? error.message : 'Invalid DGI evidence.' };
    }
  }

  if (command === 'run') return runSuiteCli(args.slice(1)).catch((error: unknown) => ({
    exitCode: 2, stderr: error instanceof Error ? error.message : 'Unable to execute the suite.',
  }));

  if (command === 'plan' || command === 'workspace') {
    try {
      return { exitCode: 0, stdout: (command === 'plan' ? planCli : workspaceCli)(args.slice(1)) };
    } catch (error) {
      return { exitCode: 2, stderr: error instanceof Error ? error.message : 'Unable to validate the suite request.' };
    }
  }

  if (command !== undefined && command !== 'help' && command !== '--help' && command !== '--version') {
    return {
      exitCode: 2,
      stderr: `Unknown command ${JSON.stringify(command)}. Run "qe help" for usage.`,
    };
  }

  if (extra !== undefined) {
    return {
      exitCode: 2,
      stderr: `Unexpected argument ${JSON.stringify(extra)}. Run "qe help" for usage.`,
    };
  }

  return { exitCode: 0, stdout: command === '--version' ? packageMetadata.version : help };
}
