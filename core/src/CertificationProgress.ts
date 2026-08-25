import {
  type ArgonClient,
  type Option,
  type PalletCrosschainTransferAccountTransferTotals,
  type PalletOperationalAccountsOperationalAccount,
} from '@argonprotocol/mainchain';
import { BondLot } from './BondLot.js';
import { TreasuryBonds } from './TreasuryBonds.js';
import type { BitcoinLock } from './BitcoinLock.js';

export interface ICertificationProgress {
  hasOperationalAccount: boolean;
  isTreasuryCertified: boolean;
  hasTreasuryBitcoin: boolean;
  treasuryBitcoinAmount?: bigint;
  hasTreasuryBonds: boolean;
  treasuryBondAmount?: bigint;
  hasTreasuryUniswapTransfer: boolean;
  isUpgradedToOperations: boolean;
  hasOperationalVault: boolean;
  hasOperationalMiningSeats: boolean;
  hasOperationalUniswapTransfer: boolean;
  isOperationallyCertified: boolean;
}

export const treasuryCertificationRequirementCount = 3;
export const operationalCertificationRequirementCount = 3;

export interface ICertificationThresholds {
  treasuryMinimumBitcoin: bigint;
  treasuryMinimumBonds: bigint;
  treasuryMinimumUniswapTransfer: bigint;
  operationalMinimumVaultSecuritization: bigint;
  operationalMinimumUniswapTransfer: bigint;
  miningSeatsForOperational: number;
}

export function countCompletedTreasuryCertificationRequirements(progress: ICertificationProgress): number {
  return [progress.hasTreasuryBitcoin, progress.hasTreasuryBonds, progress.hasTreasuryUniswapTransfer].filter(Boolean)
    .length;
}

export function countCompletedOperationalCertificationRequirements(progress: ICertificationProgress): number {
  return [
    progress.hasOperationalVault,
    progress.hasOperationalMiningSeats,
    progress.hasOperationalUniswapTransfer,
  ].filter(Boolean).length;
}

export function hasCompletedTreasuryCertificationRequirements(progress: ICertificationProgress): boolean {
  return countCompletedTreasuryCertificationRequirements(progress) === treasuryCertificationRequirementCount;
}

export function hasCompletedOperationalCertificationRequirements(progress: ICertificationProgress): boolean {
  return countCompletedOperationalCertificationRequirements(progress) === operationalCertificationRequirementCount;
}

export async function loadCertificationProgress(args: {
  client: ArgonClient;
  defaultAccountId: string;
  operationalAccountId?: string;
  accountLocksPromise?: ReturnType<typeof loadAccountLocks>;
  operationalAccountPromise?: Promise<Option<PalletOperationalAccountsOperationalAccount>>;
  transferTotalsPromise?: Promise<PalletCrosschainTransferAccountTransferTotals>;
}): Promise<ICertificationProgress> {
  const {
    client,
    defaultAccountId,
    operationalAccountId,
    accountLocksPromise,
    operationalAccountPromise,
    transferTotalsPromise,
  } = args;
  const thresholds = getCertificationThresholds(client);

  if (operationalAccountId) {
    const accountRaw = await (operationalAccountPromise ??
      client.query.operationalAccounts.operationalAccounts(operationalAccountId));
    if (accountRaw.isSome) {
      return getCertificationProgressFromOperationalAccount(accountRaw, thresholds);
    }
  }

  const [bondLots, locks, transferTotals] = await Promise.all([
    TreasuryBonds.getBondLotsByAccount(client, defaultAccountId),
    accountLocksPromise ?? loadAccountLocks({ client, defaultAccountId }),
    transferTotalsPromise ?? client.query.crosschainTransfer.transferTotalsByAccount(defaultAccountId),
  ]);

  const treasuryBitcoinAmount = getAccountBitcoinAmount(locks);
  const treasuryBondAmount = BondLot.getTotals(bondLots).activeBondMicrogons;
  const treasuryUniswapTransferAmount = transferTotals.microgonsIn.toBigInt();
  const hasTreasuryBitcoin = treasuryBitcoinAmount >= thresholds.treasuryMinimumBitcoin;
  const hasTreasuryBonds = treasuryBondAmount >= thresholds.treasuryMinimumBonds;
  const hasTreasuryUniswapTransfer = treasuryUniswapTransferAmount >= thresholds.treasuryMinimumUniswapTransfer;

  return {
    hasOperationalAccount: false,
    isTreasuryCertified: hasTreasuryBitcoin && hasTreasuryBonds && hasTreasuryUniswapTransfer,
    hasTreasuryBitcoin,
    treasuryBitcoinAmount,
    hasTreasuryBonds,
    treasuryBondAmount,
    hasTreasuryUniswapTransfer,
    isUpgradedToOperations: false,
    hasOperationalVault: false,
    hasOperationalMiningSeats: false,
    hasOperationalUniswapTransfer: false,
    isOperationallyCertified: false,
  };
}

