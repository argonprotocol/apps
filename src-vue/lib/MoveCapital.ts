import { getMainchainClient } from '../stores/mainchain.ts';
import { ArgonClient, FIXED_U128_DECIMALS, SubmittableExtrinsic, toFixedNumber } from '@argonprotocol/mainchain';
import {
  bigIntMax,
  isDefaultArgonMoveFrom,
  isValidArgonAccountAddress,
  MoveFrom,
  MoveTo,
  MoveToken,
} from '@argonprotocol/apps-core';
import { MyVault } from './MyVault.ts';
import { existentialDepositMicrogons, getSpendableDefaultArgonMicrogons } from './WalletForArgon.ts';
import { IWallet, WalletType } from './Wallet.ts';
import { ExtrinsicType } from './db/TransactionsTable.ts';
import { TransactionInfo } from './TransactionInfo.ts';
import { WalletKeys } from './WalletKeys.ts';
import { TransactionTracker, TxAttemptState } from './TransactionTracker.ts';
import { ensureMiningBidProxySetup } from './MiningAccount.ts';
import { Config } from './Config.ts';

export interface IAssetsToMove {
  [MoveToken.ARGN]?: bigint;
  [MoveToken.ARGNOT]?: bigint;
}

export type IMoveCapitalWalletType = WalletType.defaultArgon | WalletType.miningBot | 'vaulting';

let pendingDefaultArgonMiningTransferPromise: Promise<DefaultArgonMiningTransferResult> | undefined;
const DEFAULT_ARGON_MINING_TRANSFER_FOLLOW_WINDOW_FINALIZED_BLOCKS = 2;

export class MoveCapital {
  public transactionError: string = '';

  private walletKeys: WalletKeys;
  private transactionTracker: TransactionTracker;
  private myVault: MyVault;

  constructor(walletKeys: WalletKeys, transactionTracker: TransactionTracker, myVault: MyVault) {
    this.walletKeys = walletKeys;
    this.transactionTracker = transactionTracker;
    this.myVault = myVault;
  }

  public getWalletTypeFromMove(moveFrom: MoveFrom): IMoveCapitalWalletType {
    switch (moveFrom) {
      case MoveFrom.DefaultArgon:
        return WalletType.defaultArgon;

      case MoveFrom.MiningBot:
        return WalletType.miningBot;

      case MoveFrom.VaultingSecurity:
        return 'vaulting';
    }
  }

  public async move(
    moveFrom: MoveFrom,
    moveTo: MoveTo,
    assetsToMove: IAssetsToMove,
    fromWallet: IWallet,
    toAddress: string,
    shouldDeductFeeFromCapital = false,
    prependedTxs: SubmittableExtrinsic[] = [],
    client?: ArgonClient,
  ): Promise<TransactionInfo> {
    client ??= await getMainchainClient(false);

    if ([MoveTo.VaultingSecurity].includes(moveTo)) {
      this.validateVaultAllocationMove(moveFrom, moveTo, assetsToMove);
    }

    if (shouldDeductFeeFromCapital) {
      const fee = await this.calculateFee(moveFrom, moveTo, assetsToMove, fromWallet, toAddress, prependedTxs, client);
      assetsToMove = {
        [MoveToken.ARGN]: assetsToMove[MoveToken.ARGN] ? assetsToMove[MoveToken.ARGN] - fee : 0n,
        [MoveToken.ARGNOT]: assetsToMove[MoveToken.ARGNOT] ?? 0n,
      };
    }
    if ([MoveTo.VaultingSecurity].includes(moveTo)) {
      return await this.myVault.increaseVaultSecuritization({
        addedSecuritizationMicrogons: moveTo === MoveTo.VaultingSecurity ? (assetsToMove.ARGN ?? 0n) : 0n,
        metadata: this.buildMoveMetadata(moveFrom, moveTo, assetsToMove, toAddress),
      });
    } else {
      const transaction = await this.buildTransaction(moveFrom, moveTo, assetsToMove, toAddress, prependedTxs, client);
      const { tx, metadata } = transaction;
      const txSigner = await this.getSigner(moveFrom);
      return await this.transactionTracker.submitAndWatch({
        tx,
        txSigner,
        metadata,
        extrinsicType: ExtrinsicType.Transfer,
      });
    }
  }

