import { createArgonClient, NetworkConfigSettings, isValidArgonAccountAddress } from '@argonprotocol/apps-core';
import { getClient } from '@argonprotocol/mainchain';
import { sudoFundWallet } from '@argonprotocol/apps-core/__test__/helpers/sudoFundWallet.ts';

type FundArgonAccountArgs = {
  to: string;
  archiveUrl?: string;
  microgons?: bigint;
  micronots?: bigint;
};

export async function fundArgonAccount(args: FundArgonAccountArgs): Promise<void> {
  const address = parseAccountArg(args.to);
  const microgons = resolveRuntimeAmount(args.microgons, 'ARGN');
  const micronots = resolveRuntimeAmount(args.micronots, 'ARGNOT');
  if (microgons === 0n && micronots === 0n) {
    throw new Error('Provide an ARGN or ARGNOT amount to fund on Argon.');
  }

  const archiveUrl = resolveArchiveUrl(args.archiveUrl);

  const client = createArgonClient(await getClient(archiveUrl));
  try {
    const [microgonBalance, micronotBalance] = await Promise.all([
      client.query.system.account(address),
      client.query.ownership.account(address),
    ]);
    await sudoFundWallet({
      client,
      address,
      microgons: microgonBalance.data.free + microgons,
      micronots: micronotBalance.free + micronots,
    });
  } finally {
    await client.disconnect();
  }
}

function parseAccountArg(value: string | undefined): string {
  if (!value?.trim()) {
    throw new Error('Missing required --to address');
  }
  if (!isValidArgonAccountAddress(value)) {
    throw new Error(`Invalid Argon address: ${value}`);
  }

  return value;
}

function resolveRuntimeAmount(runtimeAmount: bigint | undefined, label: string): bigint {
  if (runtimeAmount !== undefined) {
    if (runtimeAmount < 0n) {
      throw new Error(`${label} runtime amount must be non-negative: ${runtimeAmount}`);
    }
    return runtimeAmount;
  }

  return 0n;
}

function resolveArchiveUrl(archiveUrl?: string): string {
  if (archiveUrl?.trim()) {
    return archiveUrl.trim();
  }

  const runtimeOverride = readRuntimeArchiveUrl();
  if (runtimeOverride) {
    return runtimeOverride;
  }

  const configuredArchiveUrl = process.env.ARGON_ARCHIVE_URL?.trim();
  if (configuredArchiveUrl) {
    return configuredArchiveUrl;
  }

  const networkName = process.env.ARGON_NETWORK_NAME ?? 'dev-docker';
  const config = NetworkConfigSettings[networkName as keyof typeof NetworkConfigSettings];
  if (config?.archiveUrl) {
    return config.archiveUrl;
  }

  throw new Error(
    `fund-argon-account: unable to resolve archive URL for network "${networkName}". Set ARGON_ARCHIVE_URL, ARGON_NETWORK_CONFIG_OVERRIDE, or provide --archive.`,
  );
}

function readRuntimeArchiveUrl(): string | null {
  const raw = process.env.ARGON_NETWORK_CONFIG_OVERRIDE?.trim();
  if (!raw) return null;

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const candidate = (parsed as { archiveUrl?: unknown }).archiveUrl;
    return typeof candidate === 'string' && candidate.trim() ? candidate.trim() : null;
  } catch {
    return null;
  }
}
