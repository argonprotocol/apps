import type { Meta, StoryObj } from '@storybook/vue3-vite';
import { Chart } from 'chart.js';
import { BondLot, MICROGONS_PER_ARGON, NetworkConfig } from '@argonprotocol/apps-core';
import * as Vue from 'vue';
import BigNumber from 'bignumber.js';
import { fn, mocked, userEvent, within } from 'storybook/test';
import AppScreen from '../../components/AppScreen.vue';
import { setupAppScenario } from '../../scenarios/setupAppScenario.ts';
import { setCertificationGuide } from '../../scenarios/setupCertificationScenario.ts';
import {
  onboardingMemberInvite,
  setupVaultingPortfolioScenario,
} from '../../scenarios/setupVaultingPortfolioScenario.ts';
import basicEmitter from '../../../src-vue/emitters/basicEmitter.ts';
import { TopTab, VaultingSetupStatus, type IConfig } from '../../../src-vue/interfaces/IConfig.ts';
import { BitcoinLockStatus } from '../../../src-vue/interfaces/IBitcoinLockRecord.ts';
import { Config } from '../../../src-vue/lib/Config.ts';
import { VaultCollectBuilder } from '../../../src-vue/lib/VaultCollectBuilder.ts';
import VaultCollectOverlay from '../../../src-vue/overlays/VaultCollectOverlay.vue';
import VaultAlert from '../../../src-vue/alerts/VaultAlert.vue';
import VaultSettingsPanel from '../../../src-vue/panels/VaultSettingsPanel.vue';
import { useFinancials } from '../../../src-vue/stores/financials.ts';
import { useWallets } from '../../../src-vue/stores/wallets.ts';
import { getConfig } from '../../../src-vue/stores/config.ts';
import { getMyVault } from '../../../src-vue/stores/vaults.ts';
import { useMiningStats } from '../../../src-vue/stores/miningStats.ts';
import { getArgonBonds } from '../../../src-vue/stores/argonBonds.ts';
import { getCurrency } from '../../../src-vue/stores/currency.ts';
import { getBitcoinLocks } from '../../../src-vue/stores/bitcoin.ts';
import { useVaultingAssetBreakdown } from '../../../src-vue/stores/vaultingAssetBreakdown.ts';
import { OperationalStepId, useCertificationController } from '../../../src-vue/stores/certificationController.ts';
import { getMiningFrames } from '../../../src-vue/stores/mainchain.ts';
import Vaulting from '../../../src-vue/screens/Vaulting.vue';

const vaultSetup = Config.getDefault('vaultSetup') as IConfig['vaultSetup'];

const meta = {
  title: 'Vaulting/Overview',
  component: Vaulting,
  beforeEach: () => {
    const interactions = new AbortController();
    window.addEventListener(
      'click',
      event => {
        if (!(event.target instanceof Element)) return;
        if (!event.target.closest('[data-revenue-action]')) return;
        event.preventDefault();
        event.stopImmediatePropagation();
      },
      { capture: true, signal: interactions.signal },
    );
    return () => interactions.abort();
  },
  render: () => ({
    components: { AppScreen, Vaulting },
    setup() {
      function preventCommands(event: Event) {
        if (event.target instanceof Element && event.target.closest('[data-revenue-capture], [data-chart-history]'))
          return;
        event.preventDefault();
        event.stopPropagation();
      }
      return { preventCommands };
    },
    template:
      '<AppScreen interactive scenarioLabel="Dashboard details preview"><div class="h-full" @click.capture="preventCommands"><Vaulting /></div></AppScreen>',
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

export const SettingsRequired: Story = {
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
        hasSavedVaultSetup: true,
        vaultSetup: {
          ...vaultSetup,
          securitizationMicrogons: 2_400_000_000n,
          committedMicronots: 50_000_000n,
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
        hasSavedVaultSetup: true,
        vaultSetup,
      },
    });

    wallets.defaultArgonWallet.availableMicrogons =
      vaultSetup.securitizationMicrogons + 2n * BigInt(MICROGONS_PER_ARGON);
    wallets.defaultArgonWallet.availableMicronots = vaultSetup.committedMicronots;
  },
};

export const Portfolio: Story = {
  name: 'Portfolio with securitization shortfall',
  beforeEach: () => {
    setupVaultingPortfolioScenario();
    Object.assign(getConfig(), { hasSavedVaultSetup: false });
  },
};

