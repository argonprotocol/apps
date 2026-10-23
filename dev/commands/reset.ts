import { parseArgs } from 'node:util';
import { resolveDevProfile } from '../session.ts';
import { stopDevEnvironment } from '../stopEnvironment.ts';

export async function run(args = process.argv.slice(2)): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      profile: { type: 'string' },
      instance: { type: 'string' },
      join: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    console.info(`Usage: yarn dev reset [options]

Stop and erase the owning local environment and all its attached profiles:
  --profile NAME  Account profile (default: default; alias: --instance)
  --join NAME     Owning local environment
  -h, --help      Show this help

This removes local chain data, development wallets, and server data.`);
    return;
  }
  await stopDevEnvironment(resolveDevProfile(values), true);
}
