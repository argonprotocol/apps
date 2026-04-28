import {
  ArgonClient,
  type bool,
  type Compact,
  getOfflineRegistry,
  hexToU8a,
  Keyring,
  type KeyringPair,
  type Option,
  type PalletOperationalAccountsOperationalAccount,
  type SubmittableExtrinsic,
  type u128,
  type u32,
  u8aToHex,
} from '@argonprotocol/mainchain';
import { createDeferred, MICROGONS_PER_ARGON } from '@argonprotocol/apps-core';
import { stringToU8a } from '@polkadot/util';
import { blake2AsU8a, signatureVerify } from '@polkadot/util-crypto';
import { Config } from '../stores/config.ts';
import type { IOperationalReferral } from '../interfaces/IConfig.ts';
import { getMainchainClient } from '../stores/mainchain.ts';
import { WalletKeys } from './WalletKeys.ts';

const OPERATIONAL_ACCOUNT_PROOF_MESSAGE_KEY = 'operational_primary_account';
const VAULT_ACCOUNT_PROOF_MESSAGE_KEY = 'operational_vault_account';
const MINING_FUNDING_ACCOUNT_PROOF_MESSAGE_KEY = 'operational_mining_funding';
const MINING_BOT_ACCOUNT_PROOF_MESSAGE_KEY = 'operational_mining_bot';
const REFERRAL_CLAIM_PROOF_MESSAGE_KEY = 'referral_claim';
const REFERRAL_SPONSOR_GRANT_MESSAGE_KEY = 'referral_sponsor_grant';
const OPERATIONAL_REWARDS_UPGRADE_ERROR = 'Reward claims cannot be submitted until the next Argon upgrade is active.';

export type IOperationalRewardConfig = {
  operationalReferralReward: bigint;
  referralBonusReward: bigint;
  referralBonusEveryXOperationalSponsees: number;
  operationalMinimumVaultLockTicks: bigint;
  operationalMinimumVaultSecuritization: bigint;
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
};

