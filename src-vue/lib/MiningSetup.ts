import {
  type ArgonClient,
  bigIntMax,
  bigIntMin,
  MINING_BID_PROXY_FEE_FLOAT,
  type MiningBidProxySetupMetadata,
  MoveFrom,
  MoveTo,
  MoveToken,
} from '@argonprotocol/apps-core';

import { getMainchainClient } from '../stores/mainchain.ts';
import type { Config } from './Config.ts';
import { getTransactionFailureMessage, type TransactionInfo } from './TransactionInfo.ts';
import { TxAttemptState, type TransactionTracker } from './TransactionTracker.ts';
import type { IWallet } from './Wallet.ts';
import {
  existentialDepositMicrogons,
  existentialDepositMicronots,
  getSpendableDefaultArgonMicrogons,
} from './WalletForArgon.ts';
import { ExtrinsicType } from './db/TransactionsTable.ts';
import type { WalletKeys } from './WalletKeys.ts';
import { BalanceTransfer, type IAssetsToMove, type ITransactionMoveMetadata } from './txs/Balance.transfer.ts';
import type { MiningBidProxySetup, MiningBidProxySetupResult } from './txs/MiningBidProxy.setup.ts';

export interface MiningSetupInput {
  defaultWallet: IWallet;
  miningBotWallet: IWallet;
  config: Config;
  client?: ArgonClient;
}

export type MiningSetupResult =
  | {
      kind: 'transaction';
      txInfo: TransactionInfo;
      waitForCompletion: Promise<void>;
    }
  | { kind: 'ready' }
  | { kind: 'noSpendableFundsToSweep' }
  | { kind: 'blocked'; error: string };

export class MiningSetup {
  private readonly fundingTransfer: BalanceTransfer;
  private ensurePromise?: Promise<MiningSetupResult>;

  constructor(
    walletKeys: WalletKeys,
    private readonly transactionTracker: TransactionTracker,
    private readonly proxySetup: MiningBidProxySetup,
  ) {
    this.fundingTransfer = new BalanceTransfer(walletKeys, transactionTracker, {
      ownsTransfer: txInfo => this.isFundingTransfer(txInfo),
      onFinalized: txInfo => this.completeFunding(txInfo),
    });
  }

  public async load(): Promise<void> {
    await Promise.all([this.fundingTransfer.load(), this.proxySetup.load()]);
  }

  public async ensure(input: MiningSetupInput): Promise<MiningSetupResult> {
    if (this.ensurePromise) return await this.ensurePromise;

    const promise = this.ensureInner(input);
    this.ensurePromise = promise;
    try {
      return await promise;
    } finally {
      if (this.ensurePromise === promise) this.ensurePromise = undefined;
    }
  }

  private async ensureInner(input: MiningSetupInput): Promise<MiningSetupResult> {
    await this.load();

    const recoveredFunding = await this.findIncompleteFundingTransaction();
    if (recoveredFunding) {
      if (recoveredFunding.tx.isFinalized && !recoveredFunding.hasPendingPostProcessing) {
        const proxySetup = await this.ensureLinkedProxySetup(recoveredFunding, input.client);
        if (proxySetup.kind === 'ready') return proxySetup;
        if (proxySetup.kind === 'insufficientFunds') return { kind: 'blocked', error: proxySetup.error };
        return {
          kind: 'transaction',
          txInfo: proxySetup.txInfo,
          waitForCompletion: proxySetup.txInfo.waitForPostProcessing,
        };
      }

      this.fundingTransfer.resume(recoveredFunding);
      return this.trackFunding(recoveredFunding);
    }

    const funding = await this.createFunding(input);
    if (funding.kind !== 'funding') {
      if (funding.kind !== 'ready') return funding;

      const proxySetup = await this.proxySetup.ensure(input.client);
      if (proxySetup.kind === 'ready') return proxySetup;
      if (proxySetup.kind === 'insufficientFunds') return { kind: 'blocked', error: proxySetup.error };
      return {
        kind: 'transaction',
        txInfo: proxySetup.txInfo,
        waitForCompletion: proxySetup.txInfo.waitForPostProcessing,
      };
    }

    const txInfo = await this.fundingTransfer.submit({
      moveFrom: MoveFrom.DefaultArgon,
      moveTo: MoveTo.MiningBot,
      assetsToMove: funding.assetsToMove,
      workflow: 'miningSetup',
      client: funding.client,
    });
    return this.trackFunding(txInfo);
  }

