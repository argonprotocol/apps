import { parseArgs } from 'node:util';
import { configureDevEnvironment } from '../environment.ts';
import { resolveDevProfile } from '../session.ts';

export async function run(args = process.argv.slice(2)): Promise<void> {
  const { values } = parseArgs({ args, options: { help: { type: 'boolean', short: 'h' } } });
  if (values.help) {
    console.info(`Usage: yarn dev desktop

Launch only the desktop app using the prepared environment and services.
Use yarn dev start for normal local startup, or yarn testnet / yarn mainnet for public networks.`);
    return;
  }
  const usePreparedDevEnvironment =
    !process.env.ARGON_DRIVER_WS &&
    (!process.env.ARGON_NETWORK_NAME || process.env.ARGON_NETWORK_NAME === 'dev-docker') &&
    !process.env.ARGON_NETWORK_CONFIG_OVERRIDE;
  if (usePreparedDevEnvironment) {
    const { environment, paths } = await configureDevEnvironment(resolveDevProfile({}));
    if (!environment) throw new Error('No prepared local profile. Run yarn dev start first.');

    process.env.ARGON_APP_INSTANCE_DIR = paths.instanceDir;
    if (environment.ethereumNetwork) {
      process.env.ARGON_NETWORK_CONFIG_OVERRIDE = JSON.stringify({ ethereumNetwork: environment.ethereumNetwork });
    }

    process.env.ARGON_DEV_ETHEREUM = '0';
    process.env.ARGON_DEV_UPSTREAM = '0';
  }

  const { startDesktop } = await import('../desktop.ts');
  await startDesktop({ requireDevDockerServices: usePreparedDevEnvironment });
}
