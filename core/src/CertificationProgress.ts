import type {
  CrosschainTransferTransferTotalsByAccountResultSpec156,
  HistoricalQueryRecord,
} from '@argonprotocol/runtime-client';
import { BondLot } from './BondLot.js';
import { TreasuryBonds } from './TreasuryBonds.js';
import { BitcoinLock } from './BitcoinLock.js';
import type { ArgonClient } from './MainchainClients.js';

type RuntimeOperationalAccount = NonNullable<HistoricalQueryRecord<'operationalAccounts', 'operationalAccounts'>>;

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
  operationalAccountPromise?: Promise<RuntimeOperationalAccount | null>;
  transferTotalsPromise?: Promise<CrosschainTransferTransferTotalsByAccountResultSpec156>;
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
    if (accountRaw) {
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
  const treasuryUniswapTransferAmount = transferTotals.microgonsIn;
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
  account: RuntimeOperationalAccount | null,
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

  if (!account) {
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

  const bitcoinAccrual = account.vaultBitcoinAccrual ?? account.bitcoinAccrual ?? 0n;
  const bitcoinAppliedTotal = account.vaultBitcoinAppliedTotal ?? account.bitcoinAppliedTotal ?? 0n;
  const miningSeatAccrual = account.miningSeatAccrual;
  const miningSeatAppliedTotal = account.miningSeatAppliedTotal ?? 0;
  const operationalVaultSecuritization = bitcoinAccrual + bitcoinAppliedTotal;
  const treasuryBitcoinAmount = account.accountBitcoinAmount ?? 0n;
  const treasuryBondAmount = account.accountVaultBondAmount ?? 0n;
  const uniswapArgonTransfersInAmount = account.uniswapArgonTransfersInAmount ?? 0n;
  const hasTreasuryBitcoin = treasuryBitcoinAmount >= rewardThresholds.treasuryMinimumBitcoin;
  const hasTreasuryBonds = treasuryBondAmount >= rewardThresholds.treasuryMinimumBonds;
  const hasTreasuryUniswapTransfer = uniswapArgonTransfersInAmount >= rewardThresholds.treasuryMinimumUniswapTransfer;

  return {
    hasOperationalAccount: true,
    isTreasuryCertified: hasTreasuryBitcoin && hasTreasuryBonds && hasTreasuryUniswapTransfer,
    hasTreasuryBitcoin,
    treasuryBitcoinAmount,
    hasTreasuryBonds: account.hasTreasuryPoolParticipation ?? hasTreasuryBonds,
    treasuryBondAmount,
    hasTreasuryUniswapTransfer,
    isUpgradedToOperations: account.isOperational ?? account.isOperationallyCertified !== undefined,
    hasOperationalVault:
      account.vaultCreated && operationalVaultSecuritization >= rewardThresholds.operationalMinimumVaultSecuritization,
    hasOperationalMiningSeats: miningSeatAccrual + miningSeatAppliedTotal >= rewardThresholds.miningSeatsForOperational,
    hasOperationalUniswapTransfer: uniswapArgonTransfersInAmount >= rewardThresholds.operationalMinimumUniswapTransfer,
    isOperationallyCertified: account.isOperationallyCertified ?? account.isOperational ?? false,
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
  const utxoIds = await BitcoinLock.idsByOwner(client, defaultAccountId);
  const lockOptions = await BitcoinLock.getMany(client, utxoIds);

  return lockOptions.flatMap(lock => {
    if (!lock) return [];

    return [
      {
        vaultId: lock.vaultId,
        securitizationCoverageMicrogons: lock.securitizationCoverageMicrogons,
        isFunded: lock.isFunded,
      } satisfies Pick<BitcoinLock, 'vaultId' | 'securitizationCoverageMicrogons' | 'isFunded'>,
    ];
  });
}

function getAccountBitcoinAmount(locks: Pick<BitcoinLock, 'securitizationCoverageMicrogons' | 'isFunded'>[]): bigint {
  return locks.reduce((total, lock) => {
    return lock.isFunded ? total + lock.securitizationCoverageMicrogons : total;
  }, 0n);
}