  private async createFunding(
    input: MiningSetupInput,
  ): Promise<
    | { kind: 'funding'; assetsToMove: IAssetsToMove; client: ArgonClient }
    | { kind: 'ready' }
    | { kind: 'noSpendableFundsToSweep' }
    | { kind: 'blocked'; error: string }
  > {
    const { defaultWallet, miningBotWallet, config } = input;
    const spendableMicrogons = getSpendableDefaultArgonMicrogons(defaultWallet.availableMicrogons);
    const spendableMicronots = bigIntMax(defaultWallet.availableMicronots - existentialDepositMicronots, 0n);
    const requiredMicrogons = bigIntMax(
      config.biddingRules.initialMicrogonRequirement +
        MINING_BID_PROXY_FEE_FLOAT -
        (miningBotWallet.availableMicrogons + miningBotWallet.reservedMicrogons),
      0n,
    );
    const requiredMicronots = bigIntMax(
      config.biddingRules.initialMicronotRequirement -
        (miningBotWallet.availableMicronots + miningBotWallet.reservedMicronots),
      0n,
    );
    if (requiredMicrogons === 0n && requiredMicronots === 0n) return { kind: 'ready' };

    const requestedAssets: IAssetsToMove = {};
    if (spendableMicrogons > 0n && requiredMicrogons > 0n) {
      requestedAssets[MoveToken.ARGN] = bigIntMin(requiredMicrogons, spendableMicrogons);
    }
    if (spendableMicronots > 0n && requiredMicronots > 0n) {
      requestedAssets[MoveToken.ARGNOT] = bigIntMin(requiredMicronots, spendableMicronots);
    }
    if (!requestedAssets[MoveToken.ARGN] && !requestedAssets[MoveToken.ARGNOT]) {
      return { kind: 'noSpendableFundsToSweep' };
    }

    const client = input.client ?? (await getMainchainClient(false));
    let transactionFeeMicrogons: bigint;
    try {
      transactionFeeMicrogons = await this.fundingTransfer.estimateFee({
        moveFrom: MoveFrom.DefaultArgon,
        moveTo: MoveTo.MiningBot,
        assetsToMove: requestedAssets,
        client,
      });
    } catch (error) {
      console.error('[MiningSetup] Unable to calculate funding fee', error);
      return { kind: 'blocked', error: 'Unable to calculate transaction fee.' };
    }
    if (transactionFeeMicrogons > defaultWallet.availableMicrogons) {
      return { kind: 'blocked', error: 'Your wallet has insufficient funds for this transaction.' };
    }

    let assetsToMove: IAssetsToMove = {};
    const microgonsAfterFee = bigIntMin(
      requestedAssets[MoveToken.ARGN] ?? 0n,
      bigIntMax(spendableMicrogons - transactionFeeMicrogons, 0n),
    );
    if (microgonsAfterFee >= existentialDepositMicrogons) assetsToMove[MoveToken.ARGN] = microgonsAfterFee;

    if (requestedAssets[MoveToken.ARGNOT]) {
      if (requestedAssets[MoveToken.ARGN] && !assetsToMove[MoveToken.ARGN]) {
        assetsToMove = { [MoveToken.ARGNOT]: requestedAssets[MoveToken.ARGNOT] };
        try {
          transactionFeeMicrogons = await this.fundingTransfer.estimateFee({
            moveFrom: MoveFrom.DefaultArgon,
            moveTo: MoveTo.MiningBot,
            assetsToMove,
            client,
          });
        } catch (error) {
          console.error('[MiningSetup] Unable to calculate ARGNOT-only funding fee', error);
          return { kind: 'blocked', error: 'Unable to calculate transaction fee.' };
        }
        if (transactionFeeMicrogons > defaultWallet.availableMicrogons) {
          return { kind: 'blocked', error: 'Your wallet has insufficient funds for this transaction.' };
        }
      } else {
        assetsToMove[MoveToken.ARGNOT] = requestedAssets[MoveToken.ARGNOT];
      }
    }
    if (!assetsToMove[MoveToken.ARGN] && !assetsToMove[MoveToken.ARGNOT]) {
      return { kind: 'noSpendableFundsToSweep' };
    }

    return { kind: 'funding', assetsToMove, client };
  }

