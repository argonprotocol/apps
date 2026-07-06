import {
  ArgonClient,
  getOfflineRegistry,
  hexToU8a,
  Keyring,
  type KeyringPair,
  type Option,
  type PalletOperationalAccountsOperationalAccount,
  type PalletOperationalAccountsRewardsConfig,
  type SubmittableExtrinsic,
  TxSubmitter,
  u8aToHex,
} from '@argonprotocol/mainchain';
import { createDeferred, MICROGONS_PER_ARGON } from '@argonprotocol/apps-core';
import { stringToU8a } from '@polkadot/util';
import { blake2AsU8a, signatureVerify } from '@polkadot/util-crypto';
import { Config } from '../stores/config.ts';
import type { IOperationalReferral } from '../interfaces/IConfig.ts';
import { getMainchainClient } from '../stores/mainchain.ts';
import { WalletType } from './Wallet.ts';
import { WalletKeys } from './WalletKeys.ts';

const OPERATIONAL_ACCOUNT_PROOF_MESSAGE_KEY = 'operational_primary_account';
const VAULT_ACCOUNT_PROOF_MESSAGE_KEY = 'operational_vault_account';
const MINING_ACCOUNT_PROOF_MESSAGE_KEY = 'operational_mining_account';
const MINING_FUNDING_ACCOUNT_PROOF_MESSAGE_KEY = 'operational_mining_funding';
const MINING_BOT_ACCOUNT_PROOF_MESSAGE_KEY = 'operational_mining_bot';
const REFERRAL_CLAIM_PROOF_MESSAGE_KEY = 'referral_claim';
const REFERRAL_SPONSOR_GRANT_MESSAGE_KEY = 'referral_sponsor_grant';
const OPERATIONAL_REWARDS_UPGRADE_ERROR = 'Reward claims cannot be submitted until the next Argon upgrade is active.';

export type IOperationalRewardConfig = {
  operationalReferralReward: bigint;
  referralBonusReward: bigint;
  referralBonusEveryXOperationalSponsees: number;
  operationalMinimumUniswapTransfer: bigint;
  operationalMinimumVaultLockTicks: bigint;
  operationalMinimumVaultSecuritization: bigint;
  treasuryMinimumBitcoin: bigint;
  treasuryMinimumBonds: bigint;
  bitcoinLockSizeForReferral: bigint;
  miningSeatsPerReferral: number;
  maxAvailableReferrals: number;
};

export type IOperationalChainProgress = {
  hasVault: boolean;
  hasUniswapTransfer: boolean;
  hasTreasuryBondParticipation: boolean;
  hasFirstMiningSeat: boolean;
  hasSecondMiningSeat: boolean;
  hasBitcoinLock: boolean;
  bitcoinAccrual: bigint;
  miningSeatAccrual: number;
  operationalReferralsCount: number;
  referralPending: boolean;
  availableReferrals: number;
  unactivatedReferrals: number;
  rewardsEarnedCount: number;
  rewardsEarnedAmount: bigint;
  rewardsCollectedAmount: bigint;
  isOperational: boolean;
  hasSponsor: boolean;
};

export type IOperationalRewardsClaimAvailability = {
  canClaimRewards: boolean;
  pendingRewards: bigint;
  treasuryReserves?: bigint;
  claimableNow: bigint;
  minimumClaimAmount: bigint;
};

type LegacyOperationalAccountConsts = {
  readonly operationalReferralReward?: ArgonClient['consts']['operationalAccounts']['operationalActivationReward'];
  readonly referralBonusEveryXOperationalSponsees?: ArgonClient['consts']['operationalAccounts']['operationalReferralsPerBonusReward'];
  readonly bitcoinLockSizeForReferral?: ArgonClient['consts']['operationalAccounts']['bitcoinLockSizeForUpgradeCode'];
  readonly miningSeatsPerReferral?: ArgonClient['consts']['operationalAccounts']['miningSeatsPerUpgradeCode'];
  readonly maxAvailableReferrals?: ArgonClient['consts']['operationalAccounts']['maxAvailableUpgradeCodes'];
};

