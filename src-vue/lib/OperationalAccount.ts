import {
  ArgonClient,
  getOfflineRegistry,
  type KeyringPair,
  type Option,
  type PalletOperationalAccountsOperationalAccount,
  type PalletOperationalAccountsRewardsConfig,
  type SubmittableExtrinsic,
  u8aToHex,
} from '@argonprotocol/mainchain';
import {
  createDeferred,
  getCertificationProgressFromOperationalAccount,
  getCertificationThresholds,
  MICROGONS_PER_ARGON,
} from '@argonprotocol/apps-core';
import { stringToU8a } from '@polkadot/util';
import { blake2AsU8a, signatureVerify } from '@polkadot/util-crypto';
import { Config } from '../stores/config.ts';
import { getMainchainClient } from '../stores/mainchain.ts';
import { ExtrinsicType } from './db/TransactionsTable.ts';
import { type TransactionInfo } from './TransactionInfo.ts';
import { TransactionTracker, TxAttemptState } from './TransactionTracker.ts';
import { WalletKeys } from './WalletKeys.ts';

const OPERATIONAL_ACCOUNT_PROOF_MESSAGE_KEY = 'operational_primary_account';
const VAULT_ACCOUNT_PROOF_MESSAGE_KEY = 'operational_vault_account';
const MINING_ACCOUNT_PROOF_MESSAGE_KEY = 'operational_mining_account';
const OPERATIONAL_REWARDS_UPGRADE_ERROR = 'Reward claims cannot be submitted until the next Argon upgrade is active.';

export type IOperationalRewardConfig = {
  operationalActivationReward: bigint;
  operationalReferralBonusReward: bigint;
  operationalReferralsPerBonusReward: number;
  operationalMinimumUniswapTransfer: bigint;
  operationalMinimumVaultLockTicks: bigint;
  operationalMinimumVaultSecuritization: bigint;
  miningSeatsForOperational: number;
  treasuryMinimumBitcoin: bigint;
  treasuryMinimumBonds: bigint;
  treasuryMinimumUniswapTransfer: bigint;
  bitcoinLockSizeForUpgradeCode: bigint;
  miningSeatsPerUpgradeCode: number;
  maxAvailableUpgradeCodes: number;
};

export type IOperationalChainProgress = {
  hasOperationalAccount: boolean;
  hasVault: boolean;
  hasUniswapTransfer: boolean;
  hasTreasuryBondParticipation: boolean;
  hasFirstMiningSeat: boolean;
  hasSecondMiningSeat: boolean;
  hasBitcoinLock: boolean;
  bitcoinAccrual: bigint;
  miningSeatAccrual: number;
  operationalReferralsCount: number;
  upgradeCodePending: boolean;
  availableUpgradeCodes: number;
  unactivatedUpgradeCodes: number;
  rewardsEarnedCount: number;
  rewardsEarnedAmount: bigint;
  rewardsCollectedAmount: bigint;
  isUpgradedToOperations: boolean;
  isOperational: boolean;
  hasReferrer: boolean;
};

export type IOperationalRewardsClaimAvailability = {
  canClaimRewards: boolean;
  pendingRewards: bigint;
  treasuryReserves?: bigint;
  claimableNow: bigint;
  minimumClaimAmount: bigint;
};

type LegacyOperationalAccountConsts = {
  readonly operationalActivationReward?: ArgonClient['consts']['operationalAccounts']['operationalActivationReward'];
  readonly operationalReferralsPerBonusReward?: ArgonClient['consts']['operationalAccounts']['operationalReferralsPerBonusReward'];
  readonly bitcoinLockSizeForUpgradeCode?: ArgonClient['consts']['operationalAccounts']['bitcoinLockSizeForUpgradeCode'];
  readonly miningSeatsPerUpgradeCode?: ArgonClient['consts']['operationalAccounts']['miningSeatsPerUpgradeCode'];
  readonly maxAvailableUpgradeCodes?: ArgonClient['consts']['operationalAccounts']['maxAvailableUpgradeCodes'];
};

