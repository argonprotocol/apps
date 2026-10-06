import type { Meta, StoryObj } from '@storybook/vue3-vite';
import { BondLot, MICROGONS_PER_ARGON } from '@argonprotocol/apps-core';
import * as Vue from 'vue';
import { mocked, userEvent, within } from 'storybook/test';
import AppScreen from '../../components/AppScreen.vue';
import { setupAppScenario } from '../../scenarios/setupAppScenario.ts';
import { setCertificationGuide } from '../../scenarios/setupCertificationScenario.ts';
import {
  onboardingMemberInvite,
  setupVaultingPortfolioScenario,
} from '../../scenarios/setupVaultingPortfolioScenario.ts';
import basicEmitter from '../../../src-vue/emitters/basicEmitter.ts';
import { TopTab, VaultingSetupStatus, type IConfig } from '../../../src-vue/interfaces/IConfig.ts';
import { Config } from '../../../src-vue/lib/Config.ts';
import VaultSettingsPanel from '../../../src-vue/panels/VaultSettingsPanel.vue';
import { useFinancials } from '../../../src-vue/stores/financials.ts';
import { useWallets } from '../../../src-vue/stores/wallets.ts';
import { getConfig } from '../../../src-vue/stores/config.ts';
import { getMyVault } from '../../../src-vue/stores/vaults.ts';
import { useMiningStats } from '../../../src-vue/stores/miningStats.ts';
import { getArgonBonds } from '../../../src-vue/stores/argonBonds.ts';
import { useVaultingAssetBreakdown } from '../../../src-vue/stores/vaultingAssetBreakdown.ts';
import { OperationalStepId, useCertificationController } from '../../../src-vue/stores/certificationController.ts';
import Vaulting from '../../../src-vue/screens/Vaulting.vue';

const vaultingRules = Config.getDefault('vaultingRules') as IConfig['vaultingRules'];

const meta = {
  title: 'Vaulting/Overview',
  component: Vaulting,
  render: () => ({
    components: { AppScreen, Vaulting },
    template: '<AppScreen><Vaulting /></AppScreen>',
  }),
} satisfies Meta<typeof Vaulting>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Start: Story = {
  beforeEach: () => {
    setupAppScenario({ selectedTab: TopTab.Vaulting });
  },
  render: () => ({
    components: { AppScreen, Vaulting },
    setup() {
      return {
        config: getConfig(),
        VaultingSetupStatus,
      };
    },
    template: `
      <AppScreen :interactive="config.vaultingSetupStatus === VaultingSetupStatus.None">
        <Vaulting />
      </AppScreen>
    `,
  }),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await userEvent.click(canvas.getByRole('button', { name: 'Set Up Your Stabilization Vault' }));
    getConfig().vaultingSetupStatus = VaultingSetupStatus.None;
    await Vue.nextTick();
  },
};

export const ServerRequired: Story = {
  beforeEach: () => {
    setupAppScenario({
      selectedTab: TopTab.Vaulting,
      config: { vaultingSetupStatus: VaultingSetupStatus.Checklist },
    });
  },
};

export const ServerInstalling: Story = {
  beforeEach: () => {
    setupAppScenario({
      selectedTab: TopTab.Vaulting,
      config: {
        vaultingSetupStatus: VaultingSetupStatus.Checklist,
        isServerAdded: true,
        serverAdd: { localComputer: {} },
      },
    });
  },
};

export const RulesRequired: Story = {
  beforeEach: () => {
    setupAppScenario({
      selectedTab: TopTab.Vaulting,
      config: {
        vaultingSetupStatus: VaultingSetupStatus.Checklist,
        isServerAdded: true,
        isServerInstalled: true,
        serverAdd: { localComputer: {} },
      },
    });
  },
};

export const FundingRequired: Story = {
  beforeEach: () => {
    setupAppScenario({
      selectedTab: TopTab.Vaulting,
      config: {
        vaultingSetupStatus: VaultingSetupStatus.Checklist,
        isServerAdded: true,
        isServerInstalled: true,
        serverAdd: { localComputer: {} },
        hasSavedVaultingRules: true,
        vaultingRules: {
          ...vaultingRules,
          baseMicrogonCommitment: 2_400_000_000n,
          baseMicronotCommitment: 50_000_000n,
        },
      },
    });
  },
};

export const ReadyToLaunch: Story = {
  beforeEach: () => {
    const { wallets } = setupAppScenario({
      selectedTab: TopTab.Vaulting,
      config: {
        vaultingSetupStatus: VaultingSetupStatus.Checklist,
        isServerAdded: true,
        isServerInstalled: true,
        serverAdd: { localComputer: {} },
        hasSavedVaultingRules: true,
        vaultingRules,
      },
    });

    wallets.defaultArgonWallet.availableMicrogons =
      vaultingRules.baseMicrogonCommitment + 2n * BigInt(MICROGONS_PER_ARGON);
    wallets.defaultArgonWallet.availableMicronots = vaultingRules.baseMicronotCommitment;
  },
};

