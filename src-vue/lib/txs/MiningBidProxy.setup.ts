import {
  Accountset,
  type ArgonClient,
  type MiningBidProxySetupMetadata,
  type MiningBidProxySetupPlan,
  type TxSigningAccount,
} from '@argonprotocol/apps-core';
import type { SubmittableExtrinsic } from '@argonprotocol/mainchain';

import { getMainchainClient } from '../../stores/mainchain.ts';
import type { TransactionInfo } from '../TransactionInfo.ts';
import type { TransactionTracker } from '../TransactionTracker.ts';
import type { WalletKeys } from '../WalletKeys.ts';
import { ExtrinsicType } from '../db/TransactionsTable.ts';
import { TransactionOperation, type TransactionOperationBuild } from './TransactionOperation.ts';

type MiningBidProxySetupTransaction = Extract<MiningBidProxySetupPlan, { kind: 'tx' }>;

type MiningBidProxySetupInput = {
  client: ArgonClient;
  fundingAccount: TxSigningAccount;
  proxySetup: MiningBidProxySetupTransaction;
};

type MiningBidProxySetupBuild = TransactionOperationBuild<MiningBidProxySetupMetadata> & {
  txs: SubmittableExtrinsic[];
};

export type MiningBidProxySetupResult =
  | { kind: 'transaction'; txInfo: TransactionInfo<MiningBidProxySetupMetadata> }
  | { kind: 'ready' }
  | { kind: 'insufficientFunds'; error: string };

export class MiningBidProxySetup extends TransactionOperation<
  MiningBidProxySetupInput,
  MiningBidProxySetupMetadata,
  MiningBidProxySetupBuild
> {
  protected readonly extrinsicType = ExtrinsicType.MiningBidProxySetup;

  constructor(
    private readonly walletKeys: WalletKeys,
    transactionTracker: TransactionTracker,
  ) {
    super(transactionTracker);
  }

  public async ensure(client?: ArgonClient): Promise<MiningBidProxySetupResult> {
    await this.load();
    const pending = this.getPendingTransaction(() => true);
    if (pending) return { kind: 'transaction', txInfo: pending };

    client ??= await getMainchainClient(true);
    const [fundingAccount, proxyAccount] = await Promise.all([
      this.walletKeys.getMiningBotKeypair(),
      this.walletKeys.getMiningBidProxyKeypair(),
    ]);
    const proxySetup = await new Accountset({
      client,
      fundingAccountId: fundingAccount.address,
      isProxy: true,
      subaccountRange: [],
      txSubmitter: proxyAccount,
    }).planMiningBidProxySetup();
    if (proxySetup.kind === 'ready') return { kind: 'ready' };
    if (proxySetup.kind === 'insufficientFunds') return proxySetup;

    return {
      kind: 'transaction',
      txInfo: await this.submit({ client, fundingAccount, proxySetup }),
    };
  }

  protected getOperationKey(input: MiningBidProxySetupInput): string {
    return `${input.proxySetup.metadata.fundingAccountId}:${input.proxySetup.metadata.proxyAccountId}`;
  }

  protected matches(input: MiningBidProxySetupInput, txInfo: TransactionInfo<MiningBidProxySetupMetadata>): boolean {
    return (
      txInfo.tx.metadataJson?.fundingAccountId === input.proxySetup.metadata.fundingAccountId &&
      txInfo.tx.metadataJson.proxyAccountId === input.proxySetup.metadata.proxyAccountId
    );
  }

  protected async build(input: MiningBidProxySetupInput): Promise<MiningBidProxySetupBuild> {
    return {
      client: input.client,
      txs: [input.proxySetup.tx],
      txSigner: input.fundingAccount,
      metadata: input.proxySetup.metadata,
    };
  }
}
