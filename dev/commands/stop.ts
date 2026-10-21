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
    console.info(`Usage: yarn dev stop [options]

Stop the owning local environment and its attached desktops, preserving data:
  --profile NAME  Account profile (default: default; alias: --instance)
  --join NAME     Owning local environment
  -h, --help      Show this help`);
    return;
  }
  await stopDevEnvironment(resolveDevProfile(values));
}