type LegacyPalletOperationalAccountsOperationalAccount = PalletOperationalAccountsOperationalAccount & {
  readonly hasUniswapTransfer?: PalletOperationalAccountsOperationalAccount['vaultCreated'];
  readonly bitcoinAccrual?: PalletOperationalAccountsOperationalAccount['vaultBitcoinAccrual'];
  readonly bitcoinAppliedTotal?: PalletOperationalAccountsOperationalAccount['vaultBitcoinAppliedTotal'];
  readonly referralPending?: PalletOperationalAccountsOperationalAccount['upgradeCodePending'];
  readonly referralAccessCodePending?: PalletOperationalAccountsOperationalAccount['upgradeCodePending'];
  readonly availableReferrals?: PalletOperationalAccountsOperationalAccount['availableUpgradeCodes'];
  readonly issuableAccessCodes?: PalletOperationalAccountsOperationalAccount['availableUpgradeCodes'];
  readonly unactivatedAccessCodes?: PalletOperationalAccountsOperationalAccount['availableUpgradeCodes'];
  readonly isOperational?: PalletOperationalAccountsOperationalAccount['isOperationallyCertified'];
  readonly sponsor?: PalletOperationalAccountsOperationalAccount['referrer'];
};

type LegacyPalletOperationalAccountsRewardsConfig = PalletOperationalAccountsRewardsConfig & {
  readonly operationalActivationReward?: PalletOperationalAccountsRewardsConfig['operationalActivationReward'];
  readonly operationalReferralBonusReward?: PalletOperationalAccountsRewardsConfig['operationalReferralBonusReward'];
};

function createOwnershipProof(account: KeyringPair, ownerAddr: string, accountAddr: string, domain: string) {
  const domainBytes = stringToU8a(domain);
  const payload = getOfflineRegistry()
    .createType('(Bytes,AccountId,AccountId)', [u8aToHex(domainBytes), ownerAddr, accountAddr])
    .toU8a();

  const payloadHash = blake2AsU8a(payload, 256);
  const signature = account.sign(payloadHash, { withType: true });

  return {
    signature,
    isValid: signatureVerify(payloadHash, signature, account.publicKey).isValid,
  };
}

export async function buildOperatorAccountRegistrationTx(args: {
  walletKeys: WalletKeys;
  config: Config;
  client?: ArgonClient;
}): Promise<SubmittableExtrinsic | undefined> {
  const { walletKeys, config } = args;
  const client = args.client ?? (await getMainchainClient(false));
  const existing = await loadOperationalAccount(walletKeys, client);
  if (existing.isSome) return;

  const [operationalAccount, operationalEncryptionKey, vaultingAccount, miningBotAccount] = await Promise.all([
    walletKeys.getOperationalKeypair(),
    walletKeys.getOperationalEncryptionKeypair(),
    walletKeys.getVaultingKeypair(),
    walletKeys.getMiningBotKeypair(),
  ]);
  const operationalAddr = operationalAccount.address;
  const vaultingAddr = vaultingAccount.address;
  const miningBotAddr = miningBotAccount.address;

  const operationalAccountProof = createOwnershipProof(
    operationalAccount,
    operationalAddr,
    operationalAddr,
    OPERATIONAL_ACCOUNT_PROOF_MESSAGE_KEY,
  );
  const vaultAccountProof = createOwnershipProof(
    vaultingAccount,
    operationalAddr,
    vaultingAddr,
    VAULT_ACCOUNT_PROOF_MESSAGE_KEY,
  );
  const miningBotAccountProof = createOwnershipProof(
    miningBotAccount,
    operationalAddr,
    miningBotAddr,
    MINING_ACCOUNT_PROOF_MESSAGE_KEY,
  );
  return client.tx.operationalAccounts.register({
    V1: {
      operationalAccount: operationalAddr,
      encryptionPubkey: operationalEncryptionKey,
      operationalAccountProof: { signature: operationalAccountProof.signature },
      vaultAccount: vaultingAddr,
      miningAccount: miningBotAddr,
      vaultAccountProof: { signature: vaultAccountProof.signature },
      miningAccountProof: { signature: miningBotAccountProof.signature },
      referrer: config.upstreamOperator?.accountId ?? null,
    },
  });
}