export const BitcoinLocksFillRemainingSpace: Story = {
  name: 'Bitcoin locks exceed vault capacity',
  beforeEach: () => {
    setupVaultingPortfolioScenario();
    const myVault = getMyVault();
    const locks = getBitcoinLocks().getAllLocks();
    const liquid = locks[0];
    liquid.fundedSatoshis = 5_000_000n;
    liquid.securitizedSatoshis = liquid.fundedSatoshis;
    liquid.microgonsAtTargetPerBtc = 12_000_000_000n;
    liquid.securitizationCoverageMicrogons = 600_000_000n;
    liquid.fissionedSatoshis = liquid.fundedSatoshis;
    const lock = locks[1];
    lock.status = BitcoinLockStatus.LockFunded;
    lock.securitizationCoverageMicrogons = 0n;
    lock.fissionedSatoshis = 0n;
    lock.fundedSatoshis = 50_000_000n;
    lock.securitizedSatoshis = lock.fundedSatoshis;
    lock.microgonsAtTargetPerBtc = liquid.microgonsAtTargetPerBtc;
    getBitcoinLocks().getAllLocks = fn(() => [liquid, lock]);
    myVault.data.externalLocks = {};
    myVault.createdVault!.securitizationLocked = 600_000_000n;
    myVault.createdVault!.securitizationPendingActivation = 0n;
    myVault.createdVault!.totalSatoshis = liquid.fundedSatoshis + lock.fundedSatoshis;
    myVault.createdVault!.securitizedSatoshis = liquid.fundedSatoshis;

    // Isolate Bitcoin overflow with sufficient ARGNOT backing and a matching frame snapshot.
    myVault.data.argonotCommitment = {
      heldMicronots: 2_400_000_000n,
      committedMicronots: 2_400_000_000n,
      encumberedMicronots: 0n,
    };
    const capital = getArgonBonds().data.frameCapital!;
    getArgonBonds().data.frameCapital = {
      ...capital,
      vaultSecuritizationPositions: {
        ...capital.vaultSecuritizationPositions,
        [myVault.vaultId!]: {
          ...capital.vaultSecuritizationPositions[myVault.vaultId!],
          activatedSecuritization: myVault.createdVault!.activatedSecuritization(),
          bitcoinLockedMicrogons: getCurrency().priceIndex.getSatoshiPriceInMarketMicrogons(
            myVault.createdVault!.totalSatoshis,
          ),
          argonotSecuritizationInMicrogons: 4_800_000_000n,
        },
      },
    };
  },
};

export const ChartHistory: Story = {
  beforeEach: setupVaultingPortfolioScenario,
  play: async ({ canvasElement }) => {
    const canvas = await within(canvasElement).findByLabelText('Earnings history');
    const bounds = canvas.getBoundingClientRect();
    const point = Chart.getChart(canvas as HTMLCanvasElement)!
      .getDatasetMeta(1)
      .data.at(-2)!;
    await userEvent.pointer({
      target: canvas,
      coords: { clientX: bounds.left + point.x, clientY: bounds.top + point.y },
    });
  },
};

export const HistoryWhileSubscriptionPending: Story = {
  beforeEach: () => {
    setupVaultingPortfolioScenario();
    const pendingLoad = new Promise<void>(() => {
      // Keep external initialization pending while saved history is ready.
    });
    getMyVault().load = fn(() => pendingLoad);
    getArgonBonds().subscribeGlobal = fn(() => pendingLoad);
  },
  play: ChartHistory.play,
};