export type IOperationalRewardsClaimAvailability = {
  canClaimRewards: boolean;
  pendingRewards: bigint;
  treasuryReserves?: bigint;
  claimableNow: bigint;
  minimumClaimAmount: bigint;
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

function createConfiguredReferralProof(upstreamOperator: Config['upstreamOperator'], operationalAddr: string) {
  if (!upstreamOperator?.inviteSecret || !upstreamOperator.operationalReferral) {
    return null;
  }

  return createReferralProof({
    inviteSecret: upstreamOperator.inviteSecret,
    accountId: operationalAddr,
    operationalReferral: upstreamOperator.operationalReferral,
  });
}

export async function buildOperatorAccountRegistrationTx(args: {
  walletKeys: WalletKeys;
  config: Config;
  client?: ArgonClient;
}): Promise<SubmittableExtrinsic | undefined> {
  const { config, walletKeys } = args;
  const client = args.client ?? (await getMainchainClient(false));
  const existing = await client.query.operationalAccounts.operationalAccounts(walletKeys.operationalAddress);
  if (!existing.isEmpty) return;

  const upstreamOperator = config.upstreamOperator;

  const [operationalAccount, operationalEncryptionKey, vaultingAccount, miningHoldAccount, miningBotAccount] =
    await Promise.all([
      walletKeys.getOperationalKeypair(),
      walletKeys.getOperationalEncryptionKeypair(),
      walletKeys.getVaultingKeypair(),
      walletKeys.getMiningHoldKeypair(),
      walletKeys.getMiningBotKeypair(),
    ]);
  const operationalAddr = operationalAccount.address;
  const vaultingAddr = vaultingAccount.address;
  const miningHoldAddr = miningHoldAccount.address;
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
  const miningFundingAccountProof = createOwnershipProof(
    miningHoldAccount,
    operationalAddr,
    miningHoldAddr,
    MINING_FUNDING_ACCOUNT_PROOF_MESSAGE_KEY,
  );
  const miningBotAccountProof = createOwnershipProof(
    miningBotAccount,
    operationalAddr,
    miningBotAddr,
    MINING_BOT_ACCOUNT_PROOF_MESSAGE_KEY,
  );

  return client.tx.operationalAccounts.register({
    V1: {
      operationalAccount: operationalAddr,
      encryptionPubkey: operationalEncryptionKey,
      operationalAccountProof: { signature: operationalAccountProof.signature },
      vaultAccount: vaultingAddr,
      miningFundingAccount: miningHoldAddr,
      miningBotAccount: miningBotAddr,
      vaultAccountProof: { signature: vaultAccountProof.signature },
      miningFundingAccountProof: { signature: miningFundingAccountProof.signature },
      miningBotAccountProof: { signature: miningBotAccountProof.signature },
      referralProof: createConfiguredReferralProof(upstreamOperator, operationalAddr),
    },
  });
}

export async function getOperationalRewardConfig(client?: ArgonClient): Promise<IOperationalRewardConfig> {
  client ??= await getMainchainClient(false);
  const consts = client.consts.operationalAccounts as typeof client.consts.operationalAccounts &
    V146OperationalAccountConsts;

  return {
    operationalReferralReward: consts.operationalReferralReward.toBigInt(),
    referralBonusReward: consts.operationalReferralBonusReward.toBigInt(),
    referralBonusEveryXOperationalSponsees: consts.referralBonusEveryXOperationalSponsees.toNumber(),
    operationalMinimumVaultLockTicks: client.consts.vaults.operationalMinimumVaultLockTicks.toBigInt(),
    operationalMinimumVaultSecuritization: (
      consts.operationalMinimumVaultSecuritization ?? client.consts.vaults.operationalMinimumVaultSecuritization
    ).toBigInt(),
    bitcoinLockSizeForReferral: (consts.bitcoinLockSizeForReferral ?? consts.bitcoinLockSizeForAccessCode).toBigInt(),
    miningSeatsPerReferral: (consts.miningSeatsPerReferral ?? consts.miningSeatsPerAccessCode).toNumber(),
    maxAvailableReferrals: (consts.maxAvailableReferrals ?? consts.maxUnactivatedAccessCodes).toNumber(),
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

  const accountRaw = await client.query.operationalAccounts.operationalAccounts(walletKeys.operationalAddress);
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
  client?: ArgonClient,
) {
  client ??= await getMainchainClient(false);
  const deferred = createDeferred<void>();
  const unsubscribe = await client.query.operationalAccounts.operationalAccounts(
    walletKeys.operationalAddress,
    accountRaw => {
      onUpdate(getOperationalChainProgressFromAccount(accountRaw));

      if (!deferred.isResolved) {
        deferred.resolve();
      }
    },
  );

  await deferred.promise;
  return unsubscribe;
}

export function getOperationalChainProgressFromAccount(
  accountRaw: Option<PalletOperationalAccountsOperationalAccount>,
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
  };

  if (!accountRaw.isSome) return entry;

  const account = accountRaw.unwrap();
  const bitcoinAccrual = account.bitcoinAccrual.toBigInt();
  const bitcoinAppliedTotal = account.bitcoinAppliedTotal.toBigInt();
  const miningSeatAccrual = account.miningSeatAccrual.toBigInt();
  const miningSeatAppliedTotal = account.miningSeatAppliedTotal.toBigInt();
  const referralAccount = account as typeof account & V146OperationalAccount;

  return {
    hasVault: account.vaultCreated.toPrimitive(),
    hasUniswapTransfer: account.hasUniswapTransfer.toPrimitive(),
    hasTreasuryBondParticipation: account.hasTreasuryPoolParticipation.toPrimitive(),
    hasFirstMiningSeat: miningSeatAccrual + miningSeatAppliedTotal >= 1n,
    hasSecondMiningSeat: miningSeatAccrual + miningSeatAppliedTotal >= 2n,
    hasBitcoinLock: bitcoinAccrual + bitcoinAppliedTotal > 0n,
    bitcoinAccrual,
    miningSeatAccrual: account.miningSeatAccrual.toNumber(),
    operationalReferralsCount: account.operationalReferralsCount.toNumber(),
    referralPending: (referralAccount.referralPending ?? referralAccount.referralAccessCodePending).toPrimitive(),
    availableReferrals: (referralAccount.availableReferrals ?? referralAccount.issuableAccessCodes).toNumber(),
    unactivatedReferrals: referralAccount.unactivatedAccessCodes?.toNumber() ?? 0,
    rewardsEarnedCount: account.rewardsEarnedCount.toNumber(),
    rewardsEarnedAmount: account.rewardsEarnedAmount.toBigInt(),
    rewardsCollectedAmount: account.rewardsCollectedAmount.toBigInt(),
    isOperational: account.isOperational.toPrimitive(),
  };
}

async function getTreasuryReserveBalance(client: ArgonClient): Promise<bigint | undefined> {
  const treasuryReservesAccount = client.consts.treasury.treasuryReservesAccount;
  if (!treasuryReservesAccount) return;

  const account = await client.query.system.account(treasuryReservesAccount.toString());
  return account.data.free.toBigInt();
}

type V146OperationalAccountConsts = {
  bitcoinLockSizeForAccessCode: u128;
  miningSeatsPerAccessCode: u32;
  maxUnactivatedAccessCodes: u32;
  operationalMinimumVaultSecuritization?: u128;
};

type V146OperationalAccount = {
  referralAccessCodePending: bool;
  issuableAccessCodes: Compact<u32>;
  unactivatedAccessCodes?: Compact<u32>;
};

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
