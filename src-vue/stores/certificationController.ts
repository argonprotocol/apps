import * as Vue from 'vue';
import { defineStore } from 'pinia';
import type { IMemberInvite } from '@argonprotocol/apps-router';
import basicEmitter from '../emitters/basicEmitter.ts';
import { type Config, getConfig } from './config.ts';
import { getWalletKeys, useWallets } from './wallets.ts';
import { getDbPromise } from './helpers/dbPromise.ts';
import {
  countCompletedTreasuryCertificationRequirements,
  createDeferred,
  MICROGONS_PER_ARGON,
  treasuryCertificationRequirementCount,
} from '@argonprotocol/apps-core';
import handleFatalError from './helpers/handleFatalError.ts';
import Importer from '../lib/Importer.ts';
import {
  ensureOperationalAccountRegistered,
  getOperationalRewardConfig,
  type IOperationalChainProgress,
  type IOperationalRewardConfig,
  subscribeOperationalAccount,
} from '../lib/OperationalAccount.ts';
import { getBitcoinLocks } from './bitcoin.ts';
import { getServerApiClient } from './server.ts';
import { getTransactionTracker } from './transactions.ts';
import { useMyBonds } from './myBonds.ts';
import { getStats } from './stats.ts';
import { getMyVault } from './vaults.ts';
import BootstrapToNode from '../overlays/operational/BootstrapToNode.vue';
import BackupMnemonic from '../overlays/operational/BackupMnemonic.vue';
import ActivateVault from '../overlays/operational/ActivateVault.vue';
import LiquidLock from '../overlays/operational/LiquidLock.vue';
import AcquireBonds from '../overlays/operational/AcquireBonds.vue';
import WinMiningSeats from '../overlays/operational/WinMiningSeats.vue';
import WinMoreMiningSeats from '../overlays/operational/WinMoreMiningSeats.vue';
import {
  IOperationsTabs,
  ITreasuryTabs,
  MiningSetupStatus,
  OperationsTabs,
  TopTab,
  TreasuryTabs,
  VaultingSetupStatus,
} from '../interfaces/IConfig.ts';
import { ExtrinsicType, TransactionStatus } from '../lib/db/TransactionsTable.ts';
import { BitcoinLockStatus } from '../interfaces/IBitcoinLockRecord.ts';

export enum OperationalStepId {
  BootstrapFromNode = 'BootstrapFromNode',
  BackupMnemonic = 'BackupMnemonic',
  ActivateVault = 'ActivateVault',
  LiquidLock = 'LiquidLock',
  AcquireBonds = 'AcquireBonds',
  FirstMiningSeat = 'FirstMiningSeat',
  MoreMiningSeats = 'MoreMiningSeats',
}

type IOperationalStep = {
  title: string;
  documentationLink: string;
  component: unknown;
  blockedByStepId?: OperationalStepId;
};

export const operationalSteps: Record<OperationalStepId, IOperationalStep> = {
  [OperationalStepId.BootstrapFromNode]: {
    title: 'Bootstrap from Existing Node',
    documentationLink: 'https://argon.network/docs/operator-certification/bootstrap-to-node',
    component: BootstrapToNode,
  },
  [OperationalStepId.BackupMnemonic]: {
    title: 'Create Your Mnemonic Backup',
    documentationLink: 'https://argon.network/docs/operator-certification/backup-mnemonic',
    component: BackupMnemonic,
  },
  [OperationalStepId.ActivateVault]: {
    title: 'Activate Stabilization Vault',
    documentationLink: 'https://argon.network/docs/operator-certification/activate-vault',
    component: ActivateVault,
  },
  [OperationalStepId.LiquidLock]: {
    title: 'Liquid Lock a Bitcoin',
    documentationLink: 'https://argon.network/docs/operator-certification/liquid-lock',
    component: LiquidLock,
    blockedByStepId: OperationalStepId.ActivateVault,
  },
  [OperationalStepId.AcquireBonds]: {
    title: 'Acquire Treasury Bonds',
    documentationLink: 'https://argon.network/docs/operator-certification/acquire-bonds',
    component: AcquireBonds,
    blockedByStepId: OperationalStepId.ActivateVault,
  },
  [OperationalStepId.FirstMiningSeat]: {
    title: 'Win a First Mining Seat',
    documentationLink: 'https://argon.network/docs/operator-certification/win-first-mining-seat',
    component: WinMiningSeats,
  },
  [OperationalStepId.MoreMiningSeats]: {
    title: 'Win a Second Mining Seat',
    documentationLink: 'https://argon.network/docs/operator-certification/win-more-mining-seats',
    component: WinMoreMiningSeats,
    blockedByStepId: OperationalStepId.FirstMiningSeat,
  },
};