export function getCertificationProgressFromOperationalAccount(
  accountRaw: Option<PalletOperationalAccountsOperationalAccount>,
  thresholds?: ICertificationThresholds,
): ICertificationProgress {
  const rewardThresholds = thresholds ?? {
    treasuryMinimumBitcoin: 0n,
    treasuryMinimumBonds: 0n,
    treasuryMinimumUniswapTransfer: 0n,
    operationalMinimumVaultSecuritization: 0n,
    operationalMinimumUniswapTransfer: 0n,
    miningSeatsForOperational: 0,
  };

  if (!accountRaw.isSome) {
    return {
      hasOperationalAccount: false,
      isTreasuryCertified: false,
      hasTreasuryBitcoin: false,
      treasuryBitcoinAmount: 0n,
      hasTreasuryBonds: false,
      treasuryBondAmount: 0n,
      hasTreasuryUniswapTransfer: false,
      isUpgradedToOperations: false,
      hasOperationalVault: false,
      hasOperationalMiningSeats: false,
      hasOperationalUniswapTransfer: false,
      isOperationallyCertified: false,
    };
  }

  const account = accountRaw.unwrap();
  const bitcoinAccrual = account.vaultBitcoinAccrual.toBigInt();
  const bitcoinAppliedTotal = account.vaultBitcoinAppliedTotal.toBigInt();
  const miningSeatAccrual = account.miningSeatAccrual.toNumber();
  const miningSeatAppliedTotal = account.miningSeatAppliedTotal.toNumber();
  const operationalVaultSecuritization = bitcoinAccrual + bitcoinAppliedTotal;
  const treasuryBitcoinAmount = account.accountBitcoinAmount.toBigInt();
  const treasuryBondAmount = account.accountVaultBondAmount.toBigInt();
  const uniswapArgonTransfersInAmount = account.uniswapArgonTransfersInAmount.toBigInt();
  const hasTreasuryBitcoin = treasuryBitcoinAmount >= rewardThresholds.treasuryMinimumBitcoin;
  const hasTreasuryBonds = treasuryBondAmount >= rewardThresholds.treasuryMinimumBonds;
  const hasTreasuryUniswapTransfer = uniswapArgonTransfersInAmount >= rewardThresholds.treasuryMinimumUniswapTransfer;

  return {
    hasOperationalAccount: true,
    isTreasuryCertified: hasTreasuryBitcoin && hasTreasuryBonds && hasTreasuryUniswapTransfer,
    hasTreasuryBitcoin,
    treasuryBitcoinAmount,
    hasTreasuryBonds,
    treasuryBondAmount,
    hasTreasuryUniswapTransfer,
    isUpgradedToOperations: true,
    hasOperationalVault:
      account.vaultCreated.toPrimitive() &&
      operationalVaultSecuritization >= rewardThresholds.operationalMinimumVaultSecuritization,
    hasOperationalMiningSeats: miningSeatAccrual + miningSeatAppliedTotal >= rewardThresholds.miningSeatsForOperational,
    hasOperationalUniswapTransfer: uniswapArgonTransfersInAmount >= rewardThresholds.operationalMinimumUniswapTransfer,
    isOperationallyCertified: account.isOperationallyCertified.toPrimitive(),
  };
}

export function getCertificationThresholds(client: ArgonClient): ICertificationThresholds {
  const operationalConsts = client.consts.operationalAccounts;

  return {
    treasuryMinimumBitcoin: operationalConsts.minimumBitcoin.toBigInt(),
    treasuryMinimumBonds: operationalConsts.minimumBonds.toBigInt(),
    treasuryMinimumUniswapTransfer: operationalConsts.minimumUniswapTransfer.toBigInt(),
    operationalMinimumUniswapTransfer: operationalConsts.operationalMinimumUniswapTransfer.toBigInt(),
    operationalMinimumVaultSecuritization: operationalConsts.operationalMinimumVaultSecuritization.toBigInt(),
    miningSeatsForOperational: operationalConsts.miningSeatsForOperational.toNumber(),
  };
}

export async function loadAccountLocks(args: { client: ArgonClient; defaultAccountId: string }) {
  const { client, defaultAccountId } = args;
  const utxoKeys = await client.query.bitcoinLocks.utxoIdsByOwnerAccount.keys(defaultAccountId);
  const utxoIds = utxoKeys.map(key => key.args[1].toNumber());
  const lockOptions = utxoIds.length ? await client.query.bitcoinLocks.locksByUtxoId.multi(utxoIds) : [];

  return lockOptions.flatMap(lockRaw => {
    if (!lockRaw.isSome) {
      return [];
    }

    const lock = lockRaw.unwrap();

    return [
      {
        vaultId: lock.vaultId.toNumber(),
        liquidityPromised: lock.liquidityPromised.toBigInt(),
        isFunded: lock.isFunded.toJSON(),
      } satisfies Pick<BitcoinLock, 'vaultId' | 'liquidityPromised' | 'isFunded'>,
    ];
  });
}

function getAccountBitcoinAmount(locks: Pick<BitcoinLock, 'liquidityPromised' | 'isFunded'>[]): bigint {
  return locks.reduce((total, lock) => {
    return lock.isFunded ? total + lock.liquidityPromised : total;
  }, 0n);
}
