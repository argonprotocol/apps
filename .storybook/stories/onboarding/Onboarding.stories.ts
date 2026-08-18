import type { Meta, StoryObj } from '@storybook/vue3-vite';
import type { ICertificationProgress } from '@argonprotocol/apps-core';
import type { IMemberInvite } from '@argonprotocol/apps-router';
import { Keyring } from '@polkadot/keyring';
import * as Vue from 'vue';
import { expect, fn, mocked, within } from 'storybook/test';
import AppScreen from '../../components/AppScreen.vue';
import { createScenarioVault } from '../../scenarios/createScenarioVault.ts';
import { setupAppScenario } from '../../scenarios/setupAppScenario.ts';
import {
  type IConfig,
  InstallStepErrorType,
  OnboardingSetupStatus,
  TopTab,
} from '../../../src-vue/interfaces/IConfig.ts';
import { Config } from '../../../src-vue/lib/Config.ts';
import {
  activateOperationalAccountSetup,
  usesOperationalProfileNameRuntime,
} from '../../../src-vue/lib/OperationalAccount.ts';
import { useCertificationController } from '../../../src-vue/stores/certificationController.ts';
import { getConfig } from '../../../src-vue/stores/config.ts';
import { getInstaller } from '../../../src-vue/stores/installer.ts';
import { getMainchainClient } from '../../../src-vue/stores/mainchain.ts';
import { getMyVault } from '../../../src-vue/stores/vaults.ts';
import { getServerApiClient } from '../../../src-vue/stores/server.ts';
import Onboarding from '../../../src-vue/screens/Onboarding.vue';

const meta = {
  title: 'Onboarding/Overview',
  component: Onboarding,
  render: () => ({
    components: { AppScreen, Onboarding },
    template: '<AppScreen><Onboarding /></AppScreen>',
  }),
} satisfies Meta<typeof Onboarding>;

export default meta;
type Story = StoryObj<typeof meta>;
const scenarioKeyring = new Keyring({ type: 'sr25519' });

export const LockedForTreasury: Story = {
  beforeEach: () => {
    setupAppScenario({
      selectedTab: TopTab.Onboarding,
      config: { hasExtensionOperations: false, hasExtensionTreasury: true },
    });
  },
};

export const Start: Story = {
  beforeEach: () => {
    setupOnboardingScenario(OnboardingSetupStatus.None);
  },
};

export const SetupRequired: Story = {
  beforeEach: () => {
    setupOnboardingScenario(OnboardingSetupStatus.Checklist);
  },
};

export const ServerInstalling: Story = {
  beforeEach: () => {
    setupOnboardingScenario(OnboardingSetupStatus.Checklist, { hasOperation: true, serverAdded: true });
  },
};

export const ReadyToActivate: Story = {
  beforeEach: () => {
    setupOnboardingScenario(OnboardingSetupStatus.Checklist, { hasOperation: true, serverInstalled: true });
  },
};

export const Activating: Story = {
  beforeEach: () => {
    setupOnboardingScenario(OnboardingSetupStatus.Installing, { hasOperation: true, serverInstalled: true });
    mocked(activateOperationalAccountSetup).mockReturnValue(new Promise(() => undefined));
  },
};

export const ActivationFailed: Story = {
  beforeEach: () => {
    setupOnboardingScenario(OnboardingSetupStatus.Installing, { hasOperation: true, serverInstalled: true });
    mocked(activateOperationalAccountSetup).mockRejectedValue(
      new Error('The operational account transaction could not be finalized.'),
    );
  },
};

export const InviteLoading: Story = {
  beforeEach: () => {
    setupOnboardingScenario(OnboardingSetupStatus.Finished, { hasOperation: true, serverInstalled: true });
  },
};

export const ServerUpdatingWithoutInviteApi: Story = {
  beforeEach: () => {
    setupOnboardingScenario(OnboardingSetupStatus.Finished, {
      hasOperation: true,
      serverInstalled: true,
      serverInstalling: true,
    });
    mocked(getServerApiClient, { partial: true }).mockReturnValue({
      getInvites: fn(async () => {
        throw new Error('Server API unavailable');
      }),
    });
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await expect(await canvas.findByRole('heading', { name: 'Updating Your Server' })).toBeVisible();
    await expect(canvas.getByText(/Member onboarding will reconnect automatically/)).toBeVisible();
  },
};

