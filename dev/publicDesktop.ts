import { runYarn } from '../core/__test__/helpers/runYarn.ts';

export async function startPublicNetworkDesktop(
  network: 'testnet' | 'mainnet',
  requestedProfile?: string,
): Promise<void> {
  const [configuredProfile, port, extraPort] = process.env.ARGON_APP_INSTANCE?.split(':') ?? [];
  if (extraPort !== undefined || (port !== undefined && (!/^\d+$/.test(port) || +port < 1 || +port > 65535))) {
    throw new Error('ARGON_APP_INSTANCE must have an optional :port between 1 and 65535.');
  }
  const profile = requestedProfile ?? (configuredProfile || 'default');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(profile)) {
    throw new Error('Invalid profile name. Use letters, numbers, hyphens, or underscores.');
  }
  const instance = profile
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  process.env.ARGON_NETWORK_NAME = network;
  process.env.ARGON_APP_INSTANCE = port ? `${instance}:${port}` : instance;

  runYarn(['generate:runtime-client']);
  const { startDesktop } = await import('./desktop.ts');
  await startDesktop();
}
