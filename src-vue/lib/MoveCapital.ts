import { getMainchainClient } from '../stores/mainchain.ts';
import { ArgonClient, FIXED_U128_DECIMALS, SubmittableExtrinsic, toFixedNumber } from '@argonprotocol/mainchain';
import { bigIntMax, isValidArgonAccountAddress, MoveFrom, MoveTo, MoveToken } from '@argonprotocol/apps-core';
import { MyVault } from './MyVault.ts';
import { existentialDepositMicrogons, getSpendableMiningHoldMicrogons } from './WalletForArgon.ts';
import { IWallet, WalletType } from './Wallet.ts';
import { ExtrinsicType } from './db/TransactionsTable.ts';
import { TransactionInfo } from './TransactionInfo.ts';
import { WalletKeys } from './WalletKeys.ts';
import { TransactionTracker, TxAttemptState } from './TransactionTracker.ts';
import { buildOperatorAccountRegistrationTx } from './OperationalAccount.ts';
import { Config } from './Config.ts';

export interface IAssetsToMove {
  [MoveToken.ARGN]?: bigint;
  [MoveToken.ARGNOT]?: bigint;
}

let pendingMiningHoldSweepPromise: Promise<MiningHoldSweepResult> | undefined;
const MINING_HOLD_SWEEP_FOLLOW_WINDOW_FINALIZED_BLOCKS = 2;

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

  public getWalletTypeFromMove(moveFrom: MoveFrom): WalletType.miningHold | WalletType.miningBot | WalletType.vaulting {
    switch (moveFrom) {
      case MoveFrom.MiningHold:
        return WalletType.miningHold;

      case MoveFrom.MiningBot:
        return WalletType.miningBot;

      case MoveFrom.VaultingHold:
      case MoveFrom.VaultingSecurity:
        return WalletType.vaulting;
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
      const allocations = {
        addedSecuritizationMicrogons: 0n,
        addedTreasuryMicrogons: 0n,
      };
      if (moveTo === MoveTo.VaultingSecurity) {
        allocations.addedSecuritizationMicrogons = assetsToMove.ARGN ?? 0n;
      }
      return await this.myVault.increaseVaultAllocations({
        ...allocations,
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

  public async moveAvailableMiningHoldToBot(
    wallet: IWallet,
    walletKeys: WalletKeys,
    config: Config,
  ): Promise<MiningHoldSweepResult> {
    if (pendingMiningHoldSweepPromise) {
      return await pendingMiningHoldSweepPromise;
    }

    const sweepPromise = this.moveAvailableMiningHoldToBotInner(wallet, walletKeys, config);
    pendingMiningHoldSweepPromise = sweepPromise;

    try {
      return await sweepPromise;
    } finally {
      if (pendingMiningHoldSweepPromise === sweepPromise) {
        pendingMiningHoldSweepPromise = undefined;
      }
    }
  }

  private async moveAvailableMiningHoldToBotInner(
    wallet: IWallet,
    walletKeys: WalletKeys,
    config: Config,
  ): Promise<MiningHoldSweepResult> {
    await this.transactionTracker.load();
    this.transactionError = '';

    const latestMiningHoldSweepTxInfo = this.transactionTracker.findLatestTxInfo<ITransactionMoveMetadata>(txInfo => {
      const metadata = txInfo.tx.metadataJson;
      return (
        txInfo.tx.extrinsicType === ExtrinsicType.Transfer &&
        metadata?.moveFrom === MoveFrom.MiningHold &&
        metadata?.moveTo === MoveTo.MiningBot
      );
    });

    const latestMiningHoldSweepAttempt = latestMiningHoldSweepTxInfo
      ? {
          txInfo: latestMiningHoldSweepTxInfo,
          txAttemptState: await this.transactionTracker.getTxAttemptState(
            latestMiningHoldSweepTxInfo,
            MINING_HOLD_SWEEP_FOLLOW_WINDOW_FINALIZED_BLOCKS,
          ),
        }
      : undefined;

    if (latestMiningHoldSweepAttempt?.txAttemptState === TxAttemptState.Follow) {
      return {
        kind: 'trackingExisting',
        txInfo: latestMiningHoldSweepAttempt.txInfo,
      };
    }

    const assetsToMove: IAssetsToMove = {};
    const spendableMicrogons = getSpendableMiningHoldMicrogons(wallet.availableMicrogons);

    if (spendableMicrogons > 0n) {
      assetsToMove[MoveToken.ARGN] = spendableMicrogons;
    }
    if (wallet.availableMicronots > 0n) {
      assetsToMove[MoveToken.ARGNOT] = wallet.availableMicronots;
    }
    if (!assetsToMove[MoveToken.ARGN] && !assetsToMove[MoveToken.ARGNOT]) {
      return { kind: 'noSpendableFundsToSweep' };
    }

    const client = await getMainchainClient(false);
    const prependedTxs: SubmittableExtrinsic[] = [];
    const registrationTx = await buildOperatorAccountRegistrationTx({
      walletKeys,
      config,
      client,
    });
    if (registrationTx) {
      prependedTxs.push(registrationTx);
    }

    let fee = await this.calculateFee(
      MoveFrom.MiningHold,
      MoveTo.MiningBot,
      assetsToMove,
      wallet,
      this.walletKeys.miningBotAddress,
      prependedTxs,
      client,
    );
    if (this.transactionError) {
      console.info('[MoveCapital] Skipping mining hold auto-transfer due to fee calculation error', {
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
          MoveFrom.MiningHold,
          MoveTo.MiningBot,
          finalAssetsToMove,
          wallet,
          this.walletKeys.miningBotAddress,
          prependedTxs,
          client,
        );
        if (this.transactionError) {
          console.info('[MoveCapital] Skipping mining hold auto-transfer due to fee calculation error', {
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
      MoveFrom.MiningHold,
      MoveTo.MiningBot,
      finalAssetsToMove,
      this.walletKeys.miningBotAddress,
      prependedTxs,
      client,
    );
    const txSigner = await this.getSigner(MoveFrom.MiningHold);
    const followOnTx =
      latestMiningHoldSweepAttempt?.txAttemptState === TxAttemptState.Replace &&
      latestMiningHoldSweepAttempt.txInfo &&
      !latestMiningHoldSweepAttempt.txInfo.tx.followOnTxId
        ? this.transactionTracker.createIntentForFollowOnTx(latestMiningHoldSweepAttempt.txInfo)
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
    return await this.walletKeys.getWalletKeypair(this.getWalletTypeFromMove(moveFrom));
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
    if (moveFrom !== MoveFrom.VaultingHold) {
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
        tx = await this.myVault.buildIncreaseVaultAllocationsTx(
          {
            addedSecuritizationMicrogons:
              moveTo === MoveTo.VaultingSecurity ? (assetsToMove[MoveToken.ARGN] ?? 0n) : 0n,
          },
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
  moveFrom: MoveFrom;
  moveTo: MoveTo;
  externalAddress?: string;
  assetsToMove: IAssetsToMove;
}

export type MiningHoldSweepResult =
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