export async function ensureOperationalAccountRegistered(args: {
  transactionTracker: TransactionTracker;
  walletKeys: WalletKeys;
  config: Config;
  availableMicrogons: bigint;
  followWindowFinalizedBlocks?: number;
  client?: ArgonClient;
}): Promise<TransactionInfo | undefined> {
  await args.transactionTracker.load();

  const latestRegistrationTxInfo = args.transactionTracker.findLatestTxInfo(txInfo => {
    return txInfo.tx.extrinsicType === ExtrinsicType.OperationalRegister;
  });
  if (latestRegistrationTxInfo) {
    const txAttemptState = await args.transactionTracker.getTxAttemptState(
      latestRegistrationTxInfo,
      args.followWindowFinalizedBlocks ?? 2,
    );
    if (txAttemptState === TxAttemptState.Follow) {
      return latestRegistrationTxInfo;
    }
  }

  const client = args.client ?? (await getMainchainClient(false));
  const tx = await buildOperatorAccountRegistrationTx({
    walletKeys: args.walletKeys,
    config: args.config,
    client,
  });
  if (!tx) {
    return;
  }

  const txSigner = await args.walletKeys.getTreasuryKeypair();
  const feeEstimate = await tx.paymentInfo(txSigner.address);
  if (args.availableMicrogons < feeEstimate.partialFee.toBigInt()) {
    return;
  }

  return await args.transactionTracker.submitAndWatch({
    tx,
    txSigner,
    useLatestNonce: true,
    extrinsicType: ExtrinsicType.OperationalRegister,
  });
}

export async function getOperationalRewardConfig(client?: ArgonClient): Promise<IOperationalRewardConfig> {
  // Reward config and thresholds are chain-wide, and the archive client is more reliable than a
  // server-backed pruned client during startup or after runtime upgrades.
  client ??= await getMainchainClient(true);
  const consts = client.consts.operationalAccounts;
  const rewards = await client.query.operationalAccounts.rewards?.();
  const certificationThresholds = getCertificationThresholds(client);

  if (consts.operationalActivationReward) {
    return {
      operationalActivationReward:
        rewards?.operationalActivationReward?.toBigInt() ?? consts.operationalActivationReward.toBigInt(),
      operationalReferralBonusReward:
        rewards?.operationalReferralBonusReward?.toBigInt() ?? consts.operationalReferralBonusReward.toBigInt(),
      operationalReferralsPerBonusReward: consts.operationalReferralsPerBonusReward.toNumber(),
      operationalMinimumUniswapTransfer: consts.operationalMinimumUniswapTransfer.toBigInt(),
      operationalMinimumVaultLockTicks: client.consts.vaults.operationalMinimumVaultLockTicks.toBigInt(),
      operationalMinimumVaultSecuritization: (
        consts.operationalMinimumVaultSecuritization ?? client.consts.vaults.operationalMinimumVaultSecuritization
      ).toBigInt(),
      miningSeatsForOperational: consts.miningSeatsForOperational.toNumber(),
      treasuryMinimumBitcoin: certificationThresholds.treasuryMinimumBitcoin,
      treasuryMinimumBonds: certificationThresholds.treasuryMinimumBonds,
      treasuryMinimumUniswapTransfer: certificationThresholds.treasuryMinimumUniswapTransfer,
      bitcoinLockSizeForUpgradeCode: consts.bitcoinLockSizeForUpgradeCode.toBigInt(),
      miningSeatsPerUpgradeCode: consts.miningSeatsPerUpgradeCode.toNumber(),
      maxAvailableUpgradeCodes: consts.maxAvailableUpgradeCodes.toNumber(),
    };
  }

  const legacyConsts = consts as typeof consts & LegacyOperationalAccountConsts;
  const legacyRewards = rewards as LegacyPalletOperationalAccountsRewardsConfig | undefined;

  return {
    operationalActivationReward:
      legacyRewards?.operationalActivationReward?.toBigInt() ??
      legacyConsts.operationalActivationReward?.toBigInt() ??
      0n,
    operationalReferralBonusReward:
      legacyRewards?.operationalReferralBonusReward?.toBigInt() ?? consts.operationalReferralBonusReward.toBigInt(),
    operationalReferralsPerBonusReward: legacyConsts.operationalReferralsPerBonusReward?.toNumber() ?? 0,
    operationalMinimumUniswapTransfer: 0n,
    operationalMinimumVaultLockTicks: client.consts.vaults.operationalMinimumVaultLockTicks.toBigInt(),
    operationalMinimumVaultSecuritization: (
      consts.operationalMinimumVaultSecuritization ?? client.consts.vaults.operationalMinimumVaultSecuritization
    ).toBigInt(),
    miningSeatsForOperational: 2,
    treasuryMinimumBitcoin: certificationThresholds.treasuryMinimumBitcoin,
    treasuryMinimumBonds: certificationThresholds.treasuryMinimumBonds,
    treasuryMinimumUniswapTransfer: certificationThresholds.treasuryMinimumUniswapTransfer,
    bitcoinLockSizeForUpgradeCode: legacyConsts.bitcoinLockSizeForUpgradeCode?.toBigInt() ?? 0n,
    miningSeatsPerUpgradeCode: legacyConsts.miningSeatsPerUpgradeCode?.toNumber() ?? 0,
    maxAvailableUpgradeCodes: legacyConsts.maxAvailableUpgradeCodes?.toNumber() ?? 0,
  };
}