export const LocalChainHistory: Story = {
  beforeEach: () => {
    const network = NetworkConfig.networkName!;
    NetworkConfig.setNetwork('dev-docker');
    setupVaultingPortfolioScenario();

    const frames = getMiningFrames();
    const firstTick = frames.getTickStart(frames.currentFrameId);
    const ticksPerFrame = NetworkConfig.rewardTicksPerFrame;
    frames.getTickStart = fn(frameId => firstTick - (frames.currentFrameId - frameId) * ticksPerFrame);
    frames.getTickEnd = fn(frameId => frames.getTickStart(frameId) + ticksPerFrame - 1);
    const openedTick = frames.getTickStart(frames.currentFrameId - 14);
    getMyVault().createdVault!.openedTick = openedTick;
    getMyVault().data.stats!.openedTick = openedTick;
    return () => NetworkConfig.setNetwork(network);
  },
  play: async ({ canvasElement }) => {
    const canvas = await within(canvasElement).findByLabelText('Earnings history');
    const marker = await within(canvasElement).findByLabelText('Latest return');
    const bounds = canvas.getBoundingClientRect();
    const endpoint = marker.getBoundingClientRect();
    await userEvent.pointer({
      target: canvas,
      coords: { clientX: endpoint.left + endpoint.width / 2, clientY: bounds.top + bounds.height / 2 },
    });
  },
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

export const SmallEarnings: Story = {
  beforeEach: () => {
    setupVaultingPortfolioScenario();
    useFinancials().financialPositionAggregate.groupSummaries.vaulting.returnSummary.paidIncome = 4_321n;
    useMiningStats().aggregatedBidCosts = 100_000n;
  },
};

export const SmallUncollectedRevenue: Story = {
  beforeEach: () => {
    setupAppScenario({ selectedTab: TopTab.Vaulting });
    const myVault = getMyVault();
    myVault.data.pendingCollectRevenue = 4_321n;
    myVault.data.expiringCollectAmount = 1_234n;
    myVault.data.nextCollectDueDate = Date.now() + 86_400_000;
    Object.assign(myVault, { collectBuilder: new VaultCollectBuilder(myVault) });
  },
  render: () => ({
    components: { VaultAlert, VaultCollectOverlay },
    setup: () => ({ notice: getMyVault().collectBuilder.getNotice() }),
    template: `
      <div class="fixed top-2 right-3 z-[10000] rounded-full border border-slate-400/40 bg-white/90 px-2.5 py-1 text-xs font-semibold text-slate-600 shadow-sm">Fixed state preview</div>
      <VaultAlert v-if="notice" :notice="notice" variant="bar" inert />
      <VaultCollectOverlay inert />
    `,
  }),
};

export const ArgonotRewardShortfall: Story = {
  beforeEach: () => {
    setupVaultingPortfolioScenario();
    // Only ARGNOT needs attention.
    getCurrency().microgonsPer.BTC = 6_000_000_000n;
    getCurrency().priceIndex.btcUsdPrice = BigNumber(6_000);
    getMyVault().data.argonotCommitment = {
      ...getMyVault().data.argonotCommitment,
      heldMicronots: 600_000_000n,
    };
  },
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole('button', { name: /of Revenue Captured/ }));
  },
};

export const BitcoinCaptureDefinition: Story = {
  beforeEach: ArgonotRewardShortfall.beforeEach,
  play: async context => {
    await ArgonotRewardShortfall.play!(context);
    await userEvent.hover(
      (await within(document.body).findAllByRole('button', { name: 'Bitcoin locked percentage' }))[0],
    );
  },
};

export const BondCaptureDefinition: Story = {
  beforeEach: ArgonotRewardShortfall.beforeEach,
  play: async context => {
    await ArgonotRewardShortfall.play!(context);
    await userEvent.hover(
      (await within(document.body).findAllByRole('button', { name: 'Argon bond capacity percentage' }))[0],
    );
  },
};

export const ArgonotCaptureDefinition: Story = {
  beforeEach: () => {
    setupVaultingPortfolioScenario();
    getCurrency().microgonsPer.BTC = 6_000_000_000n;
    getCurrency().priceIndex.btcUsdPrice = BigNumber(6_000);
    getArgonBonds().data.averageMicrogonsPerArgonot = 7_000_000n;
  },
  play: async context => {
    await ArgonotRewardShortfall.play!(context);
    await userEvent.hover(
      (await within(document.body).findAllByRole('button', { name: 'Argonot securitization percentage' }))[0],
    );
  },
};

export const UpstreamParticipationDefinition: Story = {
  beforeEach: () => {
    setupVaultingPortfolioScenario();
    const vaultId = getMyVault().vaultId!;
    const capital = getArgonBonds().data.frameCapital!;
    getArgonBonds().data.frameCapital = {
      ...capital,
      vaultSecuritizationPositions: {
        ...capital.vaultSecuritizationPositions,
        [vaultId]: { ...capital.vaultSecuritizationPositions[vaultId], upstreamParticipation: BigNumber(0.5) },
      },
    };
  },
  play: async context => {
    await ArgonotRewardShortfall.play!(context);
    await userEvent.hover(
      (await within(document.body).findAllByRole('button', { name: 'Upstream participation percentage' }))[0],
    );
    await within(document.body).findAllByRole('tooltip');
  },
};