  public async moveConfiguredDefaultArgonToBot(
    wallet: IWallet,
    walletKeys: WalletKeys,
    config: Config,
  ): Promise<DefaultArgonMiningTransferResult> {
    if (pendingDefaultArgonMiningTransferPromise) {
      return await pendingDefaultArgonMiningTransferPromise;
    }

    const sweepPromise = this.moveConfiguredDefaultArgonToBotInner(wallet, walletKeys, config);
    pendingDefaultArgonMiningTransferPromise = sweepPromise;

    try {
      return await sweepPromise;
    } finally {
      if (pendingDefaultArgonMiningTransferPromise === sweepPromise) {
        pendingDefaultArgonMiningTransferPromise = undefined;
      }
    }
  }

  public async moveLegacyMiningHoldToDefault(
    legacyWallet: IWallet,
    walletKeys: WalletKeys,
  ): Promise<DefaultArgonMiningTransferResult> {
    await this.transactionTracker.load();
    this.transactionError = '';

    const latestSweepTxInfo = this.transactionTracker.findLatestTxInfo<ITransactionMoveMetadata>(txInfo => {
      const metadata = txInfo.tx.metadataJson;
      return (
        txInfo.tx.extrinsicType === ExtrinsicType.Transfer &&
        isDefaultArgonMoveFrom(metadata?.moveFrom) &&
        metadata?.moveTo === MoveTo.External &&
        metadata?.externalAddress === walletKeys.defaultArgonAddress
      );
    });
    if (latestSweepTxInfo) {
      const txAttemptState = await this.transactionTracker.getTxAttemptState(
        latestSweepTxInfo,
        DEFAULT_ARGON_MINING_TRANSFER_FOLLOW_WINDOW_FINALIZED_BLOCKS,
      );
      if (txAttemptState === TxAttemptState.Follow) {
        return { kind: 'trackingExisting', txInfo: latestSweepTxInfo };
      }
    }

    const assetsToMove: IAssetsToMove = {};
    const spendableMicrogons = getSpendableDefaultArgonMicrogons(legacyWallet.availableMicrogons);
    if (spendableMicrogons > 0n) {
      assetsToMove[MoveToken.ARGN] = spendableMicrogons;
    }
    if (legacyWallet.availableMicronots > 0n) {
      assetsToMove[MoveToken.ARGNOT] = legacyWallet.availableMicronots;
    }
    if (!assetsToMove[MoveToken.ARGN] && !assetsToMove[MoveToken.ARGNOT]) {
      return { kind: 'noSpendableFundsToSweep' };
    }

    const client = await getMainchainClient(false);
    const fee = await this.calculateFee(
      MoveFrom.DefaultArgon,
      MoveTo.External,
      assetsToMove,
      legacyWallet,
      walletKeys.defaultArgonAddress,
      [],
      client,
    );
    if (this.transactionError) {
      return { kind: 'blocked', error: this.transactionError };
    }

    const finalAssetsToMove: IAssetsToMove = {
      [MoveToken.ARGN]: assetsToMove[MoveToken.ARGN] ? bigIntMax(assetsToMove[MoveToken.ARGN] - fee, 0n) : undefined,
      [MoveToken.ARGNOT]: assetsToMove[MoveToken.ARGNOT],
    };
    if (!finalAssetsToMove[MoveToken.ARGN] && !finalAssetsToMove[MoveToken.ARGNOT]) {
      return { kind: 'noSpendableFundsToSweep' };
    }

    const { tx, metadata } = await this.buildTransaction(
      MoveFrom.DefaultArgon,
      MoveTo.External,
      finalAssetsToMove,
      walletKeys.defaultArgonAddress,
      [],
      client,
    );
    const txSigner = await walletKeys.getLegacyMiningHoldKeypair();
    const txInfo = await this.transactionTracker.submitAndWatch({
      tx,
      txSigner,
      useLatestNonce: true,
      extrinsicType: ExtrinsicType.Transfer,
      metadata,
    });
    return { kind: 'submitted', txInfo };
  }