export async function buildOperationalActivationRewardClaimTx(
  amount: bigint,
  client?: ArgonClient,
): Promise<SubmittableExtrinsic> {
  client ??= await getMainchainClient(false);

  if (!('claimRewards' in client.tx.operationalAccounts)) {
    throw new Error(OPERATIONAL_REWARDS_UPGRADE_ERROR);
  }

  return client.tx.utility.batchAll([
    client.tx.operationalAccounts.activate(),
    client.tx.operationalAccounts.claimRewards(amount),
  ]);
}

export async function getOperationalRewardsClaimAvailability(
  walletKeys: WalletKeys,
  client?: ArgonClient,
): Promise<IOperationalRewardsClaimAvailability> {
  client ??= await getMainchainClient(false);

  const accountRaw = await loadOperationalAccount(walletKeys, client);
  const account = accountRaw.isSome ? accountRaw.unwrap() : undefined;
  const rawPendingRewards = account
    ? account.rewardsEarnedAmount.toBigInt() - account.rewardsCollectedAmount.toBigInt()
    : 0n;
  const pendingRewards = rawPendingRewards > 0n ? rawPendingRewards : 0n;
  const canClaimRewards = 'claimRewards' in client.tx.operationalAccounts;
  const treasuryReserves = canClaimRewards ? await getTreasuryReserveBalance(client) : undefined;
  const availableRewards =
    canClaimRewards && (treasuryReserves === undefined || treasuryReserves > pendingRewards)
      ? pendingRewards
      : (treasuryReserves ?? 0n);
  const wholeArgon = BigInt(MICROGONS_PER_ARGON);

  return {
    canClaimRewards,
    pendingRewards,
    treasuryReserves,
    claimableNow: availableRewards - (availableRewards % wholeArgon),
    minimumClaimAmount: wholeArgon,
  };
}

export async function buildOperationalRewardsClaimTx(
  amount: bigint,
  client?: ArgonClient,
): Promise<SubmittableExtrinsic> {
  client ??= await getMainchainClient(false);

  if (!('claimRewards' in client.tx.operationalAccounts)) {
    throw new Error(OPERATIONAL_REWARDS_UPGRADE_ERROR);
  }

  return client.tx.operationalAccounts.claimRewards(amount);
}

export async function subscribeOperationalAccount(
  walletKeys: WalletKeys,
  onUpdate: (update: IOperationalChainProgress) => void,
  rewardConfig?: IOperationalRewardConfig,
  client?: ArgonClient,
) {
  client ??= await getMainchainClient(false);
  const deferred = createDeferred<void>();
  const unsubscribe = await client.query.operationalAccounts.operationalAccounts(
    walletKeys.operationalAddress,
    accountRaw => {
      onUpdate(getOperationalChainProgressFromAccount(accountRaw, rewardConfig));

      if (!deferred.isResolved) {
        deferred.resolve();
      }
    },
  );

  await deferred.promise;
  return unsubscribe;
}

export async function loadOperationalAccount(
  walletKeys: WalletKeys,
  client?: ArgonClient,
): Promise<Option<PalletOperationalAccountsOperationalAccount>> {
  client ??= await getMainchainClient(false);
  return await client.query.operationalAccounts.operationalAccounts(walletKeys.operationalAddress);
}