export const LargeArgonotRequirement: Story = {
  beforeEach: () => {
    setupVaultingPortfolioScenario();
    getCurrency().microgonsPer.BTC = 6_000_000_000n;
    getCurrency().priceIndex.btcUsdPrice = BigNumber(6_000);
    getArgonBonds().data.averageMicrogonsPerArgonot = 700n;
  },
  play: ArgonotCaptureDefinition.play,
};

export const ArgonCaptureDefinition: Story = {
  beforeEach: ArgonotRewardShortfall.beforeEach,
  play: async context => {
    await ArgonotRewardShortfall.play!(context);
    await userEvent.hover(
      (await within(document.body).findAllByRole('button', { name: 'Argon network securitization percentage' }))[0],
    );
  },
};

export const ArgonotFundedAwaitingFrame: Story = {
  beforeEach: () => {
    setupVaultingPortfolioScenario();
    getCurrency().microgonsPer.BTC = 6_000_000_000n;
    getCurrency().priceIndex.btcUsdPrice = BigNumber(6_000);
    getMyVault().data.argonotCommitment = { ...getMyVault().data.argonotCommitment, heldMicronots: 2_400_000_000n };
  },
  play: ArgonotRewardShortfall.play,
};

export const SmallNetworkSecuritizationShare: Story = {
  beforeEach: () => {
    setupVaultingPortfolioScenario();
    const capital = getArgonBonds().data.frameCapital!;
    getArgonBonds().data.frameCapital = { ...capital, targetSecuritization: 1_000_000_123_456_789n };
  },
  play: ArgonotRewardShortfall.play,
};

export const FullBitcoinSpaceUndersecuritized: Story = {
  beforeEach: () => {
    setupVaultingPortfolioScenario();
    const vault = getMyVault().createdVault!;
    vault.securitizationPendingActivation = 0n;
  },
  play: ArgonotRewardShortfall.play,
};

export const BitcoinSecuritizationWarning: Story = {
  beforeEach: FullBitcoinSpaceUndersecuritized.beforeEach,
  play: async context => {
    await ArgonotRewardShortfall.play!(context);
    await userEvent.hover(
      (await within(document.body).findAllByRole('button', { name: 'Bitcoin is undersecuritized' }))[0],
    );
  },
};

export const WithinBitcoinSecuritizationTolerance: Story = {
  beforeEach: () => {
    setupVaultingPortfolioScenario();
    getMyVault().createdVault!.securitizationPendingActivation = 0n;
    getCurrency().microgonsPer.BTC = 10_686_075_949n;
    getCurrency().priceIndex.btcUsdPrice = BigNumber(10_177.21519).times(1.05);
    getCurrency().priceIndex.argonUsdPrice = BigNumber(1.05);
    const capital = getArgonBonds().data.frameCapital!;
    const vaultId = getMyVault().vaultId!;
    const position = capital.vaultSecuritizationPositions[vaultId];
    getArgonBonds().data.frameCapital = {
      ...capital,
      vaultSecuritizationPositions: {
        ...capital.vaultSecuritizationPositions,
        [vaultId]: { ...position, bitcoinLockedMicrogons: (position.securitization * 1005n) / 1000n },
      },
    };
  },
  play: ArgonotRewardShortfall.play,
};

export const BitcoinFundedAwaitingFrame: Story = {
  beforeEach: () => {
    setupVaultingPortfolioScenario();
    getMyVault().createdVault!.securitizationPendingActivation = 0n;
    getMyVault().createdVault!.securitization = 3_000_000_000n;
  },
  play: BitcoinSecuritizationWarning.play,
};

