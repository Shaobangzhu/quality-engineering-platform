import packageMetadata from '#package' with { type: 'json' };
import { planCli } from './plan.js';
import { workspaceCli } from './workspace.js';

const help = `Usage: qe [help | --help | --version]
       qe plan --suite <id> --source <absolute-path> --sha <40-char-sha> [--json]
       qe workspace --suite <id> --source <absolute-path> --sha <40-char-sha> [--json]

  help, --help  Show this help message.
  --version     Show the QEP version.
  plan          Validate a source checkout and print an execution plan.
  workspace     Provision a detached local checkout for one run.`;

type CliResult = { exitCode: 0; stdout: string } | { exitCode: 2; stderr: string };

export function runCli(args: readonly string[]): CliResult {
  const [command, extra] = args;

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