  private trackFunding(txInfo: TransactionInfo<ITransactionMoveMetadata>): MiningSetupResult {
    return {
      kind: 'transaction',
      txInfo,
      waitForCompletion: txInfo.waitForPostProcessing,
    };
  }

  private async completeFunding(txInfo: TransactionInfo<ITransactionMoveMetadata>): Promise<void> {
    const proxySetup = await this.ensureLinkedProxySetup(txInfo);
    if (proxySetup.kind === 'insufficientFunds') throw new Error(proxySetup.error);
    if (proxySetup.kind === 'ready') return;
    await proxySetup.txInfo.waitForPostProcessing;
  }

  private async ensureLinkedProxySetup(
    fundingTxInfo: TransactionInfo<ITransactionMoveMetadata>,
    client?: ArgonClient,
  ): Promise<MiningBidProxySetupResult> {
    const linkedTxInfo = (await fundingTxInfo.followOnTxInfo) as
      | TransactionInfo<MiningBidProxySetupMetadata>
      | undefined;
    if (linkedTxInfo && !getTransactionFailureMessage(linkedTxInfo)) {
      return { kind: 'transaction', txInfo: linkedTxInfo };
    }

    const proxySetup = await this.proxySetup.ensure(client);
    if (proxySetup.kind !== 'transaction') return proxySetup;

    if (!linkedTxInfo) this.transactionTracker.createIntentForFollowOnTx(fundingTxInfo).resolve(proxySetup.txInfo);
    return proxySetup;
  }

  private async findIncompleteFundingTransaction(): Promise<TransactionInfo<ITransactionMoveMetadata> | undefined> {
    const fundingTransactions = this.transactionTracker.data.txInfos.filter(txInfo => {
      return (
        txInfo.tx.extrinsicType === ExtrinsicType.Transfer &&
        this.isFundingTransfer(txInfo as TransactionInfo<ITransactionMoveMetadata>)
      );
    }) as TransactionInfo<ITransactionMoveMetadata>[];
    const latest = fundingTransactions.reduce<TransactionInfo<ITransactionMoveMetadata> | undefined>(
      (selected, txInfo) => (!selected || txInfo.tx.id > selected.tx.id ? txInfo : selected),
      undefined,
    );
    if (!latest) return;

    if (latest.tx.followOnTxId) {
      const followOn = this.transactionTracker.data.txInfos.find(txInfo => txInfo.tx.id === latest.tx.followOnTxId);
      if (
        !followOn ||
        getTransactionFailureMessage(followOn) ||
        !followOn.tx.isFinalized ||
        followOn.hasPendingPostProcessing
      ) {
        return latest;
      }
      return;
    }

    const newerProxySetup = this.transactionTracker.data.txInfos.some(
      txInfo => txInfo.tx.extrinsicType === ExtrinsicType.MiningBidProxySetup && txInfo.tx.id > latest.tx.id,
    );
    if (newerProxySetup) return;

    const state = await this.transactionTracker.getTxAttemptState(latest, 2);
    if (state === TxAttemptState.Pending || latest.tx.isFinalized) return latest;
  }

  private isFundingTransfer(txInfo: TransactionInfo<ITransactionMoveMetadata>): boolean {
    const metadata = txInfo.tx.metadataJson;
    return Boolean(
      metadata &&
        !getTransactionFailureMessage(txInfo) &&
        (metadata.workflow === 'miningSetup' ||
          (!metadata.workflow &&
            !metadata.allocationChange &&
            metadata.moveFrom === MoveFrom.DefaultArgon &&
            metadata.moveTo === MoveTo.MiningBot)),
    );
  }
}