  private async moveConfiguredDefaultArgonToBotInner(
    wallet: IWallet,
    walletKeys: WalletKeys,
    config: Config,
  ): Promise<DefaultArgonMiningTransferResult> {
    await this.transactionTracker.load();
    this.transactionError = '';

    const latestDefaultArgonMiningTransferTxInfo = this.transactionTracker.findLatestTxInfo<ITransactionMoveMetadata>(
      txInfo => {
        const metadata = txInfo.tx.metadataJson;
        return (
          txInfo.tx.extrinsicType === ExtrinsicType.Transfer &&
          isDefaultArgonMoveFrom(metadata?.moveFrom) &&
          metadata?.moveTo === MoveTo.MiningBot
        );
      },
    );

    const latestDefaultArgonMiningTransferAttempt = latestDefaultArgonMiningTransferTxInfo
      ? {
          txInfo: latestDefaultArgonMiningTransferTxInfo,
          txAttemptState: await this.transactionTracker.getTxAttemptState(
            latestDefaultArgonMiningTransferTxInfo,
            DEFAULT_ARGON_MINING_TRANSFER_FOLLOW_WINDOW_FINALIZED_BLOCKS,
          ),
        }
      : undefined;

    if (latestDefaultArgonMiningTransferAttempt?.txAttemptState === TxAttemptState.Follow) {
      return {
        kind: 'trackingExisting',
        txInfo: latestDefaultArgonMiningTransferAttempt.txInfo,
      };
    }

    const assetsToMove: IAssetsToMove = {};
    const spendableMicrogons = getSpendableDefaultArgonMicrogons(wallet.availableMicrogons);
    const requiredMicrogons = config.biddingRules.initialMicrogonRequirement;
    const requiredMicronots = config.biddingRules.initialMicronotRequirement;

    if (spendableMicrogons > 0n && requiredMicrogons > 0n) {
      assetsToMove[MoveToken.ARGN] = bigIntMax(
        requiredMicrogons < spendableMicrogons ? requiredMicrogons : spendableMicrogons,
        0n,
      );
    }
    if (wallet.availableMicronots > 0n && requiredMicronots > 0n) {
      assetsToMove[MoveToken.ARGNOT] =
        requiredMicronots < wallet.availableMicronots ? requiredMicronots : wallet.availableMicronots;
    }
    if (!assetsToMove[MoveToken.ARGN] && !assetsToMove[MoveToken.ARGNOT]) {
      return { kind: 'noSpendableFundsToSweep' };
    }

    const client = await getMainchainClient(false);
    let fee = await this.calculateFee(
      MoveFrom.DefaultArgon,
      MoveTo.MiningBot,
      assetsToMove,
      wallet,
      this.walletKeys.miningBotAddress,
      [],
      client,
    );
    if (this.transactionError) {
      console.info('[MoveCapital] Skipping default Argon auto-transfer due to fee calculation error', {
        error: this.transactionError,
        availableMicrogons: wallet.availableMicrogons,
        assetsToMove,
      });
      return {
        kind: 'blocked',
        error: this.transactionError,
      };
    }

    let finalAssetsToMove: IAssetsToMove = {};
    const remainingMicrogons = bigIntMax((assetsToMove[MoveToken.ARGN] ?? 0n) - fee, 0n);

    if (remainingMicrogons >= existentialDepositMicrogons) {
      finalAssetsToMove[MoveToken.ARGN] = remainingMicrogons;
    }

    if (assetsToMove[MoveToken.ARGNOT]) {
      if (remainingMicrogons < existentialDepositMicrogons && assetsToMove[MoveToken.ARGN]) {
        finalAssetsToMove = { [MoveToken.ARGNOT]: assetsToMove[MoveToken.ARGNOT] };
        fee = await this.calculateFee(
          MoveFrom.DefaultArgon,
          MoveTo.MiningBot,
          finalAssetsToMove,
          wallet,
          this.walletKeys.miningBotAddress,
          [],
          client,
        );
        if (this.transactionError) {
          console.info('[MoveCapital] Skipping default Argon auto-transfer due to fee calculation error', {
            error: this.transactionError,
            availableMicrogons: wallet.availableMicrogons,
            assetsToMove: finalAssetsToMove,
          });
          return {
            kind: 'blocked',
            error: this.transactionError,
          };
        }
      } else {
        finalAssetsToMove[MoveToken.ARGNOT] = assetsToMove[MoveToken.ARGNOT];
      }
    }

    if (!finalAssetsToMove[MoveToken.ARGN] && !finalAssetsToMove[MoveToken.ARGNOT]) {
      return { kind: 'noSpendableFundsToSweep' };
    }

    const { tx, metadata } = await this.buildTransaction(
      MoveFrom.DefaultArgon,
      MoveTo.MiningBot,
      finalAssetsToMove,
      this.walletKeys.miningBotAddress,
      [],
      client,
    );
    const txSigner = await this.getSigner(MoveFrom.DefaultArgon);
    const followOnTx =
      latestDefaultArgonMiningTransferAttempt?.txAttemptState === TxAttemptState.Replace &&
      latestDefaultArgonMiningTransferAttempt.txInfo &&
      !latestDefaultArgonMiningTransferAttempt.txInfo.tx.followOnTxId
        ? this.transactionTracker.createIntentForFollowOnTx(latestDefaultArgonMiningTransferAttempt.txInfo)
        : undefined;

    try {
      const txInfo = await this.transactionTracker.submitAndWatch({
        tx,
        txSigner,
        useLatestNonce: true,
        extrinsicType: ExtrinsicType.Transfer,
        metadata,
      });
      followOnTx?.resolve(txInfo);
      void this.postProcessMiningBidProxySetup(txInfo).catch(error => {
        console.error('[MoveCapital] Failed to post-process mining bid proxy setup', error);
      });
      return {
        kind: 'submitted',
        txInfo,
      };
    } catch (error) {
      followOnTx?.reject(error);
      throw error;
    }
  }