export function getOperationalChainProgressFromAccount(
  accountRaw: Option<PalletOperationalAccountsOperationalAccount>,
  rewardConfig?: IOperationalRewardConfig,
): IOperationalChainProgress {
  const entry: IOperationalChainProgress = {
    hasOperationalAccount: accountRaw.isSome,
    hasVault: false,
    hasUniswapTransfer: false,
    hasTreasuryBondParticipation: false,
    hasFirstMiningSeat: false,
    hasSecondMiningSeat: false,
    hasBitcoinLock: false,
    bitcoinAccrual: 0n,
    miningSeatAccrual: 0,
    operationalReferralsCount: 0,
    upgradeCodePending: false,
    availableUpgradeCodes: 0,
    unactivatedUpgradeCodes: 0,
    rewardsEarnedCount: 0,
    rewardsEarnedAmount: 0n,
    rewardsCollectedAmount: 0n,
    isUpgradedToOperations: false,
    isOperational: false,
    hasReferrer: false,
  };

  if (!accountRaw.isSome) return entry;

  const account = accountRaw.unwrap();
  const legacyAccount = account as LegacyPalletOperationalAccountsOperationalAccount;
  const certificationProgress = getCertificationProgressFromOperationalAccount(accountRaw, rewardConfig);

  const operationalMinimumUniswapTransfer = rewardConfig?.operationalMinimumUniswapTransfer ?? 0n;

  const bitcoinAccrual =
    legacyAccount.bitcoinAccrual?.toBigInt() ?? account.vaultBitcoinAccrual?.toBigInt() ?? entry.bitcoinAccrual;
  const bitcoinAppliedTotal =
    legacyAccount.bitcoinAppliedTotal?.toBigInt() ?? account.vaultBitcoinAppliedTotal?.toBigInt() ?? 0n;
  const miningSeatAccrualValue = account.miningSeatAccrual?.toNumber() ?? entry.miningSeatAccrual;
  const uniswapArgonTransfersInAmountValue = account.uniswapArgonTransfersInAmount?.toBigInt() ?? 0n;

  return {
    hasOperationalAccount: certificationProgress.hasOperationalAccount,
    hasVault: account.vaultCreated?.toPrimitive() ?? false,
    hasUniswapTransfer:
      legacyAccount.hasUniswapTransfer?.toPrimitive() ??
      uniswapArgonTransfersInAmountValue >= operationalMinimumUniswapTransfer,
    hasTreasuryBondParticipation: certificationProgress.hasTreasuryBonds,
    hasFirstMiningSeat: miningSeatAccrualValue + (account.miningSeatAppliedTotal?.toNumber() ?? 0) >= 1,
    hasSecondMiningSeat: miningSeatAccrualValue + (account.miningSeatAppliedTotal?.toNumber() ?? 0) >= 2,
    hasBitcoinLock: certificationProgress.hasTreasuryBitcoin,
    bitcoinAccrual,
    miningSeatAccrual: miningSeatAccrualValue,
    operationalReferralsCount: account.operationalReferralsCount?.toNumber() ?? entry.operationalReferralsCount,
    upgradeCodePending:
      legacyAccount.referralPending?.toPrimitive() ??
      legacyAccount.referralAccessCodePending?.toPrimitive() ??
      account.upgradeCodePending?.toPrimitive() ??
      entry.upgradeCodePending,
    availableUpgradeCodes:
      legacyAccount.availableReferrals?.toNumber() ??
      legacyAccount.issuableAccessCodes?.toNumber() ??
      account.availableUpgradeCodes?.toNumber() ??
      entry.availableUpgradeCodes,
    unactivatedUpgradeCodes: legacyAccount.unactivatedAccessCodes?.toNumber() ?? entry.unactivatedUpgradeCodes,
    rewardsEarnedCount: account.rewardsEarnedCount?.toNumber() ?? entry.rewardsEarnedCount,
    rewardsEarnedAmount: account.rewardsEarnedAmount?.toBigInt() ?? entry.rewardsEarnedAmount,
    rewardsCollectedAmount: account.rewardsCollectedAmount?.toBigInt() ?? entry.rewardsCollectedAmount,
    isUpgradedToOperations: certificationProgress.isUpgradedToOperations,
    isOperational: certificationProgress.isOperationallyCertified,
    hasReferrer: legacyAccount.sponsor?.isSome ?? account.referrer?.isSome ?? entry.hasReferrer,
  };
}

async function getTreasuryReserveBalance(client: ArgonClient): Promise<bigint | undefined> {
  const treasuryReservesAccount = client.consts.treasury.treasuryReservesAccount;
  if (!treasuryReservesAccount) return;

  const account = await client.query.system.account(treasuryReservesAccount.toString());
  return account.data.free.toBigInt();
}
