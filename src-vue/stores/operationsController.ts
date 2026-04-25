import * as Vue from 'vue';
import { defineStore } from 'pinia';
import type { IOperationalUserInvite } from '@argonprotocol/apps-router';
import basicEmitter from '../emitters/basicEmitter';
import { type Config, getConfig } from './config';
import { getWalletKeys } from './wallets.ts';
import { getDbPromise } from './helpers/dbPromise';
import { createDeferred, MICROGONS_PER_ARGON } from '@argonprotocol/apps-core';
import handleFatalError from './helpers/handleFatalError';
import Importer from '../lib/Importer';
import {
  getOperationalRewardConfig,
  type IOperationalChainProgress,
  type IOperationalRewardConfig,
  subscribeOperationalAccount,
} from '../lib/OperationalAccount.ts';
import { getBitcoinLocks } from './bitcoin.ts';
import { getServerApiClient } from './server.ts';
import { getTransactionTracker } from './transactions.ts';
import BootstrapToNode from '../app-operations/overlays/operational/BootstrapToNode.vue';
import BackupMnemonic from '../app-operations/overlays/operational/BackupMnemonic.vue';
import ActivateVault from '../app-operations/overlays/operational/ActivateVault.vue';
import LiquidLock from '../app-operations/overlays/operational/LiquidLock.vue';
import AcquireBonds from '../app-operations/overlays/operational/AcquireBonds.vue';
import WinMiningSeats from '../app-operations/overlays/operational/WinMiningSeats.vue';
import WinMoreMiningSeats from '../app-operations/overlays/operational/WinMoreMiningSeats.vue';
import { VaultingSetupStatus } from '../interfaces/IConfig.ts';
import { ExtrinsicType, TransactionStatus } from '../lib/db/TransactionsTable.ts';

export enum OperationsTab {
  Home = 'Home',
  Mining = 'Mining',
  Vaulting = 'Vaulting',
}

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

export const useOperationsController = defineStore('operationsController', () => {
  const defaultRewardAmount = 500n * BigInt(MICROGONS_PER_ARGON);
  const defaultBonusRewardAmount = 5_000n * BigInt(MICROGONS_PER_ARGON);

  const isLoaded = Vue.ref(false);
  const { promise: isLoadedPromise, resolve: isLoadedResolve, reject: isLoadedReject } = createDeferred<void>();

  const dbPromise = getDbPromise();
  const config = getConfig();
  const bitcoinLocks = getBitcoinLocks();
  const transactionTracker = getTransactionTracker();
  const walletKeys = getWalletKeys();
  const selectedTab = Vue.ref<OperationsTab>(OperationsTab.Home);

  const activeGuideId = Vue.ref<OperationalStepId | null>(null);

  const isImporting = Vue.ref(false);
  const stopSuggestingBotTour = Vue.ref(true);
  const stopSuggestingVaultTour = Vue.ref(true);

  const backButtonTriggersHome = Vue.ref(false);
  const chainProgress = Vue.ref<IOperationalChainProgress>({
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
  });
  const rewardConfig = Vue.ref<IOperationalRewardConfig>({
    operationalReferralReward: defaultRewardAmount,
    referralBonusReward: defaultBonusRewardAmount,
    referralBonusEveryXOperationalSponsees: 5,
    bitcoinLockSizeForReferral: 5_000n * BigInt(MICROGONS_PER_ARGON),
    miningSeatsPerReferral: 5,
    maxAvailableReferrals: 3,
  });
  const completionNoticeQueue = Vue.ref<OperationalStepId[]>([]);
  const operationalInvites = Vue.ref<IOperationalUserInvite[]>([]);

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

  const completedCertificationStepCount = Vue.computed(() => {
    return operationalStepIds.filter(stepId => isCertificationStepComplete(stepId)).length;
  });
  const isFullyOperational = Vue.computed(() => {
    return completedCertificationStepCount.value === certificationStepCount || chainProgress.value.isOperational;
  });

  const pendingCompletionNoticeStepId = Vue.computed(() => {
    return completionNoticeQueue.value[0] ?? null;
  });
  const inviteSlotProgress = Vue.computed<IOperationalChainProgress>(() => {
    const unactivatedReferrals = operationalInvites.value.filter(invite => !invite.lastClickedAt).length;

    return {
      ...chainProgress.value,
      unactivatedReferrals,
    };
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
      return chainProgress.value.hasVault;
    }
    if (stepId === OperationalStepId.LiquidLock) {
      return chainProgress.value.hasBitcoinLock;
    }
    if (stepId === OperationalStepId.AcquireBonds) {
      return chainProgress.value.hasTreasuryBondParticipation;
    }
    if (stepId === OperationalStepId.FirstMiningSeat) {
      return chainProgress.value.hasFirstMiningSeat;
    }
    if (stepId === OperationalStepId.MoreMiningSeats) {
      return chainProgress.value.hasSecondMiningSeat;
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

  function setTab(tab: OperationsTab) {
    if (selectedTab.value === tab) return;

    basicEmitter.emit('closeAllOverlays');
    selectedTab.value = tab;
  }

  async function load() {
    await config.isLoadedPromise;
    if (operationalAccountUnsubscribe) return;
    rewardConfig.value = await getOperationalRewardConfig();

    await Promise.all([
      subscribeOperationalAccount(walletKeys, x => {
        chainProgress.value = x;
      })
        .then(unsub => {
          operationalAccountUnsubscribe = unsub;
        })
        .catch(error => {
          console.error('[Operations Controller] Unable to subscribe to operational progress.', error);
        }),
      bitcoinLocks.load().catch(error => {
        console.error('[Operations Controller] Unable to load bitcoin lock progress.', error);
      }),
    ]);

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
    await importer.importFromMnemonic(mnemonic);
    isImporting.value = false;
  }

  async function loadOperationalInvites() {
    if (!config.serverDetails.ipAddress) {
      operationalInvites.value = [];
      return [];
    }

    const invites = await getServerApiClient().getOperationalInvites();
    operationalInvites.value = invites;
    return invites;
  }

  function setOperationalInvites(invites: IOperationalUserInvite[]) {
    operationalInvites.value = invites;
  }

  function dismissCompletionNotice() {
    completionNoticeQueue.value = completionNoticeQueue.value.slice(1);
  }

  function clearCompletionNotices() {
    completionNoticeQueue.value = [];
  }

  load().catch(handleFatalError.bind('useOperationsController'));

  return {
    selectedTab,
    isLoaded,
    isLoadedPromise,
    isImporting,
    stopSuggestingBotTour,
    stopSuggestingVaultTour,
    backButtonTriggersHome,
    activeGuideId,
    certificationStepCount,
    completedCertificationStepCount,
    chainProgress,
    rewardConfig,
    inviteSlotProgress,
    pendingRewardsAmount,
    operationalInvites,
    isFullyOperational,
    pendingCompletionNoticeStepId,
    importFromMnemonic,
    dismissCompletionNotice,
    clearCompletionNotices,
    loadOperationalInvites,
    setOperationalInvites,
    setScreenKey: setTab,
    isCertificationStepComplete: isCertificationStepComplete,
    isCertificationStepUnderway,
    getCertificationStepStatus,
    getCertificationStepStatusLabel,
    getCertificationBlocker: getCertificationBlocker,
    isCertificationStepUnlocked,
  };
});
