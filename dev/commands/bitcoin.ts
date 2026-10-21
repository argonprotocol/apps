import { parseArgs } from 'node:util';
import { run as runCompose } from './compose.ts';

export async function run(args = process.argv.slice(2)): Promise<void> {
  const separator = args.indexOf('--');
  const { values, positionals } = parseArgs({
    args: separator < 0 ? args : args.slice(0, separator),
    allowPositionals: true,
    options: {
      profile: { type: 'string' },
      instance: { type: 'string' },
      join: { type: 'string' },
      'chain-spec': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    console.info(`Usage: yarn dev bitcoin [options] -- <arguments>

Run Bitcoin CLI in the owning local environment.
  --profile NAME   Account profile (default: default; alias: --instance)
  --join NAME      Owning local environment
  --chain-spec FILE  Custom chain specification
  -h, --help       Show this help

Arguments after -- are passed unchanged to Bitcoin CLI.`);
    return;
  }
  const composeOptions = Object.entries(values).flatMap(([name, value]) =>
    typeof value === 'string' ? [`--${name}=${value}`] : [],
  );
  const commandArgs = [...positionals, ...(separator < 0 ? [] : args.slice(separator + 1))];
  await runCompose([...composeOptions, '--', '--profile', 'tooling', 'run', '--rm', 'btc-cli', ...commandArgs]);
}
