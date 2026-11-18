import packageMetadata from '#package' with { type: 'json' };

const help = `Usage: qe [help | --help | --version]

  help, --help  Show this help message.
  --version     Show the QEP version.`;

type CliResult = { exitCode: 0; stdout: string } | { exitCode: 2; stderr: string };

export function runCli(args: readonly string[]): CliResult {
  const [command, extra] = args;

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
