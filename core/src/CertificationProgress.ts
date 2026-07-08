import {
  BitcoinLock,
  type ArgonClient,
  type Option,
  type PalletOperationalAccountsOperationalAccount,
} from '@argonprotocol/mainchain';
import { BondLot } from './BondLot.js';
import { TreasuryBonds } from './TreasuryBonds.js';

export interface ICertificationProgress {
  hasOperationalAccount: boolean;
  isTreasuryCertified: boolean;
  hasTreasuryBitcoin: boolean;
  hasTreasuryBonds: boolean;
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

type LegacyCertificationOperationalAccount = PalletOperationalAccountsOperationalAccount & {
  readonly hasUniswapTransfer?: PalletOperationalAccountsOperationalAccount['vaultCreated'];
  readonly bitcoinAccrual?: PalletOperationalAccountsOperationalAccount['vaultBitcoinAccrual'];
  readonly bitcoinAppliedTotal?: PalletOperationalAccountsOperationalAccount['vaultBitcoinAppliedTotal'];
  readonly hasTreasuryPoolParticipation?: PalletOperationalAccountsOperationalAccount['vaultCreated'];
  readonly isOperational?: PalletOperationalAccountsOperationalAccount['isOperationallyCertified'];
};

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
}): Promise<ICertificationProgress> {
  const { client, defaultAccountId, operationalAccountId } = args;
  const thresholds = getCertificationThresholds(client);

  if (operationalAccountId) {
    const accountRaw = await client.query.operationalAccounts.operationalAccounts(operationalAccountId);
    if (accountRaw.isSome) {
      return getCertificationProgressFromOperationalAccount(accountRaw, thresholds);
    }
  }

  const [bondLots, transferTotals, utxoKeys] = await Promise.all([
    TreasuryBonds.getBondLotsByAccount(client, defaultAccountId),
    client.query.crosschainTransfer.transferTotalsByAccount(defaultAccountId),
    client.query.bitcoinLocks.utxoIdsByOwnerAccount.keys(defaultAccountId),
  ]);

  const treasuryBitcoinAmount = (
    await Promise.all(
      utxoKeys.map(async key => {
        const lock = await BitcoinLock.get(client, key.args[1].toNumber());
        return lock?.isFunded ? lock.liquidityPromised : 0n;
      }),
    )
  ).reduce((total, amount) => total + amount, 0n);
  const treasuryBondAmount = BondLot.getTotals(bondLots).activeBondMicrogons;
  const treasuryUniswapTransferAmount = transferTotals.microgonsIn.toBigInt();

  return {
    hasOperationalAccount: false,
    isTreasuryCertified: false,
    hasTreasuryBitcoin: treasuryBitcoinAmount >= thresholds.treasuryMinimumBitcoin,
    hasTreasuryBonds: treasuryBondAmount >= thresholds.treasuryMinimumBonds,
    hasTreasuryUniswapTransfer: treasuryUniswapTransferAmount >= thresholds.treasuryMinimumUniswapTransfer,
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
      hasTreasuryBonds: false,
      hasTreasuryUniswapTransfer: false,
      isUpgradedToOperations: false,
      hasOperationalVault: false,
      hasOperationalMiningSeats: false,
      hasOperationalUniswapTransfer: false,
      isOperationallyCertified: false,
    };
  }

  const account = accountRaw.unwrap();
  const legacyAccount = account as LegacyCertificationOperationalAccount;
  const bitcoinAccrual = legacyAccount.bitcoinAccrual?.toBigInt() ?? account.vaultBitcoinAccrual?.toBigInt() ?? 0n;
  const bitcoinAppliedTotal =
    legacyAccount.bitcoinAppliedTotal?.toBigInt() ?? account.vaultBitcoinAppliedTotal?.toBigInt() ?? 0n;
  const miningSeatAccrual = account.miningSeatAccrual?.toNumber() ?? 0;
  const miningSeatAppliedTotal = account.miningSeatAppliedTotal?.toNumber() ?? 0;
  const accountBitcoinAmount = account.accountBitcoinAmount?.toBigInt() ?? bitcoinAccrual + bitcoinAppliedTotal;
  const accountVaultBondAmount = account.accountVaultBondAmount?.toBigInt() ?? 0n;
  const uniswapArgonTransfersInAmount = account.uniswapArgonTransfersInAmount?.toBigInt() ?? 0n;
  const operationalVaultSecuritization = bitcoinAccrual + bitcoinAppliedTotal;

  return {
    hasOperationalAccount: true,
    isTreasuryCertified: account.isTreasuryCertified?.toPrimitive() ?? false,
    hasTreasuryBitcoin:
      legacyAccount.bitcoinAccrual !== undefined || legacyAccount.bitcoinAppliedTotal !== undefined
        ? bitcoinAccrual + bitcoinAppliedTotal > 0n
        : accountBitcoinAmount >= rewardThresholds.treasuryMinimumBitcoin,
    hasTreasuryBonds:
      legacyAccount.hasTreasuryPoolParticipation?.toPrimitive() ??
      accountVaultBondAmount >= rewardThresholds.treasuryMinimumBonds,
    hasTreasuryUniswapTransfer:
      legacyAccount.hasUniswapTransfer?.toPrimitive() ??
      uniswapArgonTransfersInAmount >= rewardThresholds.treasuryMinimumUniswapTransfer,
    isUpgradedToOperations: account.isUpgradedToOperations?.toPrimitive() ?? false,
    hasOperationalVault:
      (account.vaultCreated?.toPrimitive() ?? false) &&
      operationalVaultSecuritization >= rewardThresholds.operationalMinimumVaultSecuritization,
    hasOperationalMiningSeats: miningSeatAccrual + miningSeatAppliedTotal >= rewardThresholds.miningSeatsForOperational,
    hasOperationalUniswapTransfer:
      legacyAccount.hasUniswapTransfer?.toPrimitive() ??
      uniswapArgonTransfersInAmount >= rewardThresholds.operationalMinimumUniswapTransfer,
    isOperationallyCertified:
      legacyAccount.isOperational?.toPrimitive() ?? account.isOperationallyCertified?.toPrimitive() ?? false,
  };
}

export function getCertificationThresholds(client: ArgonClient): ICertificationThresholds {
  const operationalConsts = client.consts.operationalAccounts as typeof client.consts.operationalAccounts & {
    treasuryMinimumBitcoin?: { toBigInt(): bigint };
    treasuryMinimumBonds?: { toBigInt(): bigint };
    treasuryMinimumUniswapTransfer?: { toBigInt(): bigint };
    operationalMinimumUniswapTransfer?: { toBigInt(): bigint };
    operationalMinimumVaultSecuritization?: { toBigInt(): bigint };
    miningSeatsForOperational?: { toNumber(): number };
  };

  return {
    treasuryMinimumBitcoin: operationalConsts.treasuryMinimumBitcoin?.toBigInt() ?? 0n,
    treasuryMinimumBonds: operationalConsts.treasuryMinimumBonds?.toBigInt() ?? 0n,
    treasuryMinimumUniswapTransfer: operationalConsts.treasuryMinimumUniswapTransfer?.toBigInt() ?? 0n,
    operationalMinimumUniswapTransfer: operationalConsts.operationalMinimumUniswapTransfer?.toBigInt() ?? 0n,
    operationalMinimumVaultSecuritization: (
      operationalConsts.operationalMinimumVaultSecuritization ??
      client.consts.vaults.operationalMinimumVaultSecuritization
    ).toBigInt(),
    miningSeatsForOperational: operationalConsts.miningSeatsForOperational?.toNumber() ?? 2,
  };
}
