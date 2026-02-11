import { getClient, isAddress, Keyring, TxSubmitter } from '@argonprotocol/mainchain';
import type { E2EFlowRuntime } from '../types.js';
import { readClipboardWithRetries } from './readClipboardWithRetries.js';
import { NetworkConfigSettings } from '@argonprotocol/apps-core';

export interface SudoFundWalletInput {
  address: string;
  microgons: bigint;
  micronots: bigint;
  archiveUrl?: string;
}

export interface SudoFundWalletResult {
  address: string;
  requestedMicrogons: bigint;
  requestedMicronots: bigint;
  fundedMicrogons: bigint;
  fundedMicronots: bigint;
}

export async function getWalletOverlayFundingNeeded(flow: E2EFlowRuntime): Promise<SudoFundWalletInput> {
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

export async function sudoFundWallet(input: SudoFundWalletInput): Promise<SudoFundWalletResult> {
  const networkName = process.env.ARGON_NETWORK_NAME ?? 'dev-docker';
  const config = NetworkConfigSettings[networkName as keyof typeof NetworkConfigSettings];

  const client = await getClient(input.archiveUrl ?? config?.archiveUrl);
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
