import {
  Accountset,
  type MiningBidProxySetupMetadata,
  type MiningBidProxySetupPlan,
} from '@argonprotocol/apps-core';
import { type ArgonClient, type KeyringPair } from '@argonprotocol/mainchain';
import { getMainchainClient } from '../stores/mainchain.ts';
import { ExtrinsicType } from './db/TransactionsTable.ts';
import { type TransactionInfo } from './TransactionInfo.ts';
import { TransactionTracker, TxAttemptState } from './TransactionTracker.ts';
import { WalletKeys } from './WalletKeys.ts';

export type MiningBidProxySetupResult =
  | { kind: 'trackingExisting'; txInfo: TransactionInfo<MiningBidProxySetupMetadata> }
  | { kind: 'submitted'; txInfo: TransactionInfo<MiningBidProxySetupMetadata> }
  | { kind: 'ready' }
  | { kind: 'insufficientFunds'; error: string };

export async function planMiningBidProxySetup(args: {
  walletKeys: WalletKeys;
  client: ArgonClient;
}): Promise<{ fundingAccount: KeyringPair; proxySetup: MiningBidProxySetupPlan }> {
  const [fundingAccount, proxyKeypair] = await Promise.all([
    args.walletKeys.getMiningBotKeypair(),
    args.walletKeys.getMiningBidProxyKeypair(),
  ]);
  const proxyAccountset = new Accountset({
    client: args.client,
    fundingAccountId: fundingAccount.address,
    isProxy: true,
    subaccountRange: [],
    txSubmitter: proxyKeypair,
  });
  const proxySetup = await proxyAccountset.planMiningBidProxySetup();

  return { fundingAccount, proxySetup };
}

export async function findTrackedMiningBidProxySetup(args: {
  transactionTracker: TransactionTracker;
  followWindowFinalizedBlocks: number;
}): Promise<TransactionInfo<MiningBidProxySetupMetadata> | undefined> {
  const latestMiningBidProxySetupTxInfo = args.transactionTracker.findLatestTxInfo<MiningBidProxySetupMetadata>(
    txInfo => txInfo.tx.extrinsicType === ExtrinsicType.MiningBidProxySetup,
  );
  if (!latestMiningBidProxySetupTxInfo) {
    return;
  }

  const txAttemptState = await args.transactionTracker.getTxAttemptState(
    latestMiningBidProxySetupTxInfo,
    args.followWindowFinalizedBlocks,
  );
  if (txAttemptState === TxAttemptState.Follow) {
    return latestMiningBidProxySetupTxInfo;
  }
}

export async function ensureMiningBidProxySetup(args: {
  transactionTracker: TransactionTracker;
  walletKeys: WalletKeys;
  followWindowFinalizedBlocks: number;
  client?: ArgonClient;
}): Promise<MiningBidProxySetupResult> {
  const trackedTxInfo = await findTrackedMiningBidProxySetup(args);
  if (trackedTxInfo) {
    return {
      kind: 'trackingExisting',
      txInfo: trackedTxInfo,
    };
  }

  const client = args.client ?? (await getMainchainClient(false));
  const { fundingAccount, proxySetup } = await planMiningBidProxySetup({
    walletKeys: args.walletKeys,
    client,
  });

  if (proxySetup.kind === 'ready') {
    return { kind: 'ready' };
  }

  if (proxySetup.kind === 'insufficientFunds') {
    return {
      kind: 'insufficientFunds',
      error: proxySetup.error,
    };
  }

  const txInfo = await args.transactionTracker.submitAndWatch<MiningBidProxySetupMetadata>({
    tx: proxySetup.tx,
    txSigner: fundingAccount,
    useLatestNonce: true,
    extrinsicType: ExtrinsicType.MiningBidProxySetup,
    metadata: proxySetup.metadata,
  });
  return {
    kind: 'submitted',
    txInfo,
  };
}
