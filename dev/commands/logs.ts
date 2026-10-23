import Fs from 'node:fs';
import Path from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { getDevPaths, resolveDevProfile } from '../session.ts';

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
    console.info(`Usage: yarn dev logs [options]

Show available log-file links:
  --profile NAME  Account profile (default: default; alias: --instance)
  --join NAME     Owning local environment
  -h, --help      Show this help`);
    return;
  }
  const profile = resolveDevProfile(values);
  const { logPath, upstreamDir } = getDevPaths(profile);
  const available = [logPath, Path.join(upstreamDir, 'operator-worker.log')].filter(file => Fs.existsSync(file));
  if (!available.length) console.info(`No logs yet for ${profile.instance}. Start it with yarn dev.`);
  for (const file of available) console.info(pathToFileURL(file).href);
}