  private async getSigner(moveFrom: MoveFrom) {
    switch (moveFrom) {
      case MoveFrom.DefaultArgon:
        return await this.walletKeys.getDefaultArgonKeypair();
      case MoveFrom.MiningBot:
        return await this.walletKeys.getMiningBotKeypair();
      case MoveFrom.VaultingSecurity:
        return await this.walletKeys.getVaultingKeypair();
    }
  }

  private async postProcessMiningBidProxySetup(txInfo: TransactionInfo): Promise<void> {
    const postProcessor = txInfo.createPostProcessor();

    try {
      await txInfo.txResult.waitForFinalizedBlock;

      const proxySetup = await ensureMiningBidProxySetup({
        transactionTracker: this.transactionTracker,
        walletKeys: this.walletKeys,
        followWindowFinalizedBlocks: DEFAULT_ARGON_MINING_TRANSFER_FOLLOW_WINDOW_FINALIZED_BLOCKS,
      });
      if (proxySetup.kind === 'trackingExisting' || proxySetup.kind === 'submitted') {
        await proxySetup.txInfo.waitForPostProcessing;
      }
      if (proxySetup.kind === 'insufficientFunds') {
        txInfo.txResult.extrinsicError = new Error(proxySetup.error);
      }

      if (proxySetup.kind === 'insufficientFunds') {
        postProcessor.reject(txInfo.txResult.extrinsicError);
        return;
      }

      postProcessor.resolve();
    } catch (error) {
      txInfo.txResult.extrinsicError = error as Error;
      postProcessor.reject(error as Error);
    }
  }

  public checkAddressType(address: string): {
    isArgonAddress: boolean;
    addressWarning: string;
  } {
    const trimmedAddress = (address || '').trim();
    if (!trimmedAddress) return { isArgonAddress: false, addressWarning: '' };

    const isArgonAddress = isValidArgonAccountAddress(trimmedAddress);

    return {
      isArgonAddress,
      addressWarning: isArgonAddress ? '' : 'The address entered is not a valid Argon address.',
    };
  }