type LegacyPalletOperationalAccountsOperationalAccount = PalletOperationalAccountsOperationalAccount & {
  readonly hasUniswapTransfer?: PalletOperationalAccountsOperationalAccount['vaultCreated'];
  readonly bitcoinAccrual?: PalletOperationalAccountsOperationalAccount['vaultBitcoinAccrual'];
  readonly bitcoinAppliedTotal?: PalletOperationalAccountsOperationalAccount['vaultBitcoinAppliedTotal'];
  readonly hasTreasuryPoolParticipation?: PalletOperationalAccountsOperationalAccount['vaultCreated'];
  readonly referralPending?: PalletOperationalAccountsOperationalAccount['upgradeCodePending'];
  readonly availableReferrals?: PalletOperationalAccountsOperationalAccount['availableUpgradeCodes'];
  readonly isOperational?: PalletOperationalAccountsOperationalAccount['isOperationallyCertified'];
  readonly sponsor?: PalletOperationalAccountsOperationalAccount['referrer'];
};

type LegacyPalletOperationalAccountsRewardsConfig = PalletOperationalAccountsRewardsConfig & {
  readonly operationalReferralReward?: PalletOperationalAccountsRewardsConfig['operationalActivationReward'];
  readonly referralBonusReward?: PalletOperationalAccountsRewardsConfig['operationalReferralBonusReward'];
};

let setupOperatorAccountPromise: Promise<boolean> | undefined;

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

export function signReferralSponsorGrant(args: {
  sponsor: KeyringPair;
  inviteCode: string;
  expiresAtFrame: number;
}): string {
  return u8aToHex(
    args.sponsor.sign(getReferralSponsorGrantPayloadHash(args.sponsor.address, args.inviteCode, args.expiresAtFrame), {
      withType: true,
    }),
  );
}

export function verifyReferralSponsorGrant(args: {
  sponsor: string;
  inviteCode: string;
  expiresAtFrame: number;
  sponsorSignature: string;
}): boolean {
  return signatureVerify(
    getReferralSponsorGrantPayloadHash(args.sponsor, args.inviteCode, args.expiresAtFrame),
    hexToU8a(args.sponsorSignature),
    args.sponsor,
  ).isValid;
}

export function createReferralProof(args: {
  inviteSecret: string;
  accountId: string;
  operationalReferral: IOperationalReferral;
}) {
  const pair = new Keyring({ type: 'sr25519' }).addFromMnemonic(args.inviteSecret);
  const inviteCode = u8aToHex(pair.publicKey);
  const { operationalReferral } = args;

  return {
    referralCode: pair.publicKey,
    referralSignature: pair.sign(getReferralClaimPayloadHash(inviteCode, args.accountId)),
    sponsor: operationalReferral.sponsor,
    expiresAtFrame: operationalReferral.expiresAtFrame,
    sponsorSignature: hexToU8a(operationalReferral.sponsorSignature),
  };
}

export async function buildOperatorAccountRegistrationTx(args: {
  walletKeys: WalletKeys;
  config: Config;
  client?: ArgonClient;
}): Promise<SubmittableExtrinsic | undefined> {
  const { config, walletKeys } = args;
  const client = args.client ?? (await getMainchainClient(false));
  const existing = await loadOperationalAccount(walletKeys, client);
  if (existing.isSome) return;

  const upstreamOperator = config.upstreamOperator;

  const [operationalAccount, operationalEncryptionKey, vaultingAccount, defaultArgonAccount, miningBotAccount] =
    await Promise.all([
      walletKeys.getOperationalKeypair(),
      walletKeys.getOperationalEncryptionKeypair(),
      walletKeys.getVaultingKeypair(),
      walletKeys.getDefaultArgonKeypair(),
      walletKeys.getMiningBotKeypair(),
    ]);
  const operationalAddr = operationalAccount.address;
  const vaultingAddr = vaultingAccount.address;
  const defaultArgonAddr = defaultArgonAccount.address;
  const miningBotAddr = miningBotAccount.address;
  let referralProof = null;
  if (upstreamOperator?.inviteSecret && upstreamOperator.operationalReferral) {
    referralProof = createReferralProof({
      inviteSecret: upstreamOperator.inviteSecret,
      accountId: operationalAddr,
      operationalReferral: upstreamOperator.operationalReferral,
    });
  }

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
  const usesUnifiedMiningAccount =
    typeof client.query.operationalAccounts.encryptedServerByDownstreamAccount === 'function';
  const miningBotAccountProof = createOwnershipProof(
    miningBotAccount,
    operationalAddr,
    miningBotAddr,
    usesUnifiedMiningAccount ? MINING_ACCOUNT_PROOF_MESSAGE_KEY : MINING_BOT_ACCOUNT_PROOF_MESSAGE_KEY,
  );

  if (usesUnifiedMiningAccount) {
    return client.tx.operationalAccounts.register({
      V1: {
        operationalAccount: operationalAddr,
        encryptionPubkey: operationalEncryptionKey,
        operationalAccountProof: { signature: operationalAccountProof.signature },
        vaultAccount: vaultingAddr,
        miningAccount: miningBotAddr,
        vaultAccountProof: { signature: vaultAccountProof.signature },
        miningAccountProof: { signature: miningBotAccountProof.signature },
        referrer: referralProof?.sponsor ?? null,
      },
    });
  }

  const miningFundingAccountProof = createOwnershipProof(
    defaultArgonAccount,
    operationalAddr,
    defaultArgonAddr,
    MINING_FUNDING_ACCOUNT_PROOF_MESSAGE_KEY,
  );
  return client.tx.operationalAccounts.register({
    V1: {
      operationalAccount: operationalAddr,
      encryptionPubkey: operationalEncryptionKey,
      operationalAccountProof: { signature: operationalAccountProof.signature },
      vaultAccount: vaultingAddr,
      miningFundingAccount: defaultArgonAddr,
      miningBotAccount: miningBotAddr,
      vaultAccountProof: { signature: vaultAccountProof.signature },
      miningFundingAccountProof: { signature: miningFundingAccountProof.signature },
      miningBotAccountProof: { signature: miningBotAccountProof.signature },
      referralProof,
    },
  });
}

