import * as Vue from 'vue';
import { defineStore } from 'pinia';
import basicEmitter from '../emitters/basicEmitter';
import { getConfig, type Config } from './config';
import { getWalletKeys } from './wallets.ts';
import { getDbPromise } from './helpers/dbPromise';
import { createDeferred } from '@argonprotocol/apps-core';
import handleFatalError from './helpers/handleFatalError';
import Importer from '../lib/Importer';
import BootstrapToNode from '../overlays-operations/operational/BootstrapToNode.vue';
import BackupMnemonic from '../overlays-operations/operational/BackupMnemonic.vue';
import ActivateVault from '../overlays-operations/operational/ActivateVault.vue';
import LiquidLock from '../overlays-operations/operational/LiquidLock.vue';
import AcquireBonds from '../overlays-operations/operational/AcquireBonds.vue';
import WinMiningSeats from '../overlays-operations/operational/WinMiningSeats.vue';
import WinMoreMiningSeats from '../overlays-operations/operational/WinMoreMiningSeats.vue';
import { loadOperationalAccount } from '../lib/OperationalAccount.ts';

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

export const useOperationsController = defineStore('operationsController', () => {
  const isLoaded = Vue.ref(false);
  const { promise: isLoadedPromise, resolve: isLoadedResolve, reject: isLoadedReject } = createDeferred<void>();

  const dbPromise = getDbPromise();
  const config = getConfig();
  const walletKeys = getWalletKeys();
  const selectedTab = Vue.ref<OperationsTab>(OperationsTab.Home);

  const activeGuideId = Vue.ref<OperationalStepId | null>(null);

  const isImporting = Vue.ref(false);
  const stopSuggestingBotTour = Vue.ref(true);
  const stopSuggestingVaultTour = Vue.ref(true);
  const hideBonusTip = Vue.ref(false);

  const backButtonTriggersHome = Vue.ref(false);

  const overlayIsOpen = Vue.ref(false);

  function isCertificationStepComplete(stepId: OperationalStepId) {
    if (stepId === OperationalStepId.BootstrapFromNode) {
      return true;
    } else if (stepId === OperationalStepId.BackupMnemonic) {
      return config.certificationDetails?.hasSavedMnemonic || false;
    } else if (stepId === OperationalStepId.ActivateVault) {
      return config.certificationDetails?.hasVault || false;
    }
    return false;
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
    await loadOperationalAccount(config as Config);
    hideBonusTip.value = config.certificationDetails?.showOverviewTooltip === false;

    isLoaded.value = true;
    isLoadedResolve();
  }

  async function importFromFile(dataRaw: string) {
    isImporting.value = true;
    const importer = new Importer(config as Config, walletKeys, dbPromise);
    basicEmitter.emit('openImportingAccountOverlay', { importer, dataRaw });
  }

  async function importFromMnemonic(mnemonic: string) {
    isImporting.value = true;
    const importer = new Importer(config as Config, walletKeys, dbPromise);
    await importer.importFromMnemonic(mnemonic);
    isImporting.value = false;
  }

  load().catch(handleFatalError.bind('useOperationsController'));

  return {
    selectedTab,
    isLoaded,
    isLoadedPromise,
    isImporting,
    stopSuggestingBotTour,
    stopSuggestingVaultTour,
    overlayIsOpen,
    backButtonTriggersHome,
    hideBonusTip,
    activeGuideId,
    importFromFile,
    importFromMnemonic,
    setScreenKey: setTab,
    isCertificationStepComplete: isCertificationStepComplete,
    getCertificationBlocker: getCertificationBlocker,
    isCertificationStepUnlocked,
  };
});
