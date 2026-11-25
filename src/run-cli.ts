import packageMetadata from '#package' with { type: 'json' };
import { adaptDgiAllure } from './dgi-allure.js';
import { planCli } from './plan.js';
import { runSuiteCli } from './runner.js';
import { workspaceCli } from './workspace.js';

const help = `Usage: qe [help | --help | --version]
       qe plan --suite <id> --source <absolute-path> --sha <40-char-sha> [--json]
       qe workspace --suite <id> --source <absolute-path> --sha <40-char-sha> [--json]
       qe run --suite <id> --source <absolute-path> --sha <40-char-sha> [--execute [--install-deps]] [--timeout-ms <ms>] [--json]
       qe adapt-dgi --run-id <qep-run-uuid>

  adapt-dgi     Verify audited DGI unit evidence and print Contract v1 JSON.
  help, --help  Show this help message.
  --version     Show the QEP version.
  plan          Validate a source checkout and print an execution plan.
  workspace     Provision a detached local checkout for one run.
  run           Plan by default. Execute one catalog suite with --execute.`;

type CliResult = { exitCode: number; stdout?: string; stderr?: string };

export function runCli(args: readonly string[]): CliResult | Promise<CliResult> {
  const [command, extra] = args;

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
