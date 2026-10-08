import type {
  CrosschainTransferTransferTotalsByAccountResultSpec156,
  HistoricalQueryRecord,
} from '@argonprotocol/runtime-client';
import { MICROGONS_PER_ARGON } from '@argonprotocol/mainchain';
import { BondLot } from './BondLot.js';
import { TreasuryBonds } from './TreasuryBonds.js';
import { BitcoinLock } from './BitcoinLock.js';
import { BitcoinFission } from './BitcoinFission.js';
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
  uniswapArgonTransfersInAmount?: bigint;
  isUpgradedToOperations: boolean;
  hasOperationalVault: boolean;
  operationalVaultSecuritization?: bigint;
  hasOperationalMiningSeats: boolean;
  operationalMiningSeatCount?: number;
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
  operationalAccountPromise?: Promise<RuntimeOperationalAccount | null>;
  transferTotalsPromise?: Promise<CrosschainTransferTransferTotalsByAccountResultSpec156>;
}): Promise<ICertificationProgress> {
  const { client, defaultAccountId, operationalAccountId, operationalAccountPromise, transferTotalsPromise } = args;
  const thresholds = getCertificationThresholds(client);

  if (operationalAccountId) {
    const accountRaw = await (operationalAccountPromise ??
      client.query.operationalAccounts.operationalAccounts(operationalAccountId));
    if (accountRaw) {
      const vaultId = await client.query.vaults.vaultIdByOperator(accountRaw.vaultAccount);
      const vault = vaultId == null ? null : await client.query.vaults.vaultsById(vaultId);
      return getCertificationProgressFromOperationalAccount(accountRaw, thresholds, vault?.securitization ?? 0n);
    }
  }

  const [bondLots, fissions, transferTotals] = await Promise.all([
    TreasuryBonds.getBondLotsByAccount(client, defaultAccountId),
    BitcoinFission.getAllByOwner(client, defaultAccountId),
    transferTotalsPromise ?? client.query.crosschainTransfer.transferTotalsByAccount(defaultAccountId),
  ]);

  const treasuryBitcoinAmount = fissions.reduce((total, fission) => total + fission.liquidityPromised, 0n);
  const treasuryBondAmount = BondLot.getTotals(bondLots).activeBondMicrogons;
  const treasuryUniswapTransferAmount = transferTotals.microgonsIn;
  const hasTreasuryBitcoin = meetsCertificationAmountMinimum(treasuryBitcoinAmount, thresholds.treasuryMinimumBitcoin);
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
    uniswapArgonTransfersInAmount: treasuryUniswapTransferAmount,
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
  vaultSecuritization?: bigint,
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

  const miningSeatAccrual = account.miningSeatAccrual;
  const miningSeatAppliedTotal = account.miningSeatAppliedTotal ?? 0;
  const operationalMiningSeatCount = miningSeatAccrual + miningSeatAppliedTotal;
  const treasuryBitcoinAmount = account.accountBitcoinAmount ?? 0n;
  const treasuryBondAmount = account.accountVaultBondAmount ?? 0n;
  const uniswapArgonTransfersInAmount = account.uniswapArgonTransfersInAmount ?? 0n;
  const hasTreasuryBitcoin = meetsCertificationAmountMinimum(
    treasuryBitcoinAmount,
    rewardThresholds.treasuryMinimumBitcoin,
  );
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
    uniswapArgonTransfersInAmount,
    isUpgradedToOperations: account.isOperational ?? account.isOperationallyCertified !== undefined,
    hasOperationalVault:
      vaultSecuritization !== undefined &&
      meetsCertificationAmountMinimum(vaultSecuritization, rewardThresholds.operationalMinimumVaultSecuritization),
    operationalVaultSecuritization: vaultSecuritization,
    hasOperationalMiningSeats: operationalMiningSeatCount >= rewardThresholds.miningSeatsForOperational,
    operationalMiningSeatCount,
    hasOperationalUniswapTransfer: uniswapArgonTransfersInAmount >= rewardThresholds.operationalMinimumUniswapTransfer,
    isOperationallyCertified: account.isOperationallyCertified ?? account.isOperational ?? false,
  };
}

export function meetsCertificationAmountMinimum(amount: bigint, minimum: bigint): boolean {
  const tolerance = BigInt(MICROGONS_PER_ARGON);
  return amount >= (minimum > tolerance ? minimum - tolerance : 0n);
}

export function getCertificationThresholds(client: ArgonClient): ICertificationThresholds {
  const operationalConsts = client.consts.operationalAccounts;

  return {
    treasuryMinimumBitcoin: operationalConsts.minimumBitcoin,
    treasuryMinimumBonds: operationalConsts.minimumBonds,
    treasuryMinimumUniswapTransfer: operationalConsts.minimumUniswapTransfer,
    operationalMinimumUniswapTransfer: operationalConsts.operationalMinimumUniswapTransfer,
    operationalMinimumVaultSecuritization: operationalConsts.operationalMinimumVaultSecuritization,
    miningSeatsForOperational: operationalConsts.miningSeatsForOperational,
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