export const SmallArgonotShortfall: Story = {
  beforeEach: () => {
    setupVaultingPortfolioScenario();
    getMyVault().data.argonotCommitment = {
      ...getMyVault().data.argonotCommitment,
      heldMicronots: 2_399_990_000n,
    };
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
  play: ArgonotRewardShortfall.play,
};

export const RevenueCaptureWithoutBitcoin: Story = {
  beforeEach: () => {
    setupVaultingPortfolioScenario();
    const myVault = getMyVault();
    myVault.createdVault!.totalSatoshis = 0n;
    myVault.data.externalLocks = {};
    getBitcoinLocks().getAllLocks = () => [];
    myVault.data.argonotCommitment = {
      heldMicronots: 2_400_000_000n,
      committedMicronots: 2_400_000_000n,
      encumberedMicronots: 0n,
    };
    const capital = getArgonBonds().data.frameCapital!;
    getArgonBonds().data.frameCapital = {
      ...capital,
      vaultSecuritizationPositions: {
        ...capital.vaultSecuritizationPositions,
        [myVault.vaultId!]: {
          ...capital.vaultSecuritizationPositions[myVault.vaultId!],
          activatedSecuritization: 0n,
          bitcoinLockedMicrogons: 0n,
          argonotSecuritizationInMicrogons: 4_800_000_000n,
        },
      },
    };
    const breakdown = useVaultingAssetBreakdown();
    mocked(useVaultingAssetBreakdown).mockReturnValue({
      ...breakdown,
      securityMicrogonsActivated: 0n,
    });
  },
  play: ArgonotRewardShortfall.play,
};

export const RevenueCaptureUnavailable: Story = {
  beforeEach: () => {
    setupVaultingPortfolioScenario();
    getArgonBonds().data.frameCapital = {
      ...getArgonBonds().data.frameCapital!,
      vaultSecuritizationPositions: {},
    };
  },
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole('button', { name: /Daily Revenue Capture Unavailable/ }));
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
  play: ArgonotRewardShortfall.play,
};

export const ArgonotInstructionUnavailable: Story = {
  beforeEach: ArgonotGuidanceUnavailable.beforeEach,
  play: ArgonotCaptureDefinition.play,
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
  beforeEach: () => {
    setupVaultingPortfolioScenario();
    const myVault = getMyVault();
    const [liquid, lock] = getBitcoinLocks().getAllLocks();
    liquid.fundedSatoshis = 19_800_000n;
    liquid.securitizedSatoshis = liquid.fundedSatoshis;
    liquid.microgonsAtTargetPerBtc = 12_000_000_000n;
    liquid.fissionedSatoshis = liquid.fundedSatoshis;
    liquid.securitizationCoverageMicrogons = 2_376_000_000n;
    lock.fundedSatoshis = 1_000_000n;
    lock.status = BitcoinLockStatus.LockFunded;
    lock.securitizedSatoshis = lock.fundedSatoshis;
    lock.microgonsAtTargetPerBtc = liquid.microgonsAtTargetPerBtc;
    lock.fissionedSatoshis = 0n;
    lock.securitizationCoverageMicrogons = 0n;
    getBitcoinLocks().getAllLocks = fn(() => [liquid, lock]);
    myVault.data.externalLocks = {};
    myVault.createdVault!.securitizationLocked = liquid.securitizationCoverageMicrogons;
    myVault.createdVault!.securitizationPendingActivation = 0n;
    myVault.createdVault!.totalSatoshis = liquid.fundedSatoshis + lock.fundedSatoshis;
    myVault.createdVault!.securitizedSatoshis = liquid.fundedSatoshis;

    myVault.data.argonotCommitment = {
      heldMicronots: 2_400_000_000n,
      committedMicronots: 2_400_000_000n,
      encumberedMicronots: 0n,
    };
    const capital = getArgonBonds().data.frameCapital!;
    getArgonBonds().data.frameCapital = {
      ...capital,
      vaultSecuritizationPositions: {
        ...capital.vaultSecuritizationPositions,
        [myVault.vaultId!]: {
          ...capital.vaultSecuritizationPositions[myVault.vaultId!],
          activatedSecuritization: myVault.createdVault!.activatedSecuritization(),
          bitcoinLockedMicrogons: getCurrency().priceIndex.getSatoshiPriceInMarketMicrogons(
            myVault.createdVault!.totalSatoshis,
          ),
          argonotSecuritizationInMicrogons: 4_800_000_000n,
        },
      },
    };
  },
  play: async ({ canvasElement }) => {
    await userEvent.hover(within(canvasElement).getByLabelText('Bitcoin exceeds vault capacity'));
    await within(document.body).findAllByRole('tooltip', { hidden: true });
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
        hasSavedVaultSetup: true,
        isServerAdded: true,
        vaultSetup: {
          ...vaultSetup,
          securitizationMicrogons: 2_400_000_000n,
          committedMicronots: 50_000_000n,
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
        hasSavedVaultSetup: true,
        isServerAdded: true,
        vaultSetup: {
          ...vaultSetup,
          securitizationMicrogons: 2_400_000_000n,
          committedMicronots: 50_000_000n,
        },
      },
    });
    useWallets().defaultArgonWallet.availableMicrogons = 2_402_000_000n;
    useWallets().defaultArgonWallet.availableMicronots = 50_000_000n;
  },
};
