import { MICROGONS_PER_ARGON } from '@argonprotocol/apps-core';
import { TypeRegistry } from '@polkadot/types';
import * as Vue from 'vue';
import { fn, mocked } from 'storybook/test';
import { UpstreamOperatorClient } from '../../src-vue/lib/UpstreamOperatorClient.ts';
import { TopTab } from '../../src-vue/interfaces/IConfig.ts';
import { getOperationalRewardConfig, subscribeOperationalAccount } from '../../src-vue/lib/OperationalAccount.ts';
import { OperationalStepId, useCertificationController } from '../../src-vue/stores/certificationController.ts';
import { getMainchainClient } from '../../src-vue/stores/mainchain.ts';
import { getUpstreamOperatorClient } from '../../src-vue/stores/upstreamOperator.ts';
import { setupAppScenario } from './setupAppScenario.ts';
import { setupHomeScenario } from './setupHomeScenario.ts';

type CertificationScenario = {
  track: 'treasury' | 'operations';
  state: 'mixed' | 'complete';
};

const microgonsPerArgon = BigInt(MICROGONS_PER_ARGON);
const certificationRewardConfig = {
  operationalActivationReward: 500n * microgonsPerArgon,
  operationalReferralBonusReward: 5_000n * microgonsPerArgon,
  operationalReferralsPerBonusReward: 5,
  operationalMinimumUniswapTransfer: 2_000n * microgonsPerArgon,
  operationalMinimumVaultLockTicks: 365n * 24n * 60n,
  operationalMinimumVaultSecuritization: 1_000n * microgonsPerArgon,
  miningSeatsForOperational: 2,
  treasuryMinimumBitcoin: 600n * microgonsPerArgon,
  treasuryMinimumBonds: 500n * microgonsPerArgon,
  treasuryMinimumUniswapTransfer: 1_000n * microgonsPerArgon,
  bitcoinLockSizeForUpgradeCode: 5_000n * microgonsPerArgon,
  miningSeatsPerUpgradeCode: 5,
  maxAvailableUpgradeCodes: 3,
};
const scenarioRegistry = new TypeRegistry();
const scenarioMainchainClient = {
  query: {
    bitcoinLocks: {
      utxoIdsByOwnerAccount: { keys: fn(async () => []) },
    },
    crosschainTransfer: {
      transferTotalsByAccount: fn(async () => ({ microgonsIn: 0n })),
    },
    treasury: {
      bondLotIdsByAccount: { keys: fn(async () => []) },
    },
  },
  consts: {
    operationalAccounts: {
      minimumBitcoin: scenarioRegistry.createType('u128', 600n * microgonsPerArgon),
      minimumBonds: scenarioRegistry.createType('u128', 500n * microgonsPerArgon),
      minimumUniswapTransfer: scenarioRegistry.createType('u128', 1_000n * microgonsPerArgon),
      operationalMinimumUniswapTransfer: scenarioRegistry.createType('u128', 2_000n * microgonsPerArgon),
      operationalMinimumVaultSecuritization: scenarioRegistry.createType('u128', 1_000n * microgonsPerArgon),
      miningSeatsForOperational: scenarioRegistry.createType('u32', 2),
    },
  },
} as unknown as Awaited<ReturnType<typeof getMainchainClient>>;

export type CertificationMenuScenario =
  | 'treasuryChecklist'
  | 'treasuryComplete'
  | 'operationsChecklist'
  | 'stepCompleted'
  | 'upgradeAvailable'
  | 'upgradeRequested'
  | 'operationsActivated';

