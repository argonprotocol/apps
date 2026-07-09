import {
  ArgonClient,
  getOfflineRegistry,
  type KeyringPair,
  type Option,
  type PalletOperationalAccountsOperationalAccount,
  type SubmittableExtrinsic,
  u8aToHex,
} from '@argonprotocol/mainchain';
import {
  createDeferred,
  getCertificationProgressFromOperationalAccount,
  getCertificationThresholds,
  type IBigIntCodec,
  type IBooleanCodec,
  type INumberCodec,
  type IOperationalAccessProof,
  MICROGONS_PER_ARGON,
} from '@argonprotocol/apps-core';
import { stringToU8a } from '@polkadot/util';
import { blake2AsU8a, signatureVerify } from '@polkadot/util-crypto';
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
  hasTreasuryUniswapTransfer: boolean;
  hasTreasuryBondParticipation: boolean;
  hasFirstMiningSeat: boolean;
  hasSecondMiningSeat: boolean;
  hasBitcoinLock: boolean;
  bitcoinAccrual: bigint;
  miningSeatAccrual: number;
  operationalCertificationsCount: number;
  accessCodePending: boolean;
  availableAccessCodes: number;
  unactivatedAccessCodes: number;
  rewardsEarnedCount: number;
  rewardsEarnedAmount: bigint;
  rewardsCollectedAmount: bigint;
  isUpgradedToOperations: boolean;
  isOperational: boolean;
  hasUpstreamAccount: boolean;
};

export type IOperationalRewardsClaimAvailability = {
  canClaimRewards: boolean;
  pendingRewards: bigint;
  treasuryReserves?: bigint;
  claimableNow: bigint;
  minimumClaimAmount: bigint;
};

// Deployed mainchain v1.4.9 uses this operational_accounts surface at specVersion 155.
interface ISpec155OperationalAccount extends PalletOperationalAccountsOperationalAccount {
  readonly sponsor?: Option<any>;
  readonly hasUniswapTransfer?: IBooleanCodec;
  readonly bitcoinAccrual?: IBigIntCodec;
  readonly bitcoinAppliedTotal?: IBigIntCodec;
  readonly referralPending?: IBooleanCodec;
  readonly availableReferrals?: INumberCodec;
  readonly operationalReferralsCount?: INumberCodec;
  readonly isOperational?: IBooleanCodec;
}

interface ISpec155OperationalAccountConsts {
  readonly operationalMinimumVaultSecuritization?: IBigIntCodec;
  readonly miningSeatsForOperational?: INumberCodec;
  readonly operationalReferralReward?: IBigIntCodec;
  readonly operationalReferralBonusReward?: IBigIntCodec;
  readonly referralBonusEveryXOperationalSponsees?: INumberCodec;
  readonly bitcoinLockSizeForReferral?: IBigIntCodec;
  readonly miningSeatsPerReferral?: INumberCodec;
  readonly maxAvailableReferrals?: INumberCodec;
}

interface ISpec155OperationalRewardsConfig {
  readonly operationalReferralReward?: IBigIntCodec;
  readonly referralBonusReward?: IBigIntCodec;
}

interface IBuildOperatorAccountRegistrationTxArgs {
  walletKeys: WalletKeys;
  accessProof: IOperationalAccessProof | null;
  client?: ArgonClient;
}

interface IEnsureOperationalAccountRegisteredArgs {
  transactionTracker: TransactionTracker;
  walletKeys: WalletKeys;
  accessProof: IOperationalAccessProof | null;
  availableMicrogons: bigint;
  followWindowFinalizedBlocks?: number;
  client?: ArgonClient;
}

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

export async function buildOperatorAccountRegistrationTx(
  args: IBuildOperatorAccountRegistrationTxArgs,
): Promise<SubmittableExtrinsic | undefined> {
  const { walletKeys, accessProof } = args;
  const client = args.client ?? (await getMainchainClient(false));
  const existing = await loadOperationalAccount(walletKeys, client);
  if (existing.isSome) return;
  if (!supportsOperationalAccessProofRuntime(client)) return;

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
      accessProof: accessProof
        ? {
            upstreamAccount: accessProof.upstreamAccount,
            signature: accessProof.signature,
          }
        : null,
    },
  });
}

