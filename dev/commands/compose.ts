import Fs from 'node:fs';
import { parseArgs } from 'node:util';
import { configureDevEnvironment } from '../environment.ts';
import { DevOutput } from '../output.ts';
import { resolveDevProfile } from '../session.ts';

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
    console.info(`Usage: yarn dev compose [options] -- <arguments>

Run Docker Compose in the owning local environment.
  --profile NAME   Account profile (default: default; alias: --instance)
  --join NAME      Owning local environment
  --chain-spec FILE  Custom chain specification
  -h, --help       Show this help

Arguments after -- are passed unchanged to Docker Compose.`);
    return;
  }
  const profile = resolveDevProfile(values);
  const { paths, context, composeArgs } = await configureDevEnvironment(profile, values['chain-spec']);
  const commandArgs = [...positionals, ...(separator < 0 ? [] : args.slice(separator + 1))];
  Fs.mkdirSync(paths.instanceDir, { recursive: true });
  const output = new DevOutput(paths.logPath);
  try {
    await output.run('docker', [...composeArgs, ...commandArgs], {
      env: context.composeEnv,
      cwd: context.composeDir,
      stream: true,
    });
  } finally {
    output.close();
  }
}
