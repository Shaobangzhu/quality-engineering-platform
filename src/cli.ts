#!/usr/bin/env node
import { runCli } from './run-cli.js';

const result = await runCli(process.argv.slice(2));

if (result.exitCode === 0) {
  console.log(result.stdout);
} else {
  console.error(result.stderr);
}

process.exitCode = result.exitCode;