export const Portfolio: Story = {
  name: 'Portfolio with securitization shortfall',
  beforeEach: setupVaultingPortfolioScenario,
};

export const PotentialRevenue: Story = {
  name: 'Potential revenue from trailing history',
  beforeEach: setupVaultingPortfolioScenario,
  play: async ({ canvasElement }) => {
    await userEvent.hover(within(canvasElement).getByText(/Potential Daily Revenue/));
  },
};

export const ZeroNetworkRevenue: Story = {
  beforeEach: () => {
    setupVaultingPortfolioScenario();
    useMiningStats().aggregatedBidCosts = 0n;
  },
  play: PotentialRevenue.play,
};

export const ArgonotRewardShortfall: Story = {
  beforeEach: setupVaultingPortfolioScenario,
  play: async ({ canvasElement }) => {
    await userEvent.hover(within(canvasElement).getByRole('button', { name: /Potential Revenue Captured/ }));
  },
};

export const ArgonotFundedAwaitingFrame: Story = {
  beforeEach: () => {
    setupVaultingPortfolioScenario();
    getMyVault().data.argonotCommitment = { ...getMyVault().data.argonotCommitment, heldMicronots: 2_400_000_000n };
  },
  play: ArgonotRewardShortfall.play,
};

export const ArgonotBackingWithPartialUtilization: Story = {
  beforeEach: () => {
    setupVaultingPortfolioScenario();
    const vaultId = getMyVault().vaultId!;
    getMyVault().data.argonotCommitment = { ...getMyVault().data.argonotCommitment, heldMicronots: 2_400_000_000n };
    const capital = getArgonBonds().data.frameCapital!;
    getArgonBonds().data.frameCapital = {
      ...capital,
      vaultSecuritizationPositions: {
        ...capital.vaultSecuritizationPositions,
        [vaultId]: {
          ...capital.vaultSecuritizationPositions[vaultId],
          argonotSecuritizationInMicrogons: 4_800_000_000n,
        },
      },
    };
  },
};

export const ArgonotPendingWithdrawal: Story = {
  beforeEach: () => {
    setupVaultingPortfolioScenario();
    getMyVault().data.argonotCommitment = { ...getMyVault().data.argonotCommitment, heldMicronots: 2_400_000_000n };
    getMyVault().createdVault!.securitizationReleaseSchedule.set(860_720, {
      lockedCommitments: 0n,
      relockableCommitments: 0n,
      argonWithdrawals: 0n,
      argonotWithdrawals: 400_000_000n,
    });
  },
  play: ArgonotRewardShortfall.play,
};

export const ArgonotGuidanceUnavailable: Story = {
  beforeEach: () => {
    setupVaultingPortfolioScenario();
    getArgonBonds().data.averageMicrogonsPerArgonot = undefined;
  },
};

export const ExistingVaultWithCertificationGuide: Story = {
  name: 'Existing vault with certification guide',
  beforeEach: () => {
    setupVaultingPortfolioScenario();
    setCertificationGuide(OperationalStepId.ActivateVault);
  },
};

export const ExternalBondDetails: Story = {
  beforeEach: setupVaultingPortfolioScenario,
  play: async ({ canvasElement }) => {
    useCertificationController().setOperationalInvites([onboardingMemberInvite]);
    await userEvent.click(canvasElement.querySelector('[data-treemap-key="lot:72"]')!);
  },
};

export const UnderSecuritized: Story = {
  beforeEach: setupVaultingPortfolioScenario,
  play: async ({ canvasElement }) => {
    await userEvent.hover(within(canvasElement).getByRole('button', { name: /Allowed BTC Is Locked/ }));
  },
};

export const SecuritizationShortfall: Story = {
  beforeEach: setupVaultingPortfolioScenario,
  render: () => ({
    components: { AppScreen, Vaulting, VaultSettingsPanel },
    setup() {
      Vue.onMounted(() => basicEmitter.emit('openVaultSettingsOverlay'));
    },
    template: '<AppScreen><Vaulting /></AppScreen><VaultSettingsPanel />',
  }),
};

export const VaultActivationGuide: Story = {
  beforeEach: () => {
    setupAppScenario({ selectedTab: TopTab.Vaulting });
    setCertificationGuide(OperationalStepId.ActivateVault);
  },
};

export const IncompleteEarnings: Story = {
  beforeEach: () => {
    setupVaultingPortfolioScenario();
    const summary = useFinancials().financialPositionAggregate.groupSummaries.vaulting.returnSummary;
    summary.paidIncome = undefined;
    summary.percent = undefined;
  },
};