const operationalStepIds = Object.keys(operationalSteps) as OperationalStepId[];

type IOperationalStepStatus = 'not_started' | 'underway' | 'complete';
export type IOperationalInviteStatusLabel =
  | 'Not opened'
  | 'Opened'
  | 'Registered'
  | 'Operationally certified'
  | 'Expired';
export type IOperationalInviteStatus = {
  label: IOperationalInviteStatusLabel;
  showRewardNote: boolean;
  completedTreasuryCertificationRequirements?: number;
  treasuryCertificationRequirementCount?: number;
};

export const useCertificationController = defineStore('certificationController', () => {
  const defaultRewardAmount = 500n * BigInt(MICROGONS_PER_ARGON);
  const defaultBonusRewardAmount = 5_000n * BigInt(MICROGONS_PER_ARGON);

  const isLoaded = Vue.ref(false);
  const { promise: isLoadedPromise, resolve: isLoadedResolve, reject: isLoadedReject } = createDeferred<void>();

  const dbPromise = getDbPromise();
  const config = getConfig();
  const bitcoinLocks = getBitcoinLocks();
  const myBonds = useMyBonds();
  const myVault = getMyVault();
  const stats = getStats();
  const transactionTracker = getTransactionTracker();
  const walletKeys = getWalletKeys();
  const wallets = useWallets();

  const selectedTab = Vue.ref<TopTab | null>(null);
  const selectedTreasuryTab = Vue.ref<ITreasuryTabs>(TopTab.Treasury);
  const selectedOperationsTab = Vue.ref<IOperationsTabs>(TopTab.Operations);

  const activeGuideId = Vue.ref<OperationalStepId | null>(null);

  const isImporting = Vue.ref(false);
  const stopSuggestingBotTour = Vue.ref(true);
  const stopSuggestingVaultTour = Vue.ref(true);

  const backButtonTriggersHome = Vue.ref(false);
  const chainProgress = Vue.ref<IOperationalChainProgress>({
    hasOperationalAccount: false,
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
  });
  const rewardConfig = Vue.ref<IOperationalRewardConfig>({
    operationalActivationReward: defaultRewardAmount,
    operationalReferralBonusReward: defaultBonusRewardAmount,
    operationalReferralsPerBonusReward: 5,
    operationalMinimumUniswapTransfer: 0n,
    operationalMinimumVaultLockTicks: 365n * 24n * 60n,
    operationalMinimumVaultSecuritization: 1_000n * BigInt(MICROGONS_PER_ARGON),
    miningSeatsForOperational: 2,
    treasuryMinimumBitcoin: 0n,
    treasuryMinimumBonds: 0n,
    treasuryMinimumUniswapTransfer: 0n,
    bitcoinLockSizeForUpgradeCode: 5_000n * BigInt(MICROGONS_PER_ARGON),
    miningSeatsPerUpgradeCode: 5,
    maxAvailableUpgradeCodes: 3,
  });
  const completionNoticeQueue = Vue.ref<OperationalStepId[]>([]);
  const operationalInvites = Vue.ref<IMemberInvite[]>([]);
  const operationalInviteStatusesByCode = Vue.ref<Record<string, IOperationalInviteStatus>>({});

  const certificationStepCount = operationalStepIds.length;
  const hasBitcoinFundingSeenOnBitcoin = Vue.computed(() => {
    return Object.values(bitcoinLocks.data.locksByUtxoId).some(lock => {
      const fundingRecord =
        bitcoinLocks.getAcceptedFundingRecord(lock) ??
        lock.fundingUtxoRecord ??
        bitcoinLocks.utxoTracking.getPreferredFundingCandidateRecord(lock);

      return !!(fundingRecord?.mempoolObservation || fundingRecord?.firstSeenBitcoinHeight);
    });
  });

  const hasBondsUnderway = Vue.computed(() => {
    const latestVaultTreasuryAllocation = transactionTracker.findLatestTxInfo<{
      addedTreasuryMicrogons?: bigint;
    }>(txInfo => {
      return (
        txInfo.tx.extrinsicType === ExtrinsicType.VaultIncreaseAllocation &&
        (txInfo.tx.metadataJson?.addedTreasuryMicrogons ?? 0n) > 0n
      );
    });

    const latestTreasuryBondPurchase = transactionTracker.findLatestTxInfo<{
      bondPurchaseMicrogons?: bigint;
    }>(txInfo => {
      return (
        txInfo.tx.extrinsicType === ExtrinsicType.TreasuryBuyBonds &&
        (txInfo.tx.metadataJson?.bondPurchaseMicrogons ?? 0n) > 0n
      );
    });

    return [latestVaultTreasuryAllocation, latestTreasuryBondPurchase].some(txInfo => {
      if (!txInfo) return false;
      if (txInfo.tx.submissionErrorJson || txInfo.tx.blockExtrinsicErrorJson) return false;
      return txInfo.tx.status === TransactionStatus.Submitted || txInfo.tx.status === TransactionStatus.InBlock;
    });
  });

  const isVaultActivationUnderway = Vue.computed(() => {
    return (
      config.vaultingSetupStatus === VaultingSetupStatus.Installing ||
      config.vaultingSetupStatus === VaultingSetupStatus.Finished
    );
  });
  const hasCompletedOwnBitcoinLock = Vue.computed(() => {
    return Object.values(bitcoinLocks.data.locksByUtxoId).some(lock => {
      if (lock.lockDetails.ownerAccount !== walletKeys.defaultArgonAddress) return false;
      if (
        ![
          BitcoinLockStatus.LockedAndIsMinting,
          BitcoinLockStatus.LockedAndMinted,
          BitcoinLockStatus.Releasing,
          BitcoinLockStatus.Released,
        ].includes(lock.status)
      ) {
        return false;
      }
      return rewardConfig.value.treasuryMinimumBitcoin <= 0n
        ? true
        : lock.liquidityPromised >= rewardConfig.value.treasuryMinimumBitcoin;
    });
  });
  const certificationProgress = Vue.computed(() => {
    if (chainProgress.value.hasOperationalAccount) {
      return {
        hasVault: chainProgress.value.hasVault,
        hasTreasuryBondParticipation: chainProgress.value.hasTreasuryBondParticipation,
        hasFirstMiningSeat: chainProgress.value.hasFirstMiningSeat,
        hasSecondMiningSeat: chainProgress.value.hasSecondMiningSeat,
        hasBitcoinLock: chainProgress.value.hasBitcoinLock,
      };
    }

    const seatCount = stats.myMiningSeats.seatCount;
    const activeBondMicrogons = myBonds.bondTotals.activeBondMicrogons;

    return {
      hasVault: Boolean(myVault.createdVault),
      hasTreasuryBondParticipation:
        rewardConfig.value.treasuryMinimumBonds <= 0n
          ? activeBondMicrogons > 0n
          : activeBondMicrogons >= rewardConfig.value.treasuryMinimumBonds,
      hasFirstMiningSeat: seatCount >= 1,
      hasSecondMiningSeat: seatCount >= 2,
      hasBitcoinLock: hasCompletedOwnBitcoinLock.value,
    };
  });

  const completedCertificationStepCount = Vue.computed(() => {
    return operationalStepIds.filter(stepId => isCertificationStepComplete(stepId)).length;
  });
  const isCertificationChecklistComplete = Vue.computed(() => {
    return completedCertificationStepCount.value === certificationStepCount;
  });
  const isFullyOperational = Vue.computed(() => {
    return chainProgress.value.isOperational;
  });
  const isOperationalActivationReady = Vue.computed(() => {
    return (
      isCertificationChecklistComplete.value &&
      chainProgress.value.isUpgradedToOperations &&
      !chainProgress.value.isOperational
    );
  });
  const isOperationalRewardsFlowActive = Vue.computed(() => {
    return isFullyOperational.value || isOperationalActivationReady.value;
  });

  const pendingCompletionNoticeStepId = Vue.computed(() => {
    return completionNoticeQueue.value[0] ?? null;
  });
  const activeOperationalInvites = Vue.computed(() => {
    return operationalInvites.value.filter(isActiveOperationalInvite);
  });
  const activeOperationalInviteCount = Vue.computed(() => {
    return activeOperationalInvites.value.length;
  });
  const inviteSlotProgress = Vue.computed<IOperationalChainProgress>(() => {
    return {
      ...chainProgress.value,
      unactivatedUpgradeCodes: activeOperationalInviteCount.value,
    };
  });
  const dismissedCompletionNoticeStepIds = Vue.computed(() => {
    const stepIds = config.certificationDetails?.dismissedCompletionNoticeStepIds ?? [];
    return new Set(
      stepIds.filter(stepId => operationalStepIds.includes(stepId as OperationalStepId)) as OperationalStepId[],
    );
  });
  const pendingRewardsAmount = Vue.computed(() => {
    const pending = inviteSlotProgress.value.rewardsEarnedAmount - inviteSlotProgress.value.rewardsCollectedAmount;
    return pending > 0n ? pending : 0n;
  });

  let operationalAccountUnsubscribe: VoidFunction | undefined;
  let previousCompletionByStepId: Record<OperationalStepId, boolean> | undefined;

  function isCertificationStepComplete(stepId: OperationalStepId) {
    if (stepId === OperationalStepId.BootstrapFromNode) return true;

    if (stepId === OperationalStepId.BackupMnemonic) {
      return config.certificationDetails?.hasSavedMnemonic || false;
    }
    if (stepId === OperationalStepId.ActivateVault) {
      return certificationProgress.value.hasVault;
    }
    if (stepId === OperationalStepId.LiquidLock) {
      return certificationProgress.value.hasBitcoinLock;
    }
    if (stepId === OperationalStepId.AcquireBonds) {
      return certificationProgress.value.hasTreasuryBondParticipation;
    }
    if (stepId === OperationalStepId.FirstMiningSeat) {
      return certificationProgress.value.hasFirstMiningSeat;
    }
    if (stepId === OperationalStepId.MoreMiningSeats) {
      return certificationProgress.value.hasSecondMiningSeat;
    }
    return false;
  }

  function isCertificationStepUnderway(stepId: OperationalStepId) {
    if (isCertificationStepComplete(stepId)) return false;
    if ([OperationalStepId.FirstMiningSeat, OperationalStepId.MoreMiningSeats].includes(stepId)) return false;
    if (activeGuideId.value === stepId) return true;

    if (stepId === OperationalStepId.ActivateVault) {
      return isVaultActivationUnderway.value;
    }
    if (stepId === OperationalStepId.LiquidLock) {
      return hasBitcoinFundingSeenOnBitcoin.value;
    }
    if (stepId === OperationalStepId.AcquireBonds) {
      return hasBondsUnderway.value;
    }

    return false;
  }

  function getCertificationStepStatus(stepId: OperationalStepId): IOperationalStepStatus {
    if (isCertificationStepComplete(stepId)) return 'complete';
    if (isCertificationStepUnderway(stepId)) return 'underway';
    return 'not_started';
  }

  function getCertificationStepStatusLabel(stepId: OperationalStepId) {
    const status = getCertificationStepStatus(stepId);
    if (status === 'complete') return 'Completed';
    if (status === 'underway') return 'Underway';
    return 'Not completed';
  }

  function getCertificationBlocker(stepId: OperationalStepId) {
    const blockedByStepId = operationalSteps[stepId].blockedByStepId;
    if (!blockedByStepId || isCertificationStepComplete(blockedByStepId)) return null;

    return {
      id: blockedByStepId,
      ...operationalSteps[blockedByStepId],
    };
  }

  function isCertificationStepUnlocked(stepId: OperationalStepId) {
    return !getCertificationBlocker(stepId);
  }

  function setTab(tab: TopTab) {
    if (selectedTab.value === tab) return;

    basicEmitter.emit('closeAllOverlays');
    selectedTab.value = tab;
    config.selectedTab = tab;

    if (TreasuryTabs.includes(tab as ITreasuryTabs)) {
      selectedTreasuryTab.value = tab as ITreasuryTabs;
      config.selectedTreasuryTab = tab as ITreasuryTabs;
    } else if (OperationsTabs.includes(tab as IOperationsTabs)) {
      console.log('IS OPERATIONS TAB');
      selectedOperationsTab.value = tab as IOperationsTabs;
      config.selectedOperationsTab = tab as IOperationsTabs;
    }
    void config.save();
  }

  async function ensureOperationalRegistration() {
    await config.isLoadedPromise;

    if (!config.hasExtensionTreasury || !config.upstreamOperator?.accountId) {
      return;
    }

    await wallets.isLoadedPromise;

    const txInfo = await ensureOperationalAccountRegistered({
      transactionTracker,
      walletKeys,
      config: config as Config,
      availableMicrogons: wallets.defaultArgonWallet.availableMicrogons,
    });

    await txInfo?.txResult.waitForFinalizedBlock;
  }

  async function load() {
    await config.isLoadedPromise;
    selectedTab.value = config.selectedTab;
    selectedTreasuryTab.value = config.selectedTreasuryTab;
    selectedOperationsTab.value = config.selectedOperationsTab;

    if (operationalAccountUnsubscribe) return;
    rewardConfig.value = await getOperationalRewardConfig();

    void subscribeOperationalAccount(
      walletKeys,
      x => {
        chainProgress.value = x;

        if (x.isUpgradedToOperations && !config.hasExtensionOperations) {
          config.hasExtensionOperations = true;
          void config.save();
        }
      },
      rewardConfig.value,
    )
      .then(unsub => {
        operationalAccountUnsubscribe = unsub;
      })
      .catch(error => {
        console.error('[Certification Controller] Unable to subscribe to operational progress.', error);
      });

    void bitcoinLocks.load().catch(error => {
      console.error('[Certification Controller] Unable to load bitcoin lock progress.', error);
    });
    void myVault.load().catch(error => {
      console.error('[Certification Controller] Unable to load vault progress.', error);
    });
    void myBonds.load().catch(error => {
      console.error('[Certification Controller] Unable to load bond progress.', error);
    });

    // detect newly completed steps and queue completion notices
    Vue.watch(
      () => {
        return Object.fromEntries(
          operationalStepIds.map(stepId => [stepId, isCertificationStepComplete(stepId)]),
        ) as Record<OperationalStepId, boolean>;
      },
      nextCompletionByStepId => {
        if (!previousCompletionByStepId) {
          previousCompletionByStepId = nextCompletionByStepId;
          return;
        }

        const newlyCompletedStepIds = operationalStepIds.filter(stepId => {
          return !previousCompletionByStepId?.[stepId] && nextCompletionByStepId[stepId];
        });
        previousCompletionByStepId = nextCompletionByStepId;
        if (!newlyCompletedStepIds.length) return;

        for (const stepId of newlyCompletedStepIds) {
          if (dismissedCompletionNoticeStepIds.value.has(stepId)) continue;
          if (activeGuideId.value === stepId) {
            activeGuideId.value = null;
          }
          if (completionNoticeQueue.value.includes(stepId)) continue;
          completionNoticeQueue.value = [...completionNoticeQueue.value, stepId];
        }
      },
      { immediate: true },
    );

    isLoaded.value = true;
    isLoadedResolve();
  }

  async function importFromMnemonic(mnemonic: string) {
    isImporting.value = true;
    const importer = new Importer(config as Config, walletKeys, dbPromise);
    try {
      await importer.importFromMnemonic(mnemonic);
    } finally {
      isImporting.value = false;
    }
  }

  async function loadOperationalInvites() {
    if (!config.serverDetails.ipAddress) {
      operationalInvites.value = [];
      operationalInviteStatusesByCode.value = {};
      return [];
    }

    const invites = await getServerApiClient().getInvites();
    operationalInvites.value = invites;

    await refreshOperationalInviteStatuses(invites);

    return invites;
  }

  function setOperationalInvites(invites: IMemberInvite[]) {
    operationalInvites.value = invites;
    setOperationalInviteStatuses(invites);
  }

  async function refreshOperationalInviteStatuses(invites = operationalInvites.value) {
    setOperationalInviteStatuses(invites);
  }

  function setOperationalInviteStatuses(invites: IMemberInvite[]) {
    const previousStatusesByCode = operationalInviteStatusesByCode.value;

    operationalInviteStatusesByCode.value = Object.fromEntries(
      invites.map(invite => [
        invite.inviteCode,
        getOperationalInviteStatus(invite, previousStatusesByCode[invite.inviteCode]),
      ]),
    );
  }

  function getOperationalInviteStatus(
    invite: IMemberInvite,
    previousStatus?: IOperationalInviteStatus,
  ): IOperationalInviteStatus {
    if (invite.operationsUpgradedAt || previousStatus?.label === 'Operationally certified') {
      return {
        label: 'Operationally certified',
        showRewardNote: true,
      };
    }

    if (invite.defaultAccountId) {
      return {
        label: 'Registered',
        showRewardNote: false,
        completedTreasuryCertificationRequirements: invite.certificationProgress
          ? countCompletedTreasuryCertificationRequirements(invite.certificationProgress)
          : undefined,
        treasuryCertificationRequirementCount: invite.certificationProgress
          ? treasuryCertificationRequirementCount
          : undefined,
      };
    }

    if (invite.lastClickedAt) {
      return {
        label: 'Opened',
        showRewardNote: false,
      };
    }

    return {
      label: 'Not opened',
      showRewardNote: false,
    };
  }

  function isActiveOperationalInvite(invite: IMemberInvite) {
    const status = operationalInviteStatusesByCode.value[invite.inviteCode];
    return status?.label !== 'Operationally certified' && status?.label !== 'Expired';
  }

  function acknowledgeCompletionNoticeSteps(stepIds: OperationalStepId[]) {
    if (!stepIds.length) return;

    const savedStepIds = config.certificationDetails?.dismissedCompletionNoticeStepIds ?? [];
    const nextStepIds = [...new Set([...savedStepIds, ...stepIds])];
    if (nextStepIds.length === savedStepIds.length) return;

    config.setCertificationDetails({ dismissedCompletionNoticeStepIds: nextStepIds });
    void config.save();
  }

  function dismissCompletionNotice() {
    const [stepId] = completionNoticeQueue.value;
    if (stepId) {
      acknowledgeCompletionNoticeSteps([stepId]);
    }
    completionNoticeQueue.value = completionNoticeQueue.value.slice(1);
  }

  function clearCompletionNotices() {
    acknowledgeCompletionNoticeSteps(completionNoticeQueue.value);
    completionNoticeQueue.value = [];
  }

  load().catch(handleFatalError.bind('useCertificationController'));

  return {
    selectedTab,
    selectedTreasuryTab,
    selectedOperationsTab,
    isLoaded,
    isLoadedPromise,
    isImporting,
    stopSuggestingBotTour,
    stopSuggestingVaultTour,
    backButtonTriggersHome,
    activeGuideId,
    certificationStepCount,
    completedCertificationStepCount,
    isCertificationChecklistComplete,
    chainProgress,
    rewardConfig,
    inviteSlotProgress,
    pendingRewardsAmount,
    operationalInvites,
    operationalInviteStatusesByCode,
    activeOperationalInvites,
    activeOperationalInviteCount,
    isFullyOperational,
    isOperationalActivationReady,
    isOperationalRewardsFlowActive,
    pendingCompletionNoticeStepId,
    importFromMnemonic,
    dismissCompletionNotice,
    clearCompletionNotices,
    ensureOperationalRegistration,
    loadOperationalInvites,
    setOperationalInvites,
    refreshOperationalInviteStatuses,
    setTab,
    isCertificationStepComplete: isCertificationStepComplete,
    isCertificationStepUnderway,
    getCertificationStepStatus,
    getCertificationStepStatusLabel,
    getCertificationBlocker: getCertificationBlocker,
    isCertificationStepUnlocked,
  };
});
