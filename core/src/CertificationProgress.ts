import {
  type ArgonClient,
  type BitcoinLock,
  type Option,
  type PalletOperationalAccountsOperationalAccount,
} from '@argonprotocol/mainchain';
import { BondLot } from './BondLot.js';
import type { IBigIntCodec, IBooleanCodec, INumberCodec } from './Codecs.js';
import { TreasuryBonds } from './TreasuryBonds.js';

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

// Deployed mainchain v1.4.9 uses this operational_accounts surface at specVersion 155.
interface ISpec155OperationalAccount extends PalletOperationalAccountsOperationalAccount {
  readonly hasUniswapTransfer?: IBooleanCodec;
  readonly bitcoinAccrual?: IBigIntCodec;
  readonly bitcoinAppliedTotal?: IBigIntCodec;
  readonly hasTreasuryPoolParticipation?: IBooleanCodec;
  readonly isOperational?: IBooleanCodec;
}

interface ICertificationThresholdConsts {
  readonly minimumBitcoin?: IBigIntCodec;
  readonly minimumBonds?: IBigIntCodec;
  readonly minimumUniswapTransfer?: IBigIntCodec;
  readonly treasuryMinimumBitcoin?: IBigIntCodec;
  readonly treasuryMinimumBonds?: IBigIntCodec;
  readonly treasuryMinimumUniswapTransfer?: IBigIntCodec;
  readonly operationalMinimumUniswapTransfer?: IBigIntCodec;
  readonly operationalMinimumVaultSecuritization?: IBigIntCodec;
  readonly miningSeatsForOperational?: INumberCodec;
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
}): Promise<ICertificationProgress> {
  const { client, defaultAccountId, operationalAccountId, accountLocksPromise } = args;
  const thresholds = getCertificationThresholds(client);

  if (operationalAccountId) {
    const accountRaw = await client.query.operationalAccounts.operationalAccounts(operationalAccountId);
    if (accountRaw.isSome) {
      return getCertificationProgressFromOperationalAccount(accountRaw, thresholds);
    }
  }

  const [bondLots, locks, transferTotals] = await Promise.all([
    TreasuryBonds.getBondLotsByAccount(client, defaultAccountId),
    accountLocksPromise ?? loadAccountLocks({ client, defaultAccountId }),
    client.query.crosschainTransfer.transferTotalsByAccount(defaultAccountId),
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
  const spec155Account = account as ISpec155OperationalAccount;
  const bitcoinAccrual = spec155Account.bitcoinAccrual?.toBigInt() ?? account.vaultBitcoinAccrual?.toBigInt() ?? 0n;
  const bitcoinAppliedTotal =
    spec155Account.bitcoinAppliedTotal?.toBigInt() ?? account.vaultBitcoinAppliedTotal?.toBigInt() ?? 0n;
  const miningSeatAccrual = account.miningSeatAccrual?.toNumber() ?? 0;
  const miningSeatAppliedTotal = account.miningSeatAppliedTotal?.toNumber() ?? 0;
  const operationalVaultSecuritization = bitcoinAccrual + bitcoinAppliedTotal;
  const spec155HasBitcoinProgress =
    spec155Account.bitcoinAccrual !== undefined || spec155Account.bitcoinAppliedTotal !== undefined;
  const spec155HasTreasuryPoolParticipation = spec155Account.hasTreasuryPoolParticipation?.toPrimitive();
  const rawTreasuryBitcoinAmount = account.accountBitcoinAmount?.toBigInt();
  const treasuryBitcoinAmount =
    spec155HasBitcoinProgress && (!rawTreasuryBitcoinAmount || rawTreasuryBitcoinAmount <= 0n)
      ? operationalVaultSecuritization
      : rawTreasuryBitcoinAmount;
  const rawTreasuryBondAmount = account.accountVaultBondAmount?.toBigInt();
  const treasuryBondAmount =
    spec155HasTreasuryPoolParticipation !== undefined && (!rawTreasuryBondAmount || rawTreasuryBondAmount <= 0n)
      ? undefined
      : rawTreasuryBondAmount;
  const uniswapArgonTransfersInAmount = account.uniswapArgonTransfersInAmount?.toBigInt() ?? 0n;
  const spec155HasUniswapTransfer = spec155Account.hasUniswapTransfer?.toPrimitive();
  const spec155IsOperational = spec155Account.isOperational?.toPrimitive();
  const hasTreasuryBitcoin = spec155HasBitcoinProgress
    ? (treasuryBitcoinAmount ?? 0n) > 0n
    : (treasuryBitcoinAmount ?? 0n) >= rewardThresholds.treasuryMinimumBitcoin;
  const hasTreasuryBonds =
    spec155HasTreasuryPoolParticipation ?? (treasuryBondAmount ?? 0n) >= rewardThresholds.treasuryMinimumBonds;
  const hasTreasuryUniswapTransfer =
    spec155HasUniswapTransfer ?? uniswapArgonTransfersInAmount >= rewardThresholds.treasuryMinimumUniswapTransfer;

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
      (account.vaultCreated?.toPrimitive() ?? false) &&
      operationalVaultSecuritization >= rewardThresholds.operationalMinimumVaultSecuritization,
    hasOperationalMiningSeats: miningSeatAccrual + miningSeatAppliedTotal >= rewardThresholds.miningSeatsForOperational,
    hasOperationalUniswapTransfer:
      spec155HasUniswapTransfer ?? uniswapArgonTransfersInAmount >= rewardThresholds.operationalMinimumUniswapTransfer,
    isOperationallyCertified: spec155IsOperational ?? account.isOperationallyCertified?.toPrimitive() ?? false,
  };
}

export function getCertificationThresholds(client: ArgonClient): ICertificationThresholds {
  const operationalConsts = client.consts.operationalAccounts as typeof client.consts.operationalAccounts &
    ICertificationThresholdConsts;

  return {
    treasuryMinimumBitcoin:
      operationalConsts.minimumBitcoin?.toBigInt() ?? operationalConsts.treasuryMinimumBitcoin?.toBigInt() ?? 1n,
    treasuryMinimumBonds:
      operationalConsts.minimumBonds?.toBigInt() ?? operationalConsts.treasuryMinimumBonds?.toBigInt() ?? 1n,
    treasuryMinimumUniswapTransfer:
      operationalConsts.minimumUniswapTransfer?.toBigInt() ??
      operationalConsts.treasuryMinimumUniswapTransfer?.toBigInt() ??
      1n,
    operationalMinimumUniswapTransfer: operationalConsts.operationalMinimumUniswapTransfer?.toBigInt() ?? 1n,
    operationalMinimumVaultSecuritization: (
      operationalConsts.operationalMinimumVaultSecuritization ??
      client.consts.vaults.operationalMinimumVaultSecuritization
    ).toBigInt(),
    miningSeatsForOperational: operationalConsts.miningSeatsForOperational?.toNumber() ?? 2,
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