  public async buildTransaction(
    moveFrom: MoveFrom,
    moveTo: MoveTo,
    assetsToMove: IAssetsToMove,
    toAddress: string,
    prependedTxs: SubmittableExtrinsic[] = [],
    client?: ArgonClient,
  ) {
    client ??= await getMainchainClient(false);
    const txs: SubmittableExtrinsic[] = [...prependedTxs];
    const externalMeta = this.checkAddressType(toAddress);

    if (moveTo === MoveTo.External && !externalMeta.isArgonAddress) {
      throw new Error('The address entered is not a valid Argon address.');
    }

    /// 1. Reduce funding / withdraw from vaulting as needed
    if (moveFrom === MoveFrom.VaultingSecurity && assetsToMove.ARGN) {
      const vault = this.myVault.createdVault;
      if (!vault) {
        throw new Error('No vault created');
      }
      const newAmount = vault.securitization - assetsToMove[MoveToken.ARGN];
      const tx = client.tx.vaults.modifyFunding(
        vault.vaultId,
        newAmount,
        toFixedNumber(vault.securitizationRatio, FIXED_U128_DECIMALS),
      );
      txs.push(tx);
    }

    /// 2. Transfer the argons / argonots
    if (moveTo === MoveTo.External && !externalMeta.isArgonAddress) {
      throw new Error('External transfers require a valid Argon address.');
    }

    for (const [tokenSymbol, assetToMove] of Object.entries(assetsToMove) as Array<[MoveToken, bigint]>) {
      if (!assetToMove) continue;
      if (tokenSymbol === MoveToken.ARGN) {
        txs.push(client.tx.balances.transferAllowDeath(toAddress, assetToMove));
      } else if (tokenSymbol === MoveToken.ARGNOT) {
        txs.push(client.tx.ownership.transferAllowDeath(toAddress, assetToMove));
      }
    }

    const metadata = this.buildMoveMetadata(moveFrom, moveTo, assetsToMove, toAddress);

    const tx = txs.length === 1 ? txs[0] : client.tx.utility.batch(txs);
    return { tx, metadata };
  }

  private validateVaultAllocationMove(moveFrom: MoveFrom, moveTo: MoveTo, assetsToMove: IAssetsToMove): void {
    if (moveFrom !== MoveFrom.DefaultArgon) {
      throw new Error('Vault allocation moves must come from Inflation-Free Savings.');
    }
    if (assetsToMove[MoveToken.ARGNOT]) {
      throw new Error('Only ARGN can be moved into vault allocations.');
    }
    if (!assetsToMove[MoveToken.ARGN]) {
      throw new Error(`No ${MoveToken.ARGN} amount provided for vault allocation.`);
    }
  }

  private buildMoveMetadata(
    moveFrom: MoveFrom,
    moveTo: MoveTo,
    assetsToMove: IAssetsToMove,
    toAddress: string,
  ): ITransactionMoveMetadata {
    return {
      moveTo,
      moveFrom,
      externalAddress: moveTo === MoveTo.External ? toAddress : undefined,
      assetsToMove,
    };
  }

  public async calculateFee(
    moveFrom: MoveFrom,
    moveTo: MoveTo,
    assetsToMove: IAssetsToMove,
    fromWallet: IWallet,
    toAddress: string,
    prependedTxs: SubmittableExtrinsic[] = [],
    client?: ArgonClient,
  ): Promise<bigint> {
    client ??= await getMainchainClient(false);
    this.transactionError = '';
    try {
      let tx: SubmittableExtrinsic;
      if ([MoveTo.VaultingSecurity].includes(moveTo)) {
        this.validateVaultAllocationMove(moveFrom, moveTo, assetsToMove);
        tx = await this.myVault.buildIncreaseBitcoinSecurityTx(
          moveTo === MoveTo.VaultingSecurity ? (assetsToMove[MoveToken.ARGN] ?? 0n) : 0n,
          client,
        );
      } else {
        const transaction = await this.buildTransaction(
          moveFrom,
          moveTo,
          assetsToMove,
          toAddress,
          prependedTxs,
          client,
        );
        tx = transaction.tx;
      }
      const feeObj = await tx.paymentInfo(fromWallet.address);
      let fee = feeObj.partialFee.toBigInt();

      if (fee > fromWallet.availableMicrogons) {
        this.transactionError = `Your wallet has insufficient funds for this transaction.`;
        fee = 0n;
      }

      return fee;
    } catch (err) {
      this.transactionError = 'Unable to calculate transaction fee.';
      console.error('Error calculating transaction fee: %o', err);
      return 0n;
    }
  }
}

export interface ITransactionMoveMetadata {
  moveFrom: MoveFrom | 'MiningHold' | 'VaultingHold';
  moveTo: MoveTo | 'MiningHold' | 'VaultingHold';
  externalAddress?: string;
  assetsToMove: IAssetsToMove;
}

export type DefaultArgonMiningTransferResult =
  | {
      kind: 'submitted';
      txInfo: TransactionInfo;
    }
  | {
      kind: 'trackingExisting';
      txInfo: TransactionInfo;
    }
  | {
      kind: 'noSpendableFundsToSweep';
    }
  | {
      kind: 'blocked';
      error: string;
    };