export async function ensureOperationalAccountRegistered(
  args: IEnsureOperationalAccountRegisteredArgs,
): Promise<TransactionInfo | undefined> {
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
    accessProof: args.accessProof,
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

  if (supportsOperationalAccessProofRuntime(client)) {
    return {
      operationalActivationReward:
        rewards?.operationalCertificationReward?.toBigInt() ?? consts.operationalCertificationReward.toBigInt(),
      operationalReferralBonusReward:
        rewards?.operationalCertificationBonusReward?.toBigInt() ??
        consts.operationalCertificationBonusReward.toBigInt(),
      operationalReferralsPerBonusReward: consts.operationalCertificationsPerBonusReward.toNumber(),
      operationalMinimumUniswapTransfer: consts.operationalMinimumUniswapTransfer.toBigInt(),
      operationalMinimumVaultLockTicks: client.consts.vaults.operationalMinimumVaultLockTicks.toBigInt(),
      operationalMinimumVaultSecuritization: (
        consts.operationalMinimumVaultSecuritization ?? client.consts.vaults.operationalMinimumVaultSecuritization
      ).toBigInt(),
      miningSeatsForOperational: consts.miningSeatsForOperational.toNumber(),
      treasuryMinimumBitcoin: certificationThresholds.treasuryMinimumBitcoin,
      treasuryMinimumBonds: certificationThresholds.treasuryMinimumBonds,
      treasuryMinimumUniswapTransfer: certificationThresholds.treasuryMinimumUniswapTransfer,
      bitcoinLockSizeForUpgradeCode: consts.bitcoinLockSizeForAccessCode.toBigInt(),
      miningSeatsPerUpgradeCode: consts.miningSeatsPerAccessCode.toNumber(),
      maxAvailableUpgradeCodes: consts.maxAvailableAccessCodes.toNumber(),
    };
  }

  const spec155Consts = consts as typeof consts & ISpec155OperationalAccountConsts;
  const spec155Rewards = rewards as ISpec155OperationalRewardsConfig | undefined;

  return {
    operationalActivationReward:
      spec155Rewards?.operationalReferralReward?.toBigInt() ??
      spec155Consts.operationalReferralReward?.toBigInt() ??
      0n,
    operationalReferralBonusReward:
      spec155Rewards?.referralBonusReward?.toBigInt() ?? spec155Consts.operationalReferralBonusReward?.toBigInt() ?? 0n,
    operationalReferralsPerBonusReward: spec155Consts.referralBonusEveryXOperationalSponsees?.toNumber() ?? 0,
    // specVersion 155 tracked Uniswap completion as a boolean on the account.
    operationalMinimumUniswapTransfer: 1n,
    operationalMinimumVaultLockTicks: client.consts.vaults.operationalMinimumVaultLockTicks.toBigInt(),
    operationalMinimumVaultSecuritization: (
      spec155Consts.operationalMinimumVaultSecuritization ?? client.consts.vaults.operationalMinimumVaultSecuritization
    ).toBigInt(),
    miningSeatsForOperational: spec155Consts.miningSeatsForOperational?.toNumber() ?? 2,
    treasuryMinimumBitcoin: certificationThresholds.treasuryMinimumBitcoin,
    treasuryMinimumBonds: certificationThresholds.treasuryMinimumBonds,
    treasuryMinimumUniswapTransfer: certificationThresholds.treasuryMinimumUniswapTransfer,
    bitcoinLockSizeForUpgradeCode: spec155Consts.bitcoinLockSizeForReferral?.toBigInt() ?? 0n,
    miningSeatsPerUpgradeCode: spec155Consts.miningSeatsPerReferral?.toNumber() ?? 0,
    maxAvailableUpgradeCodes: spec155Consts.maxAvailableReferrals?.toNumber() ?? 0,
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
    hasTreasuryUniswapTransfer: false,
    hasTreasuryBondParticipation: false,
    hasFirstMiningSeat: false,
    hasSecondMiningSeat: false,
    hasBitcoinLock: false,
    bitcoinAccrual: 0n,
    miningSeatAccrual: 0,
    operationalCertificationsCount: 0,
    accessCodePending: false,
    availableAccessCodes: 0,
    unactivatedAccessCodes: 0,
    rewardsEarnedCount: 0,
    rewardsEarnedAmount: 0n,
    rewardsCollectedAmount: 0n,
    isUpgradedToOperations: false,
    isOperational: false,
    hasUpstreamAccount: false,
  };

  if (!accountRaw.isSome) return entry;

  const account = accountRaw.unwrap();
  const spec155Account = account as ISpec155OperationalAccount;
  const certificationProgress = getCertificationProgressFromOperationalAccount(accountRaw, rewardConfig);

  const operationalMinimumUniswapTransfer = rewardConfig?.operationalMinimumUniswapTransfer ?? 0n;

  const bitcoinAccrual =
    spec155Account.bitcoinAccrual?.toBigInt() ?? account.vaultBitcoinAccrual?.toBigInt() ?? entry.bitcoinAccrual;
  const bitcoinAppliedTotal =
    spec155Account.bitcoinAppliedTotal?.toBigInt() ?? account.vaultBitcoinAppliedTotal?.toBigInt() ?? 0n;
  const miningSeatAccrualValue = account.miningSeatAccrual?.toNumber() ?? entry.miningSeatAccrual;
  const uniswapArgonTransfersInAmountValue = account.uniswapArgonTransfersInAmount?.toBigInt() ?? 0n;

  return {
    hasOperationalAccount: certificationProgress.hasOperationalAccount,
    hasVault: account.vaultCreated?.toPrimitive() ?? false,
    hasUniswapTransfer:
      spec155Account.hasUniswapTransfer?.toPrimitive() ??
      uniswapArgonTransfersInAmountValue >= operationalMinimumUniswapTransfer,
    hasTreasuryUniswapTransfer: certificationProgress.hasTreasuryUniswapTransfer,
    hasTreasuryBondParticipation: certificationProgress.hasTreasuryBonds,
    hasFirstMiningSeat: miningSeatAccrualValue + (account.miningSeatAppliedTotal?.toNumber() ?? 0) >= 1,
    hasSecondMiningSeat: miningSeatAccrualValue + (account.miningSeatAppliedTotal?.toNumber() ?? 0) >= 2,
    hasBitcoinLock: certificationProgress.hasTreasuryBitcoin,
    bitcoinAccrual,
    miningSeatAccrual: miningSeatAccrualValue,
    operationalCertificationsCount:
      account.operationalCertificationsCount?.toNumber() ??
      spec155Account.operationalReferralsCount?.toNumber() ??
      entry.operationalCertificationsCount,
    accessCodePending:
      account.accessCodePending?.toPrimitive() ??
      spec155Account.referralPending?.toPrimitive() ??
      entry.accessCodePending,
    availableAccessCodes:
      account.availableAccessCodes?.toNumber() ??
      spec155Account.availableReferrals?.toNumber() ??
      entry.availableAccessCodes,
    unactivatedAccessCodes: entry.unactivatedAccessCodes,
    rewardsEarnedCount: account.rewardsEarnedCount?.toNumber() ?? entry.rewardsEarnedCount,
    rewardsEarnedAmount: account.rewardsEarnedAmount?.toBigInt() ?? entry.rewardsEarnedAmount,
    rewardsCollectedAmount: account.rewardsCollectedAmount?.toBigInt() ?? entry.rewardsCollectedAmount,
    isUpgradedToOperations: certificationProgress.isUpgradedToOperations,
    isOperational: certificationProgress.isOperationallyCertified,
    hasUpstreamAccount: account.upstreamAccount?.isSome ?? spec155Account.sponsor?.isSome ?? entry.hasUpstreamAccount,
  };
}

export function supportsOperationalAccessProofRuntime(client: ArgonClient): boolean {
  return !!client.consts?.operationalAccounts && 'minimumBitcoin' in client.consts.operationalAccounts;
}

async function getTreasuryReserveBalance(client: ArgonClient): Promise<bigint | undefined> {
  const treasuryReservesAccount = client.consts.treasury.treasuryReservesAccount;
  if (!treasuryReservesAccount) return;

  const account = await client.query.system.account(treasuryReservesAccount.toString());
  return account.data.free.toBigInt();
}