export const ServerUpdateFailed: Story = {
  beforeEach: () => {
    setupOnboardingScenario(OnboardingSetupStatus.Finished, {
      hasOperation: true,
      serverInstalled: true,
      serverInstalling: true,
    });

    const config = getConfig();
    config.serverInstaller = Config.getDefault('serverInstaller') as IConfig['serverInstaller'];
    config.serverInstaller.errorType = InstallStepErrorType.ArgonInstall;
    config.serverInstaller.errorMessage = 'Argon syncstatus returned error JSON too many times';

    mocked(getServerApiClient, { partial: true }).mockReturnValue({
      getInvites: fn(async () => {
        throw new Error('Server API unavailable');
      }),
    });
    mocked(getInstaller, { partial: true }).mockReturnValue({
      runFailedStep: fn(async () => undefined),
    });
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await expect(canvas.getByTestId('LeftBar.goto(TopTab.Onboarding)')).toHaveClass('Selected');
    await expect(await canvas.findByText('Server Update Failed')).toBeVisible();
    await expect(canvas.getByText(/Failed to Install Argon/)).toBeVisible();
    await expect(canvas.getByText('Argon syncstatus returned error JSON too many times')).toBeVisible();
  },
};

export const ServerUpdatingWithInviteApi: Story = {
  beforeEach: () => {
    setupOnboardingScenario(OnboardingSetupStatus.Finished, {
      hasOperation: true,
      serverInstalled: true,
      serverInstalling: true,
    });
    mocked(getServerApiClient, { partial: true }).mockReturnValue({
      getInvites: fn(async () => createMemberInvites()),
    });
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await expect(await canvas.findByText('Server Update in Progress')).toBeVisible();
    await expect(await canvas.findByText('Morgan')).toBeVisible();
    await expect(canvas.getByTestId('SendMemberInvite')).not.toBeDisabled();
  },
};

export const ServerUpdatingWithCachedInvites: Story = {
  beforeEach: async () => {
    const controller = setupOnboardingScenario(OnboardingSetupStatus.Finished, {
      hasOperation: true,
      serverInstalled: true,
      serverInstalling: true,
    });
    await Vue.nextTick();
    controller.setOperationalInvites(createMemberInvites());
    controller.hasLoadedOperationalInvites = true;
    mocked(getServerApiClient, { partial: true }).mockReturnValue({
      getInvites: fn(async () => {
        throw new Error('Server API unavailable');
      }),
    });
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await expect(await canvas.findByText('Server Update in Progress')).toBeVisible();
    await expect(canvas.getByText('Morgan')).toBeVisible();
    await expect(canvas.getByTestId('SendMemberInvite')).toBeDisabled();
  },
};

export const ServerUnavailableWithoutInviteApi: Story = {
  beforeEach: () => {
    setupOnboardingScenario(OnboardingSetupStatus.Finished, {
      hasOperation: true,
      serverInstalled: true,
    });
    mocked(getServerApiClient, { partial: true }).mockReturnValue({
      getInvites: fn(async () => {
        throw new Error('Server API unavailable');
      }),
    });
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await expect(await canvas.findByRole('heading', { name: 'Server Unavailable' })).toBeVisible();
    await expect(canvas.getByText(/Member onboarding cannot reach your server right now/)).toBeVisible();
  },
};

export const EmptyDashboard: Story = {
  beforeEach: () => {
    const controller = setupOnboardingScenario(OnboardingSetupStatus.Finished, {
      hasOperation: true,
      serverInstalled: true,
    });
    controller.hasLoadedOperationalInvites = true;
  },
};

export const MemberStates: Story = {
  beforeEach: () => {
    const controller = setupOnboardingScenario(OnboardingSetupStatus.Finished, {
      hasOperation: true,
      serverInstalled: true,
    });
    controller.chainProgress = {
      ...controller.chainProgress,
      availableAccessCodes: 3,
      rewardsEarnedAmount: 7_500_000n,
      rewardsCollectedAmount: 2_250_000n,
      isUpgradedToOperations: true,
      isOperational: true,
    };
    controller.setOperationalInvites(createMemberInvites());
    controller.hasLoadedOperationalInvites = true;
  },
};

function setupOnboardingScenario(
  onboardingSetupStatus: OnboardingSetupStatus,
  options: {
    hasOperation?: boolean;
    serverAdded?: boolean;
    serverInstalled?: boolean;
    serverInstalling?: boolean;
  } = {},
) {
  const { config, controller } = setupAppScenario({
    selectedTab: TopTab.Onboarding,
    config: {
      onboardingSetupStatus,
      isServerAdded: options.serverAdded ?? options.serverInstalled ?? false,
      isServerInstalled: options.serverInstalled ?? false,
      isServerInstalling: options.serverInstalling ?? false,
    },
  });

  if (options.serverInstalled) {
    config.serverDetails = {
      ...config.serverDetails,
      ipAddress: '192.0.2.10',
    };
  }
  mocked(getServerApiClient, { partial: true }).mockReturnValue({
    getInvites: fn(async () => controller.operationalInvites),
  });
  const createdVault = options.hasOperation ? createScenarioVault() : null;
  const currentMyVault = getMyVault();

  mocked(usesOperationalProfileNameRuntime).mockReturnValue(false);
  mocked(getMainchainClient).mockResolvedValue({
    tx: { bitcoinLocks: {}, treasury: {} },
  } as Awaited<ReturnType<typeof getMainchainClient>>);
  mocked(getMyVault).mockReturnValue({
    ...currentMyVault,
    data: Vue.shallowReactive({ ...currentMyVault.data, createdVault, currentFrameId: 10_000 }),
    createdVault,
    vaultId: createdVault?.vaultId,
    load: fn(async () => undefined),
  } as unknown as ReturnType<typeof getMyVault>);

  return controller;
}