export const LoadingEarnings: Story = {
  beforeEach: () => {
    setupVaultingPortfolioScenario();
    const group = useFinancials().financialPositionAggregate.groupSummaries.vaulting;
    group.state = 'loading';
    group.returnSummary.paidIncome = 0n;
    group.returnSummary.percent = undefined;
  },
};

export const IncompleteEarningsChart: Story = {
  beforeEach: () => {
    setupVaultingPortfolioScenario();
    const earnings = getArgonBonds().data.dailyEarnings[1];
    earnings.earningsDestination = 'Vault';
    earnings.earningsMicrogons = undefined;
  },
};

export const ZeroEarningsChart: Story = {
  beforeEach: () => {
    setupVaultingPortfolioScenario();
    for (const frame of getMyVault().data.stats!.changesByFrame) {
      frame.bitcoinFeeRevenue = 0n;
      frame.treasuryPool.vaultEarnings = 0n;
    }
  },
};

export const NoCompletedEarnings: Story = {
  beforeEach: () => {
    setupVaultingPortfolioScenario();
    getMyVault().data.stats!.changesByFrame = [];
  },
};

export const FlexibleBondsInUse: Story = {
  beforeEach: () => setupFlexibleBonds(1_000),
};

export const FlexibleBondsPartiallyDisplaced: Story = {
  beforeEach: () => setupFlexibleBonds(1_900),
};

export const FlexibleBondsFullyDisplaced: Story = {
  beforeEach: () => setupFlexibleBonds(2_400),
};

export const CompactFlexibleBond: Story = {
  beforeEach: () => setupFlexibleBonds(2_100),
};

export const NarrowFlexibleBond: Story = {
  beforeEach: () => setupFlexibleBonds(2_000),
};

export const TinyFlexibleBond: Story = {
  beforeEach: () => setupFlexibleBonds(2_300),
};

export const FlexibleBondBreakdown: Story = {
  ...FlexibleBondsPartiallyDisplaced,
  play: async ({ canvasElement }) => {
    await userEvent.hover(await within(canvasElement).findByLabelText('Flexible bonds'));
  },
};

function setupFlexibleBonds(regularBonds: number) {
  setupVaultingPortfolioScenario();
  const bonds = getArgonBonds();
  const state = bonds.data.vaultsById[getMyVault().vaultId!];
  const [operator, external] = state.bondLots;
  const flexible = new BondLot(operator.id, { ...operator, bonds: 700, isFlexible: true }, operator.ownAddress);
  const regular = new BondLot(external.id, { ...external, bonds: regularBonds });
  const flexibleInUse = Math.min(700, 2_400 - regularBonds);
  state.bondLots = [flexible, regular];
  state.flexibleBonds = 700;
  state.regularBonds = regularBonds;
  state.displacedFlexibleBonds = 700 - flexibleInUse;
  state.currentFrame.vaultBonds = regularBonds + flexibleInUse;
  state.currentFrame.flexibleBondsEligible = flexibleInUse;
  state.currentFrame.bondLots = [
    {
      lot: flexible,
      eligibleMicrogons: BondLot.bondsToMicrogons(flexibleInUse),
    },
    {
      lot: regular,
      eligibleMicrogons: BondLot.bondsToMicrogons(regularBonds),
    },
  ];
  const breakdown = useVaultingAssetBreakdown();
  mocked(useVaultingAssetBreakdown).mockReturnValue({
    ...breakdown,
    treasuryBondCapacityUsedMicrogons: BondLot.bondsToMicrogons(state.currentFrame.vaultBonds),
    treasuryBondCapacityUsedPct: (state.currentFrame.vaultBonds / 2_400) * 100,
  });
}

export const ChecklistNeedsArgonots: Story = {
  beforeEach: () => {
    setupAppScenario({
      selectedTab: TopTab.Vaulting,
      config: {
        vaultingSetupStatus: VaultingSetupStatus.Checklist,
        hasSavedVaultingRules: true,
        isServerAdded: true,
        vaultingRules: {
          ...vaultingRules,
          baseMicrogonCommitment: 2_400_000_000n,
          baseMicronotCommitment: 50_000_000n,
        },
      },
    });
    useWallets().defaultArgonWallet.availableMicrogons = 2_402_000_000n;
  },
};

export const ChecklistFunded: Story = {
  beforeEach: () => {
    setupAppScenario({
      selectedTab: TopTab.Vaulting,
      config: {
        vaultingSetupStatus: VaultingSetupStatus.Checklist,
        hasSavedVaultingRules: true,
        isServerAdded: true,
        vaultingRules: {
          ...vaultingRules,
          baseMicrogonCommitment: 2_400_000_000n,
          baseMicronotCommitment: 50_000_000n,
        },
      },
    });
    useWallets().defaultArgonWallet.availableMicrogons = 2_402_000_000n;
    useWallets().defaultArgonWallet.availableMicronots = 50_000_000n;
  },
};
