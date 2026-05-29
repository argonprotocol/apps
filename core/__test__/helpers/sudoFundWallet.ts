import { getClient } from '@argonprotocol/mainchain';
import { sudo } from '@argonprotocol/testing';
import { NetworkConfigSettings } from '../../src/NetworkConfig.ts';
import { submitAndFinalize } from './mainchain.ts';

export interface ISudoFundWalletInput {
  address: string;
  microgons: bigint;
  micronots: bigint;
  archiveUrl?: string;
}

export interface ISudoFundWalletResult {
  address: string;
  requestedMicrogons: bigint;
  requestedMicronots: bigint;
  fundedMicrogons: bigint;
  fundedMicronots: bigint;
}

export async function sudoFundWallet(input: ISudoFundWalletInput): Promise<ISudoFundWalletResult> {
  const client = await getClient(resolveArchiveUrl(input.archiveUrl));
  try {
    const tx = client.tx.sudo.sudo(
      client.tx.utility.batch([
        client.tx.balances.forceSetBalance(input.address, input.microgons),
        client.tx.ownership.forceSetBalance(input.address, input.micronots),
      ]),
    );
    const result = await submitAndFinalize(client, tx, sudo());

    if (result.extrinsicError) {
      throw result.extrinsicError;
    }

    const startedAt = Date.now();
    let fundedMicrogons = 0n;
    let fundedMicronots = 0n;

    while (Date.now() - startedAt < 30_000) {
      const microgonBalance = await client.query.system.account(input.address);
      const micronotBalance = await client.query.ownership.account(input.address);
      fundedMicrogons = microgonBalance.data.free.toBigInt();
      fundedMicronots = micronotBalance.free.toBigInt();

      if (fundedMicrogons >= input.microgons && fundedMicronots >= input.micronots) {
        break;
      }

      await new Promise(resolve => setTimeout(resolve, 1_000));
    }

    if (fundedMicrogons < input.microgons) {
      throw new Error(
        `sudoFundWallet: microgons funding did not apply (requested=${input.microgons}, funded=${fundedMicrogons})`,
      );
    }
    if (fundedMicronots < input.micronots) {
      throw new Error(
        `sudoFundWallet: micronots funding did not apply (requested=${input.micronots}, funded=${fundedMicronots})`,
      );
    }

    return {
      address: input.address,
      requestedMicrogons: input.microgons,
      requestedMicronots: input.micronots,
      fundedMicrogons,
      fundedMicronots,
    };
  } finally {
    await client.disconnect();
  }
}

function resolveArchiveUrl(archiveUrl?: string): string {
  if (archiveUrl?.trim()) {
    return archiveUrl.trim();
  }

  const runtimeOverride = readRuntimeArchiveUrl();
  if (runtimeOverride) {
    return runtimeOverride;
  }

  const networkName = process.env.ARGON_NETWORK_NAME ?? 'dev-docker';
  const config = NetworkConfigSettings[networkName as keyof typeof NetworkConfigSettings];
  if (config?.archiveUrl) {
    return config.archiveUrl;
  }

  throw new Error(
    `sudoFundWallet: unable to resolve archive URL for network "${networkName}". Set ARGON_NETWORK_CONFIG_OVERRIDE or provide archiveUrl.`,
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