function createMemberInvites(): IMemberInvite[] {
  const now = new Date('2026-08-15T16:00:00.000Z');
  const treasuryComplete = createCertificationProgress({
    hasTreasuryBitcoin: true,
    hasTreasuryBonds: true,
    hasTreasuryUniswapTransfer: true,
    isTreasuryCertified: true,
  });

  return [
    createInvite(1, 'Morgan'),
    createInvite(2, 'Casey', { lastClickedAt: now }),
    createInvite(3, 'Jordan', {
      defaultAccountId: memberAccountId(3),
      firstClickedAt: now,
      certificationProgress: createCertificationProgress({ hasTreasuryBitcoin: true }),
      vaultContribution: { bitcoinAmount: 120_000_000n, pendingBitcoinAmount: 0n, bondAmount: 0n },
    }),
    createInvite(4, 'Riley', {
      defaultAccountId: memberAccountId(4),
      firstClickedAt: now,
      certificationProgress: createCertificationProgress({ hasTreasuryBonds: true }),
      vaultContribution: { bitcoinAmount: 0n, pendingBitcoinAmount: 600_000_000n, bondAmount: 800_000_000n },
    }),
    createInvite(5, 'Taylor', {
      defaultAccountId: memberAccountId(5),
      operationalAccountId: operationalAccountId(5),
      firstClickedAt: now,
      operationsUpgradeRequestedAt: now,
      certificationProgress: treasuryComplete,
      vaultContribution: { bitcoinAmount: 600_000_000n, pendingBitcoinAmount: 0n, bondAmount: 1_000_000_000n },
    }),
    createInvite(6, 'Avery', {
      defaultAccountId: memberAccountId(6),
      operationalAccountId: operationalAccountId(6),
      firstClickedAt: now,
      operationsUpgradedAt: now,
      certificationProgress: createCertificationProgress({
        ...treasuryComplete,
        hasOperationalAccount: true,
        isUpgradedToOperations: true,
        hasOperationalVault: true,
      }),
      vaultContribution: { bitcoinAmount: 900_000_000n, pendingBitcoinAmount: 75_000_000n, bondAmount: 1_500_000_000n },
    }),
    createInvite(7, 'Quinn', {
      defaultAccountId: memberAccountId(7),
      operationalAccountId: operationalAccountId(7),
      firstClickedAt: now,
      operationsUpgradedAt: now,
      certificationProgress: createCertificationProgress({
        hasOperationalAccount: true,
        isTreasuryCertified: true,
        hasTreasuryBitcoin: true,
        hasTreasuryBonds: true,
        hasTreasuryUniswapTransfer: true,
        isUpgradedToOperations: true,
        hasOperationalVault: true,
        hasOperationalMiningSeats: true,
        hasOperationalUniswapTransfer: true,
        isOperationallyCertified: true,
      }),
      vaultContribution: { bitcoinAmount: 1_500_000_000n, pendingBitcoinAmount: 0n, bondAmount: 2_400_000_000n },
    }),
    createInvite(8, 'Jamie', {
      bitcoinLockCoupon: {
        status: 'Expired',
        expiresAt: new Date('2026-08-14T16:00:00.000Z'),
        coupon: {
          id: 8,
          userId: 8,
          sequence: 1,
          offerCode: 'expired-offer',
          vaultId: 7,
          maxSatoshis: 50_000_000n,
          estimatedGiftUsd: 25,
          btcPctFee: 0,
          expiresAfterTicks: 1_440,
          createdAt: new Date('2026-08-10T16:00:00.000Z'),
          updatedAt: now,
        },
      },
    }),
  ];
}

function memberAccountId(id: number): string {
  return scenarioKeyring.addFromUri(`//StorybookMember${id}`).address;
}

function operationalAccountId(id: number): string {
  return scenarioKeyring.addFromUri(`//StorybookOperationalMember${id}`).address;
}

function createInvite(id: number, name: string, overrides: Partial<IMemberInvite> = {}): IMemberInvite {
  return {
    id,
    name,
    fromName: 'Atlas Operator',
    inviteCode: `synthetic-invite-${id}`,
    createdAt: new Date(Date.UTC(2026, 7, 15 - id, 15, 0, 0)),
    ...overrides,
  };
}

function createCertificationProgress(overrides: Partial<ICertificationProgress> = {}): ICertificationProgress {
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
    ...overrides,
  };
}
