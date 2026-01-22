import { getMainchainClient } from '../stores/mainchain.ts';
import { FIXED_U128_DECIMALS, SubmittableExtrinsic, toFixedNumber } from '@argonprotocol/mainchain';
import {
  ethAddressToH256,
  isValidArgonAccountAddress,
  isValidEthereumAddress,
  MoveFrom,
  MoveTo,
  MoveToken,
} from '@argonprotocol/apps-core';
import { MyVault } from './MyVault.ts';
import { IWallet, WalletType } from './Wallet.ts';
import { ExtrinsicType } from './db/TransactionsTable.ts';
import { TransactionInfo } from './TransactionInfo.ts';
import { WalletKeys } from './WalletKeys.ts';
import { TransactionTracker } from './TransactionTracker.ts';

export interface IAssetsToMove {
  [MoveToken.ARGN]?: bigint;
  [MoveToken.ARGNOT]?: bigint;
}

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
      case MoveFrom.VaultingTreasury:
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
  ): Promise<TransactionInfo> {
    if (shouldDeductFeeFromCapital) {
      const fee = await this.calculateFee(moveFrom, moveTo, assetsToMove, fromWallet, toAddress);
      assetsToMove = {
        [MoveToken.ARGN]: assetsToMove[MoveToken.ARGN] ? assetsToMove[MoveToken.ARGN] - fee : 0n,
        [MoveToken.ARGNOT]: assetsToMove[MoveToken.ARGNOT] ?? 0n,
      };
    }
    if ([MoveTo.VaultingSecurity, MoveTo.VaultingTreasury].includes(moveTo)) {
      const allocations = {
        addedSecuritizationMicrogons: 0n,
        addedTreasuryMicrogons: 0n,
      };
      if (moveTo === MoveTo.VaultingSecurity) {
        allocations.addedSecuritizationMicrogons = assetsToMove.ARGN ?? 0n;
      } else if (moveTo === MoveTo.VaultingTreasury) {
        allocations.addedTreasuryMicrogons = assetsToMove.ARGN ?? 0n;
      }
      return await this.myVault.increaseVaultAllocations(allocations);
    } else {
      const transaction = await this.buildTransaction(moveFrom, moveTo, assetsToMove, toAddress);
      const { tx, metadata } = transaction;
      const signer = await this.getSigner(moveFrom);
      return await this.transactionTracker.submitAndWatch({
        tx,
        signer,
        metadata,
        extrinsicType: ExtrinsicType.Transfer,
      });
    }
  }

  private async getSigner(moveFrom: MoveFrom) {
    const walletType = this.getWalletTypeFromMove(moveFrom);
    switch (walletType) {
      case WalletType.miningHold:
        return await this.walletKeys.getMiningHoldKeypair();
      case WalletType.miningBot:
        return await this.walletKeys.getMiningBotKeypair();
      case WalletType.vaulting:
        return await this.walletKeys.getVaultingKeypair();
    }
  }

  public checkAddressType(address: string): {
    isArgonAddress: boolean;
    isEthereumAddress: boolean;
    addressWarning: string;
  } {
    const trimmedAddress = (address || '').trim();
    if (!trimmedAddress) return { isArgonAddress: false, isEthereumAddress: false, addressWarning: '' };

    const isArgonAddress = isValidArgonAccountAddress(trimmedAddress);
    const ethereumAddressValidation = isValidEthereumAddress(trimmedAddress);
    const isEthereumAddress = ethereumAddressValidation.valid;

    let addressWarning = '';
    if (ethereumAddressValidation.valid) {
      addressWarning = ethereumAddressValidation.checksum
        ? ''
        : "Warning: Ethereum address can't be validated - use a check-summed address to be safer.";
    } else if (!isArgonAddress) {
      addressWarning = 'The address entered is not a valid Argon or Ethereum address.';
    }

    return {
      isArgonAddress,
      isEthereumAddress,
      addressWarning,
    };
  }

  public async buildTransaction(moveFrom: MoveFrom, moveTo: MoveTo, assetsToMove: IAssetsToMove, toAddress: string) {
    const txs: SubmittableExtrinsic[] = [];
    const client = await getMainchainClient(false);

    /// 1. Reduce funding / withdraw from vaulting as needed
    if (moveFrom === MoveFrom.VaultingSecurity && assetsToMove.ARGN) {
      const vault = this.myVault.createdVault;
      if (!vault) {
        throw new Error('No vault created');
      }
      if (vault.securitization < assetsToMove.ARGN) {
        throw new Error('Not enough securitization available to withdraw');
      }

      txs.push(
        client.tx.vaults.modifyFunding(
          vault.vaultId,
          vault.securitization - assetsToMove.ARGN,
          toFixedNumber(vault.securitizationRatio, FIXED_U128_DECIMALS),
        ),
      );
    } else if (moveFrom === MoveFrom.VaultingTreasury) {
      console.warn('Withdrawing from treasury is not yet supported');
    }

    /// 2. Transfer the argons / argonots
    const ARGON_ASSET_ID = 0;
    const ARGONOT_ASSET_ID = 1;
    const externalMeta = this.checkAddressType(toAddress);

    for (const [tokenSymbol, assetToMove] of Object.entries(assetsToMove) as Array<[MoveToken, bigint]>) {
      if (!assetToMove) continue;
      if (externalMeta.isEthereumAddress) {
        const assetId = tokenSymbol === MoveToken.ARGN ? ARGON_ASSET_ID : ARGONOT_ASSET_ID;
        const recipient = ethAddressToH256(toAddress);
        txs.push(
          client.tx.tokenGateway.teleport({
            assetId,
            destination: { Evm: 1 },
            recepient: recipient, // NOTE: field name 'recepient' is misspelled in the on-chain API and must remain as-is
            timeout: 0,
            relayerFee: 0n,
            amount: assetToMove,
            redeem: false,
            tokenGateway: '0xFd413e3AFe560182C4471F4d143A96d3e259B6dE',
          }),
        );
      } else if (tokenSymbol === MoveToken.ARGN) {
        txs.push(client.tx.balances.transferAllowDeath(toAddress, assetToMove));
      } else if (tokenSymbol === MoveToken.ARGNOT) {
        txs.push(client.tx.ownership.transferAllowDeath(toAddress, assetToMove));
      }
    }

    const metadata = {
      moveTo: moveTo,
      moveFrom: moveFrom,
      externalAddress: moveTo === MoveTo.External ? toAddress : undefined,
      isMovingToEthereum: externalMeta.isEthereumAddress,
      assetsToMove: assetsToMove,
    } as ITransactionMoveMetadata;

    const tx = txs.length === 1 ? txs[0] : client.tx.utility.batch(txs);
    return { tx, metadata };
  }

  public async calculateFee(
    moveFrom: MoveFrom,
    moveTo: MoveTo,
    assetsToMove: IAssetsToMove,
    fromWallet: IWallet,
    toAddress: string,
  ): Promise<bigint> {
    try {
      const { tx } = await this.buildTransaction(moveFrom, moveTo, assetsToMove, toAddress);
      const feeObj = await tx.paymentInfo(fromWallet.address);
      let fee = feeObj.partialFee.toBigInt();

      this.transactionError = '';

      if (fee > fromWallet.availableMicrogons) {
        this.transactionError = `Your wallet has insufficient funds for this transaction.`;
        fee = 0n;
      }

      return fee;
    } catch (err) {
      console.error('Error calculating transaction fee: %o', err);
      return 0n;
    }
  }
}

export interface ITransactionMoveMetadata {
  moveFrom: MoveFrom;
  moveTo: MoveTo;
  externalAddress?: string;
  isMovingToEthereum?: boolean;
  assetsToMove: IAssetsToMove;
}