export async function ensureOperatorAccountRegistered(args: {
  walletKeys: WalletKeys;
  config: Config;
  feePayers: WalletType[];
  client?: ArgonClient;
}): Promise<boolean> {
  if (setupOperatorAccountPromise) {
    return await setupOperatorAccountPromise;
  }

  const promise = registerOperatorAccount(args);
  setupOperatorAccountPromise = promise;

  try {
    return await promise;
  } finally {
    setupOperatorAccountPromise = undefined;
  }
}

export async function getOperationalRewardConfig(client?: ArgonClient): Promise<IOperationalRewardConfig> {
  // Reward config and thresholds are chain-wide, and the archive client is more reliable than a
  // server-backed pruned client during startup or after runtime upgrades.
  client ??= await getMainchainClient(true);
  const consts = client.consts.operationalAccounts;
  const rewards = await client.query.operationalAccounts.rewards?.();

  if (consts.operationalActivationReward) {
    return {
      operationalReferralReward:
        rewards?.operationalActivationReward?.toBigInt() ?? consts.operationalActivationReward.toBigInt(),
      referralBonusReward:
        rewards?.operationalReferralBonusReward?.toBigInt() ?? consts.operationalReferralBonusReward.toBigInt(),
      referralBonusEveryXOperationalSponsees: consts.operationalReferralsPerBonusReward.toNumber(),
      operationalMinimumUniswapTransfer: consts.operationalMinimumUniswapTransfer.toBigInt(),
      operationalMinimumVaultLockTicks: client.consts.vaults.operationalMinimumVaultLockTicks.toBigInt(),
      operationalMinimumVaultSecuritization: (
        consts.operationalMinimumVaultSecuritization ?? client.consts.vaults.operationalMinimumVaultSecuritization
      ).toBigInt(),
      treasuryMinimumBitcoin: consts.treasuryMinimumBitcoin.toBigInt(),
      treasuryMinimumBonds: consts.treasuryMinimumBonds.toBigInt(),
      bitcoinLockSizeForReferral: consts.bitcoinLockSizeForUpgradeCode.toBigInt(),
      miningSeatsPerReferral: consts.miningSeatsPerUpgradeCode.toNumber(),
      maxAvailableReferrals: consts.maxAvailableUpgradeCodes.toNumber(),
    };
  }

  const legacyConsts = consts as typeof consts & LegacyOperationalAccountConsts;
  const legacyRewards = rewards as LegacyPalletOperationalAccountsRewardsConfig | undefined;

  return {
    operationalReferralReward:
      legacyRewards?.operationalReferralReward?.toBigInt() ?? legacyConsts.operationalReferralReward?.toBigInt() ?? 0n,
    referralBonusReward:
      legacyRewards?.referralBonusReward?.toBigInt() ?? consts.operationalReferralBonusReward.toBigInt(),
    referralBonusEveryXOperationalSponsees: legacyConsts.referralBonusEveryXOperationalSponsees?.toNumber() ?? 0,
    operationalMinimumUniswapTransfer: 0n,
    operationalMinimumVaultLockTicks: client.consts.vaults.operationalMinimumVaultLockTicks.toBigInt(),
    operationalMinimumVaultSecuritization: (
      consts.operationalMinimumVaultSecuritization ?? client.consts.vaults.operationalMinimumVaultSecuritization
    ).toBigInt(),
    treasuryMinimumBitcoin: 0n,
    treasuryMinimumBonds: 0n,
    bitcoinLockSizeForReferral: legacyConsts.bitcoinLockSizeForReferral?.toBigInt() ?? 0n,
    miningSeatsPerReferral: legacyConsts.miningSeatsPerReferral?.toNumber() ?? 0,
    maxAvailableReferrals: legacyConsts.maxAvailableReferrals?.toNumber() ?? 0,
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

async function registerOperatorAccount(args: {
  walletKeys: WalletKeys;
  config: Config;
  feePayers: WalletType[];
  client?: ArgonClient;
}): Promise<boolean> {
  const client = args.client ?? (await getMainchainClient(false));
  const tx = await buildOperatorAccountRegistrationTx({
    walletKeys: args.walletKeys,
    config: args.config,
    client,
  });
  if (!tx) {
    return false;
  }

  const uniqueFeePayers = [...new Set(args.feePayers)];
  let txSigner: KeyringPair | undefined;

  for (const walletType of uniqueFeePayers) {
    const signer = await args.walletKeys.getWalletKeypair(walletType);
    const [account, fee] = await Promise.all([
      client.query.system.account(signer.address),
      tx.paymentInfo(signer.address),
    ]);

    if (account.data.free.toBigInt() >= fee.partialFee.toBigInt()) {
      txSigner = signer;
      break;
    }
  }

  if (!txSigner) {
    console.info('[OperationalAccount] Skipping startup registration repair; no funded fee payer found.', {
      feePayers: args.feePayers,
    });
    return false;
  }

  const txResult = await new TxSubmitter(client, tx, txSigner).submit({
    useLatestNonce: true,
  });
  await txResult.waitForInFirstBlock;

  return true;
}

export function getOperationalChainProgressFromAccount(
  accountRaw: Option<PalletOperationalAccountsOperationalAccount>,
  rewardConfig?: IOperationalRewardConfig,
): IOperationalChainProgress {
  const entry: IOperationalChainProgress = {
    hasVault: false,
    hasUniswapTransfer: false,
    hasTreasuryBondParticipation: false,
    hasFirstMiningSeat: false,
    hasSecondMiningSeat: false,
    hasBitcoinLock: false,
    bitcoinAccrual: 0n,
    miningSeatAccrual: 0,
    operationalReferralsCount: 0,
    referralPending: false,
    availableReferrals: 0,
    unactivatedReferrals: 0,
    rewardsEarnedCount: 0,
    rewardsEarnedAmount: 0n,
    rewardsCollectedAmount: 0n,
    isOperational: false,
    hasSponsor: false,
  };

  if (!accountRaw.isSome) return entry;

  const account = accountRaw.unwrap();
  const legacyAccount = account as LegacyPalletOperationalAccountsOperationalAccount;

  const operationalMinimumUniswapTransfer = rewardConfig?.operationalMinimumUniswapTransfer ?? 0n;
  const treasuryMinimumBitcoin = rewardConfig?.treasuryMinimumBitcoin ?? 0n;
  const treasuryMinimumBonds = rewardConfig?.treasuryMinimumBonds ?? 0n;

  const bitcoinAccrual =
    legacyAccount.bitcoinAccrual?.toBigInt() ?? account.vaultBitcoinAccrual?.toBigInt() ?? entry.bitcoinAccrual;
  const bitcoinAppliedTotal =
    legacyAccount.bitcoinAppliedTotal?.toBigInt() ?? account.vaultBitcoinAppliedTotal?.toBigInt() ?? 0n;
  const miningSeatAccrualValue = account.miningSeatAccrual?.toNumber() ?? entry.miningSeatAccrual;
  const miningSeatAppliedTotalValue = account.miningSeatAppliedTotal?.toNumber() ?? 0;
  const accountBitcoinAmountValue = account.accountBitcoinAmount?.toBigInt() ?? bitcoinAccrual + bitcoinAppliedTotal;
  const accountVaultBondAmountValue = account.accountVaultBondAmount?.toBigInt() ?? 0n;
  const uniswapArgonTransfersInAmountValue = account.uniswapArgonTransfersInAmount?.toBigInt() ?? 0n;

  return {
    hasVault: account.vaultCreated?.toPrimitive() ?? entry.hasVault,
    hasUniswapTransfer:
      legacyAccount.hasUniswapTransfer?.toPrimitive() ??
      (uniswapArgonTransfersInAmountValue > 0n &&
        uniswapArgonTransfersInAmountValue >= operationalMinimumUniswapTransfer),
    hasTreasuryBondParticipation:
      legacyAccount.hasTreasuryPoolParticipation?.toPrimitive() ??
      (accountVaultBondAmountValue > 0n && accountVaultBondAmountValue >= treasuryMinimumBonds),
    hasFirstMiningSeat: miningSeatAccrualValue + miningSeatAppliedTotalValue >= 1,
    hasSecondMiningSeat: miningSeatAccrualValue + miningSeatAppliedTotalValue >= 2,
    hasBitcoinLock:
      legacyAccount.bitcoinAccrual !== undefined || legacyAccount.bitcoinAppliedTotal !== undefined
        ? bitcoinAccrual + bitcoinAppliedTotal > 0n
        : accountBitcoinAmountValue > 0n && accountBitcoinAmountValue >= treasuryMinimumBitcoin,
    bitcoinAccrual,
    miningSeatAccrual: miningSeatAccrualValue,
    operationalReferralsCount: account.operationalReferralsCount?.toNumber() ?? entry.operationalReferralsCount,
    referralPending:
      legacyAccount.referralPending?.toPrimitive() ??
      account.upgradeCodePending?.toPrimitive() ??
      entry.referralPending,
    availableReferrals:
      legacyAccount.availableReferrals?.toNumber() ??
      account.availableUpgradeCodes?.toNumber() ??
      entry.availableReferrals,
    unactivatedReferrals: entry.unactivatedReferrals,
    rewardsEarnedCount: account.rewardsEarnedCount?.toNumber() ?? entry.rewardsEarnedCount,
    rewardsEarnedAmount: account.rewardsEarnedAmount?.toBigInt() ?? entry.rewardsEarnedAmount,
    rewardsCollectedAmount: account.rewardsCollectedAmount?.toBigInt() ?? entry.rewardsCollectedAmount,
    isOperational:
      legacyAccount.isOperational?.toPrimitive() ??
      account.isOperationallyCertified?.toPrimitive() ??
      entry.isOperational,
    hasSponsor: legacyAccount.sponsor?.isSome ?? account.referrer?.isSome ?? entry.hasSponsor,
  };
}

async function getTreasuryReserveBalance(client: ArgonClient): Promise<bigint | undefined> {
  const treasuryReservesAccount = client.consts.treasury.treasuryReservesAccount;
  if (!treasuryReservesAccount) return;

  const account = await client.query.system.account(treasuryReservesAccount.toString());
  return account.data.free.toBigInt();
}

function getReferralClaimPayloadHash(inviteCode: string, accountId: string): Uint8Array {
  // The runtime signs fixed byte arrays here, so these are raw SCALE bytes, not length-prefixed Bytes.
  const payload = getOfflineRegistry()
    .createType('(Raw,Raw,AccountId)', [u8aToHex(stringToU8a(REFERRAL_CLAIM_PROOF_MESSAGE_KEY)), inviteCode, accountId])
    .toU8a();

  return blake2AsU8a(payload, 256);
}

function getReferralSponsorGrantPayloadHash(sponsor: string, inviteCode: string, expiresAtFrame: number): Uint8Array {
  const payload = getOfflineRegistry()
    .createType('(Raw,AccountId,Raw,u64)', [
      u8aToHex(stringToU8a(REFERRAL_SPONSOR_GRANT_MESSAGE_KEY)),
      sponsor,
      inviteCode,
      expiresAtFrame,
    ])
    .toU8a();

  return blake2AsU8a(payload, 256);
}
