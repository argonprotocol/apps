import { parseArgs } from 'node:util';
import { configureDevEnvironment } from '../environment.ts';
import { DevOutput } from '../output.ts';
import { readDevSession, requestDevSession, resolveDevProfile } from '../session.ts';
import Fs from 'node:fs';

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
    console.info(`Usage: yarn dev status [options]

Show launcher and local Docker service status:
  --profile NAME  Account profile (default: default; alias: --instance)
  --join NAME     Owning local environment
  -h, --help      Show this help`);
    return;
  }
  const profile = resolveDevProfile(values);
  const state = readDevSession(profile);
  const running = state && (await requestDevSession(state, 'status').catch(() => undefined));
  let status = 'closed';
  if (running) status = running.ready ? 'ready' : 'starting';
  console.info(`${profile.instance}: ${status}`);

  const { paths, context, composeArgs } = await configureDevEnvironment(profile);
  Fs.mkdirSync(paths.instanceDir, { recursive: true });
  const output = new DevOutput(paths.logPath);
  try {
    await output.run('docker', [...composeArgs, 'ps'], {
      env: context.composeEnv,
      cwd: context.composeDir,
      stream: true,
    });
  } finally {
    output.close();
  }
}
