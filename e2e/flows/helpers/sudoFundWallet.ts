import { getClient, isAddress, Keyring, TxSubmitter } from '@argonprotocol/mainchain';
import type { IE2EFlowRuntime } from '../types.ts';
import { readClipboardWithRetries } from './readClipboardWithRetries.ts';
import { NetworkConfigSettings } from '@argonprotocol/apps-core/src/NetworkConfig.ts';

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

export async function getWalletOverlayFundingNeeded(flow: IE2EFlowRuntime): Promise<ISudoFundWalletInput> {
  const micronotsNeededRaw = await flow.getAttribute('WalletOverlay.micronotsNeeded', 'data-value');
  const microgonsNeededRaw = await flow.getAttribute('WalletOverlay.microgonsNeeded', 'data-value');
  const address = await readClipboardWithRetries(
    flow,
    () => flow.click('walletAddress.copyContent()'),
    value => isAddress(value),
  );
  if (!address) {
    throw new Error('missing wallet address');
  }

  if (!micronotsNeededRaw) {
    throw new Error('missing micronotsNeeded');
  }
  if (!microgonsNeededRaw) {
    throw new Error('missing microgonsNeeded');
  }

  const micronots = BigInt(micronotsNeededRaw);
  const microgons = BigInt(microgonsNeededRaw);

  return {
    address,
    microgons,
    micronots,
  };
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
    const txSubmitter = new TxSubmitter(client, tx, new Keyring({ type: 'sr25519' }).createFromUri('//Alice'));
    const result = await txSubmitter.submit();
    await result.waitForInFirstBlock;

    const chainAtBlock = result.blockHash ? await client.at(result.blockHash) : client;
    const microgonBalance = await chainAtBlock.query.system.account(input.address);
    const micronotBalance = await chainAtBlock.query.ownership.account(input.address);
    const fundedMicrogons = microgonBalance.data.free.toBigInt();
    const fundedMicronots = micronotBalance.free.toBigInt();

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
