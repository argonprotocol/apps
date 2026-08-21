import {
  ArgonClient,
  getOfflineRegistry,
  type KeyringPair,
  type Option,
  type PalletOperationalAccountsOperationalAccount,
  type SubmittableExtrinsic,
  u8aToHex,
  type Vault,
} from '@argonprotocol/mainchain';
import {
  createDeferred,
  getCertificationProgressFromOperationalAccount,
  getCertificationThresholds,
  getVaultByOperator,
  type IOperationalAccessProof,
  MICROGONS_PER_ARGON,
  type RuntimeSpec157,
} from '@argonprotocol/apps-core';
import { stringToU8a } from '@polkadot/util';
import { blake2AsU8a, signatureVerify } from '@polkadot/util-crypto';
import { getMainchainClient } from '../stores/mainchain.ts';
import { ExtrinsicType } from './db/TransactionsTable.ts';
import { type TransactionInfo } from './TransactionInfo.ts';
import { TransactionTracker, TxAttemptState } from './TransactionTracker.ts';
import { WalletKeys } from './WalletKeys.ts';
import { OnboardingSetupStatus } from '../interfaces/IConfig.ts';
import { MyVault } from './MyVault.ts';
import { isValidOperatorName, OPERATOR_NAME_REQUIREMENTS } from './Utils.ts';

export { isValidOperatorName } from './Utils.ts';

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