export function setupCertificationScenario({ track, state }: CertificationScenario): void {
  const { config, controller } = setupAppScenario({
    selectedTab: track === 'treasury' ? TopTab.BitcoinLocks : TopTab.Mining,
    config: {
      hasExtensionTreasury: true,
      hasExtensionOperations: track === 'operations',
    },
  });

  config.setCertificationDetails({ hasSavedMnemonic: true });
  controller.isLoaded = true;
  controller.rewardConfig = {
    ...controller.rewardConfig,
    treasuryMinimumBitcoin: 600n * microgonsPerArgon,
    treasuryMinimumBonds: 500n * microgonsPerArgon,
    treasuryMinimumUniswapTransfer: 1_000n * microgonsPerArgon,
    operationalMinimumUniswapTransfer: 2_000n * microgonsPerArgon,
    operationalMinimumVaultSecuritization: 1_000n * microgonsPerArgon,
    miningSeatsForOperational: 2,
  };
  controller.chainProgress = {
    ...controller.chainProgress,
    hasOperationalAccount: true,
    hasUniswapTransfer: state === 'complete' || track === 'operations',
    hasTreasuryUniswapTransfer: state === 'complete' || track === 'treasury',
    hasTreasuryBondParticipation: state === 'complete',
    hasVault: state === 'complete',
    hasFirstMiningSeat: state === 'complete',
    hasSecondMiningSeat: state === 'complete',
    hasBitcoinLock: state === 'complete',
  };

  if (state === 'mixed') {
    controller.activeGuideId =
      track === 'treasury' ? OperationalStepId.AcquireArgonBonds : OperationalStepId.ActivateVault;
  } else {
    controller.activeGuideId = null;
  }
}

export function setCertificationGuide(stepId: OperationalStepId): void {
  useCertificationController().activeGuideId = stepId;
}

export async function setupCertificationMenuScenario(state: CertificationMenuScenario): Promise<void> {
  if (state === 'stepCompleted') {
    const { config, controller } = setupHomeScenario('basic', { isLoadedPromise: Promise.resolve() });

    mocked(getMainchainClient).mockResolvedValue(scenarioMainchainClient);
    mocked(getOperationalRewardConfig).mockResolvedValue(certificationRewardConfig);
    mocked(subscribeOperationalAccount).mockResolvedValue(fn());

    await controller.isLoadedPromise;

    config.hasExtensionTreasury = true;
    config.hasExtensionOperations = true;
    config.setCertificationDetails({ hasSavedMnemonic: true });
    controller.hasLoadedInitialOperationalProgress = true;
    controller.chainProgress = {
      ...controller.chainProgress,
      hasOperationalAccount: true,
      isUpgradedToOperations: true,
    };
    await Vue.nextTick();

    controller.chainProgress = {
      ...controller.chainProgress,
      hasUniswapTransfer: true,
    };
    await Vue.nextTick();
    return;
  }

  const isOperationsState = state === 'operationsChecklist' || state === 'operationsActivated';
  const { config, controller } = setupHomeScenario(isOperationsState ? 'operations' : 'treasury');
  const isTreasuryComplete = state !== 'treasuryChecklist';

  controller.isLoaded = true;
  controller.hasLoadedInitialOperationalProgress = true;
  controller.rewardConfig = {
    ...certificationRewardConfig,
  };
  controller.chainProgress = {
    ...controller.chainProgress,
    hasOperationalAccount: true,
    hasTreasuryUniswapTransfer: true,
    hasTreasuryBondParticipation: isTreasuryComplete,
    hasBitcoinLock: isTreasuryComplete,
    hasUniswapTransfer: isOperationsState,
    hasVault: false,
    hasFirstMiningSeat: false,
    hasSecondMiningSeat: false,
    isUpgradedToOperations: isOperationsState,
    isOperational: false,
  };
  config.setCertificationDetails({
    hasSavedMnemonic: true,
    showBonusTooltip: false,
    dismissedOperationsUpgradeOverlay: state !== 'upgradeAvailable',
    dismissedOperationsActivatedOverlay: state !== 'operationsActivated',
  });

  if (state === 'upgradeAvailable' || state === 'upgradeRequested') {
    config.upstreamOperator = {
      name: 'Atlas Operator',
      vaultId: 7,
      restorePackageRevision: state === 'upgradeRequested' ? '4.1' : '4.0',
    };

    const upstreamOperatorClient = new UpstreamOperatorClient();
    upstreamOperatorClient.getMemberInvite = fn(async () => ({
      id: 7,
      name: 'Treasury Member',
      fromName: 'Atlas Operator',
      inviteCode: 'synthetic-operations-upgrade',
      createdAt: new Date('2026-08-01T12:00:00.000Z'),
    }));
    mocked(getUpstreamOperatorClient).mockReturnValue(upstreamOperatorClient);
  }
}