export type IOperationalAccountSetup = {
  operatorName: string;
  vaultDelegateIsReady: boolean;
};

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
  waitForConfirmations?: number;
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
  if (!('minimumBitcoin' in client.consts.operationalAccounts)) return;

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

  const latestRegistrationAttempt = await args.transactionTracker.findLatestTxAttempt({
    extrinsicType: ExtrinsicType.OperationalRegister,
    waitForConfirmations: args.waitForConfirmations ?? 2,
  });
  if (latestRegistrationAttempt?.txAttemptState === TxAttemptState.Pending) {
    return latestRegistrationAttempt.txInfo;
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

export function getOperationalProfileName(accountRaw: Option<PalletOperationalAccountsOperationalAccount>): string {
  if (!accountRaw.isSome) return '';

  const name = accountRaw.unwrap().name;
  return name.isSome ? name.unwrap().toUtf8().trim() : '';
}

export function getOnboardingSetupStatus(args: {
  hasOnboardingHistory: boolean;
  hasMiningSeats: boolean;
  hasVault: boolean;
  isServerInstalled: boolean;
  operatorName: string;
}): OnboardingSetupStatus {
  if (!args.hasOnboardingHistory) return OnboardingSetupStatus.None;

  const hasRequiredOperation = args.hasVault || args.hasMiningSeats;
  if (args.isServerInstalled && isValidOperatorName(args.operatorName) && hasRequiredOperation) {
    return OnboardingSetupStatus.Finished;
  }

  return OnboardingSetupStatus.Checklist;
}

export function canRequestOperationsUpgrade(args: {
  hasLoadedInitialOperationalProgress: boolean;
  hasExtensionTreasury: boolean;
  hasCompletedTreasuryCertification: boolean;
  isUpgradedToOperations: boolean;
}): boolean {
  return (
    args.hasLoadedInitialOperationalProgress &&
    args.hasExtensionTreasury &&
    args.hasCompletedTreasuryCertification &&
    !args.isUpgradedToOperations
  );
}

export async function setOperationalProfileName(args: {
  transactionTracker: TransactionTracker;
  walletKeys: WalletKeys;
  name: string;
  client?: ArgonClient;
}): Promise<TransactionInfo | undefined> {
  const name = args.name.trim();
  if (!isValidOperatorName(name)) {
    throw new Error(OPERATOR_NAME_REQUIREMENTS);
  }

  const client = args.client ?? (await getMainchainClient(false));
  await args.transactionTracker.load();
  const currentName = getOperationalProfileName(await loadOperationalAccount(args.walletKeys, client));
  if (currentName === name) return;

  const pendingAttempt = await args.transactionTracker.findLatestTxAttempt<{ operatorName?: string }>({
    extrinsicType: ExtrinsicType.OperationalSetProfileName,
    waitForConfirmations: 2,
    matches: candidate => candidate.tx.metadataJson.operatorName === name,
  });
  if (pendingAttempt?.txAttemptState === TxAttemptState.Pending) {
    return pendingAttempt.txInfo;
  }

  const tx = client.tx.operationalAccounts.setName(name);
  const txSigner = await args.walletKeys.getVaultingKeypair();
  return await args.transactionTracker.submitAndWatch({
    tx,
    txSigner,
    useLatestNonce: true,
    extrinsicType: ExtrinsicType.OperationalSetProfileName,
    metadata: { operatorName: name },
  });
}

export async function activateOperationalAccountSetup(args: {
  client: ArgonClient;
  myVault: MyVault;
  transactionTracker: TransactionTracker;
  walletKeys: WalletKeys;
  operatorName: string;
  onTransaction?: (transaction?: TransactionInfo) => Promise<void>;
}): Promise<IOperationalAccountSetup> {
  await Promise.all([args.myVault.load(), args.transactionTracker.load()]);

  const createdVault = args.myVault.createdVault;
  const hasVault = !!createdVault;
  const operationalAccount = await loadOperationalAccount(args.walletKeys, args.client);
  const currentOperatorName = getOperationalProfileName(operationalAccount);

  let operatorName = args.operatorName.trim();
  if (!operatorName) {
    operatorName = currentOperatorName;
    const setupAttempt = await args.transactionTracker.findLatestTxAttempt<{ operatorName?: string }>({
      extrinsicType: ExtrinsicType.OperationalSetProfileName,
      waitForConfirmations: 2,
    });
    if (!operatorName && setupAttempt && setupAttempt.txAttemptState !== TxAttemptState.Replace) {
      operatorName = setupAttempt.txInfo.tx.metadataJson.operatorName?.trim() ?? '';
    }
  }

  if (!isValidOperatorName(operatorName)) {
    throw new Error(OPERATOR_NAME_REQUIREMENTS);
  }

  let transaction: TransactionInfo | undefined;
  if (createdVault) {
    transaction = await args.myVault.setupVaultInviteProfile({
      operatorName,
      currentOperatorName,
    });
  } else {
    transaction = await setOperationalProfileName({
      transactionTracker: args.transactionTracker,
      walletKeys: args.walletKeys,
      name: operatorName,
      client: args.client,
    });
  }

  if (args.onTransaction) {
    await args.onTransaction(transaction);
  } else {
    await transaction?.waitForPostProcessing;
  }
  if (hasVault) {
    await args.myVault.load(true);
  }

  let vault = args.myVault.createdVault ?? undefined;
  if (hasVault) {
    const finalizedVault = await getVaultByOperator({
      client: args.client,
      operatorAddress: args.walletKeys.vaultingAddress,
    }).catch(() => undefined);
    vault = finalizedVault ?? vault;
  }

  let setup = await loadOperationalAccountSetup({
    client: args.client,
    walletKeys: args.walletKeys,
    vault,
  });

  if (hasVault && !setup.vaultDelegateIsReady) {
    const delegateTransaction = await args.myVault.ensureVaultDelegateReady();
    if (args.onTransaction) {
      await args.onTransaction(delegateTransaction);
    } else {
      await delegateTransaction?.waitForPostProcessing;
    }

    await args.myVault.load(true);
    const finalizedVault = await getVaultByOperator({
      client: args.client,
      operatorAddress: args.walletKeys.vaultingAddress,
    }).catch(() => undefined);
    vault = finalizedVault ?? args.myVault.createdVault ?? undefined;
    setup = await loadOperationalAccountSetup({
      client: args.client,
      walletKeys: args.walletKeys,
      vault,
    });
  }

  if (setup.operatorName !== operatorName || !setup.vaultDelegateIsReady) {
    throw new Error('Member onboarding did not finish activating.');
  }

  return setup;
}

export async function loadOperationalAccountSetup(args: {
  client: ArgonClient;
  walletKeys: WalletKeys;
  vault?: Vault;
}): Promise<IOperationalAccountSetup> {
  const operatorName = getOperationalProfileName(await loadOperationalAccount(args.walletKeys, args.client));

  let vaultDelegateIsReady = true;
  if (args.vault) {
    const delegateAddress = await args.walletKeys.getVaultDelegateKeypair().then(keypair => keypair.address);
    vaultDelegateIsReady = await MyVault.isVaultDelegateReady(args.client, args.vault, delegateAddress);
  }

  return {
    operatorName,
    vaultDelegateIsReady,
  };
}

export async function getOperationalRewardConfig(client?: ArgonClient): Promise<IOperationalRewardConfig> {
  // Reward config and thresholds are chain-wide, and the archive client is more reliable than a
  // server-backed pruned client during startup or after runtime upgrades.
  client ??= await getMainchainClient(true);
  const consts = client.consts.operationalAccounts;
  const rewards = await client.query.operationalAccounts.rewards?.();
  const certificationThresholds = getCertificationThresholds(client);

  return {
    operationalActivationReward:
      rewards?.operationalCertificationReward?.toBigInt() ?? consts.operationalCertificationReward.toBigInt(),
    operationalReferralBonusReward:
      rewards?.operationalCertificationBonusReward?.toBigInt() ?? consts.operationalCertificationBonusReward.toBigInt(),
    operationalReferralsPerBonusReward: consts.operationalCertificationsPerBonusReward.toNumber(),
    operationalMinimumUniswapTransfer: consts.operationalMinimumUniswapTransfer.toBigInt(),
    operationalMinimumVaultLockTicks: client.consts.vaults.operationalMinimumVaultLockTicks.toBigInt(),
    operationalMinimumVaultSecuritization: consts.operationalMinimumVaultSecuritization.toBigInt(),
    miningSeatsForOperational: consts.miningSeatsForOperational.toNumber(),
    treasuryMinimumBitcoin: certificationThresholds.treasuryMinimumBitcoin,
    treasuryMinimumBonds: certificationThresholds.treasuryMinimumBonds,
    treasuryMinimumUniswapTransfer: certificationThresholds.treasuryMinimumUniswapTransfer,
    bitcoinLockSizeForUpgradeCode: consts.bitcoinLockSizeForAccessCode.toBigInt(),
    miningSeatsPerUpgradeCode: consts.miningSeatsPerAccessCode.toNumber(),
    maxAvailableUpgradeCodes: consts.maxAvailableAccessCodes.toNumber(),
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
  const currentOrPreviousAccount = account as
    | PalletOperationalAccountsOperationalAccount
    | RuntimeSpec157.PalletOperationalAccountsOperationalAccount;
  const certificationProgress = getCertificationProgressFromOperationalAccount(accountRaw, rewardConfig);

  const operationalMinimumUniswapTransfer = rewardConfig?.operationalMinimumUniswapTransfer ?? 0n;

  const bitcoinAccrual = account.vaultBitcoinAccrual.toBigInt();
  const miningSeatAccrualValue = account.miningSeatAccrual.toNumber();
  const uniswapArgonTransfersInAmountValue = account.uniswapArgonTransfersInAmount.toBigInt();
  let accessCodePending = entry.accessCodePending;
  if ('accessCodePending' in currentOrPreviousAccount) {
    accessCodePending = currentOrPreviousAccount.accessCodePending.toPrimitive();
  }

  return {
    hasOperationalAccount: certificationProgress.hasOperationalAccount,
    hasVault: account.vaultCreated.toPrimitive(),
    hasUniswapTransfer: uniswapArgonTransfersInAmountValue >= operationalMinimumUniswapTransfer,
    hasTreasuryUniswapTransfer: certificationProgress.hasTreasuryUniswapTransfer,
    hasTreasuryBondParticipation: certificationProgress.hasTreasuryBonds,
    hasFirstMiningSeat: miningSeatAccrualValue + account.miningSeatAppliedTotal.toNumber() >= 1,
    hasSecondMiningSeat: miningSeatAccrualValue + account.miningSeatAppliedTotal.toNumber() >= 2,
    hasBitcoinLock: certificationProgress.hasTreasuryBitcoin,
    bitcoinAccrual,
    miningSeatAccrual: miningSeatAccrualValue,
    operationalCertificationsCount: account.operationalCertificationsCount.toNumber(),
    accessCodePending,
    availableAccessCodes: account.availableAccessCodes.toNumber(),
    unactivatedAccessCodes: entry.unactivatedAccessCodes,
    rewardsEarnedCount: account.rewardsEarnedCount.toNumber(),
    rewardsEarnedAmount: account.rewardsEarnedAmount.toBigInt(),
    rewardsCollectedAmount: account.rewardsCollectedAmount.toBigInt(),
    isUpgradedToOperations: certificationProgress.isUpgradedToOperations,
    isOperational: certificationProgress.isOperationallyCertified,
    hasUpstreamAccount: account.upstreamAccount.isSome,
  };
}

async function getTreasuryReserveBalance(client: ArgonClient): Promise<bigint | undefined> {
  const treasuryReservesAccount = client.consts.treasury.treasuryReservesAccount;
  if (!treasuryReservesAccount) return;

  const account = await client.query.system.account(treasuryReservesAccount.toString());
  return account.data.free.toBigInt();
}
