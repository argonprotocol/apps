import * as Vue from 'vue';
import { BitcoinFission } from '@argonprotocol/apps-core';
import type { Meta, StoryObj } from '@storybook/vue3-vite';
import { mocked, userEvent, within } from 'storybook/test';
import { TopTab } from '../../../src-vue/interfaces/IConfig.ts';
import type { IBitcoinLiquidSource } from '../../../src-vue/interfaces/IBitcoinLiquidSource.ts';
import BitcoinLiquidCreationOverlay from '../../../src-vue/overlays/BitcoinLiquidCreationOverlay.vue';
import { BitcoinLiquid } from '../../../src-vue/lib/BitcoinLiquid.ts';
import type { IBitcoinLiquidCreatePreview } from '../../../src-vue/lib/txs/BitcoinLiquid.create.ts';
import type { BitcoinLiquidCreationState } from '../../../src-vue/overlays/BitcoinLiquidCreationState.ts';
import { useWallets } from '../../../src-vue/stores/wallets.ts';
import { useFinancials } from '../../../src-vue/stores/financials.ts';
import { getVaults, retryVaults } from '../../../src-vue/stores/vaults.ts';
import { setupAppScenario } from '../../scenarios/setupAppScenario.ts';
import { createScenarioVault } from '../../scenarios/createScenarioVault.ts';
import { OperationalStepId, useCertificationController } from '../../../src-vue/stores/certificationController.ts';

const isInteractive = Vue.ref(false);

const insuredSources: IBitcoinLiquidSource[] = [
  {
    key: 'atlas',
    vaultId: 7,
    vaultName: 'Atlas Operator',
    unallocatedSatoshis: 30_000_000n,
    maximumLiquidSatoshis: 30_000_000n,
    selectedSatoshis: 30_000_000n,
  },
  {
    key: 'my-vault',
    vaultId: 12,
    vaultName: 'Your Vault',
    unallocatedSatoshis: 20_000_000n,
    maximumLiquidSatoshis: 20_000_000n,
    selectedSatoshis: 20_000_000n,
  },
];
const selectableVaults = [
  createScenarioVault({ vaultId: 7, operatorAccountId: '5AtlasOperator' }),
  createScenarioVault({ vaultId: 12, operatorAccountId: '5MyVaultOperator' }),
];

const collectingFission = new BitcoinFission({
  ownerAccount: '5SyntheticLiquidOwner',
  fissionId: 401,
  liquidId: 401,
  lockId: 101,
  satoshis: 50_000_000n,
  microgonsAtTargetPerBtc: 68_000_000_000n,
  liquidityPromised: 34_000_000_000n,
  createdAtArgonBlock: 1_200,
  ratchetNumber: 0,
  lastUpdatedArgonBlock: 1_200,
});
collectingFission.pendingMints.push({
  queueIndex: 44n,
  fissionId: 401,
  lockId: 101,
  ownerAccount: collectingFission.ownerAccount,
  remainingAmount: 34_000_000_000n,
  maxAmountPerFrame: 3_400_000_000n,
});
const collectingLiquid = BitcoinLiquid.create({ liquidId: 401, fissions: [collectingFission] });
const finalCollectionFission = new BitcoinFission(collectingFission);
finalCollectionFission.pendingMints.push({
  ...collectingFission.pendingMints[0],
  remainingAmount: 1_500_000_000n,
});
const finalCollectionLiquid = BitcoinLiquid.create({ liquidId: 401, fissions: [finalCollectionFission] });
const preview = {
  microgonsAtTargetPerBtc: 68_000_000_000n,
  microgonsAtTargetPerBtcTick: 10_000,
  liquidityMicrogons: 34_000_000_000n,
  totalSecurityFeeMicrogons: 12_500_000n,
  securityFeeMicrogons: 12_500_000n,
  couponCreditMicrogons: 0n,
  maximumSatoshisByLockId: {},
} satisfies IBitcoinLiquidCreatePreview;
const state = {
  stage: 'form',
  sources: insuredSources,
  selectedVaultIds: [7, 12],
  vaultCapacity: {
    status: 'ready',
    usableSatoshisByVaultId: { 7: 30_000_000n, 12: 20_000_000n },
  },
  preview,
  isSubmitting: false,
  progressPct: 0,
  progressLabel: '',
  errorMessage: '',
  treasuryCertificationRequiredSatoshis: 20_000_000n,
} satisfies BitcoinLiquidCreationState;

const meta = {
  title: 'Bitcoin/Create Liquid',
  component: BitcoinLiquidCreationOverlay,
  args: {
    state,
  },
  render: args => ({
    components: { BitcoinLiquidCreationOverlay },
    setup() {
      Vue.onMounted(() => document.addEventListener('keydown', preventFixedPreviewKeyboard, true));
      Vue.onUnmounted(() => document.removeEventListener('keydown', preventFixedPreviewKeyboard, true));
      const storyKey = Vue.computed(() => {
        return args.state.sources
          .map(
            source =>
              `${source.key}:${source.unallocatedSatoshis}:${source.selectedSatoshis}:${source.maximumLiquidSatoshis}`,
          )
          .join('|');
      });

      return { args, storyKey, isInteractive };

      function preventFixedPreviewKeyboard(event: KeyboardEvent) {
        if (isInteractive.value) return;
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    },
    template: `
      <BitcoinLiquidCreationOverlay :key="storyKey" v-bind="args" />
      <div v-if="!isInteractive" class="pointer-events-auto fixed inset-0 z-[10000] cursor-not-allowed" aria-label="Liquid controls are disabled in this fixed preview">
        <span class="pointer-events-none absolute top-4 left-1/2 -translate-x-1/2 rounded bg-slate-900 px-3 py-1.5 text-sm font-semibold text-white shadow">
          Fixed state preview
        </span>
      </div>
    `,
  }),
  beforeEach: () => {
    isInteractive.value = false;
    setupAppScenario({
      selectedTab: TopTab.BitcoinLocks,
      config: { upstreamOperator: { name: 'Atlas Operator', vaultId: 7 } },
    });
    Object.assign(useWallets(), { defaultArgonSpendableMicrogons: 100_000_000n });
    Object.assign(useFinancials(), {
      vaultsActiveRecords: selectableVaults,
    });
    const vaults = getVaults();
    Object.assign(vaults.operatorNamesByVaultId, { 7: 'Atlas Operator', 12: 'Your Vault' });
    Object.assign(vaults.vaultsById, Object.fromEntries(selectableVaults.map(vault => [vault.vaultId, vault])));
  },
} satisfies Meta<{
  state: BitcoinLiquidCreationState;
  liquid?: BitcoinLiquid;
}>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Form: Story = {};

export const LiquidAmountGuide: Story = {
  args: {
    state: {
      ...state,
      treasuryCertificationRequiredSatoshis: 10_000_000n,
      preview: { ...preview, liquidityMicrogons: 6_800_000_000n },
    },
  },
  beforeEach: () => {
    useCertificationController().activeGuideId = OperationalStepId.LiquidLock;
    isInteractive.value = true;
  },
  play: () => {
    isInteractive.value = false;
  },
};

export const LiquidCertificationAmountUnavailableGuide: Story = {
  ...LiquidAmountGuide,
  args: { state: { ...state, treasuryCertificationRequiredSatoshis: 60_000_000n } },
};

export const LiquidCertificationAmountLoading: Story = {
  args: { state: { ...state, preview: undefined, treasuryCertificationRequiredSatoshis: 0n } },
  beforeEach: () => {
    useCertificationController().activeGuideId = OperationalStepId.LiquidLock;
  },
};

export const LiquidReviewAndCreateGuide: Story = {
  ...LiquidAmountGuide,
  play: async () => {
    const body = within(document.body);
    await userEvent.click(await body.findByRole('button', { name: 'Next' }));
    isInteractive.value = false;
  },
};

export const LiquidMinimumCertificationReviewGuide: Story = {
  ...LiquidReviewAndCreateGuide,
  args: { state: { ...state, treasuryCertificationRequiredSatoshis: 50_000n } },
};

export const LiquidVaultSelectionGuide: Story = {
  ...LiquidAmountGuide,
  args: { state: { ...state, stage: 'vaults' } },
};

export const LiquidSubmittingGuide: Story = {
  args: { state: { ...state, isSubmitting: true } },
  beforeEach: () => {
    useCertificationController().activeGuideId = OperationalStepId.LiquidLock;
  },
};

export const LiquidCreatingGuide: Story = {
  args: { state: { ...state, stage: 'creating', progressPct: 48 } },
  beforeEach: () => {
    useCertificationController().activeGuideId = OperationalStepId.LiquidLock;
  },
};

export const LiquidRetryGuide: Story = {
  ...LiquidAmountGuide,
  args: { state: { ...state, stage: 'creating', progressPct: 48, errorMessage: 'Transaction dropped.' } },
};

export const LiquidCompleteGuide: Story = {
  ...LiquidAmountGuide,
  args: { state: { ...state, stage: 'complete' }, liquid: collectingLiquid },
};

export const LiquidCompleteWithoutScheduleGuide: Story = {
  ...LiquidAmountGuide,
  args: {
    state: { ...state, stage: 'complete', errorMessage: 'Reopen this Liquid to check its collection schedule.' },
  },
};

export const VaultSelection: Story = {
  args: {
    state: { ...state, stage: 'vaults' },
  },
};

export const VaultSelectionLoading: Story = {
  args: { state: { ...state, stage: 'vaults' } },
  beforeEach: () => {
    Object.assign(getVaults().currentState, { isLoaded: false, isLoading: true });
  },
};

export const VaultSelectionCapacityCapped: Story = {
  args: {
    state: {
      ...state,
      stage: 'vaults',
      vaultCapacity: { status: 'ready', usableSatoshisByVaultId: { 7: 12_000_000n, 12: 20_000_000n } },
    },
  },
};

export const VaultSelectionNoCapacity: Story = {
  args: {
    state: {
      ...state,
      stage: 'vaults',
      vaultCapacity: { status: 'ready', usableSatoshisByVaultId: { 7: 0n, 12: 0n } },
    },
  },
};

export const VaultSelectionCapacityLoading: Story = {
  args: {
    state: { ...state, stage: 'vaults', vaultCapacity: { status: 'loading' } },
  },
};

export const VaultSelectionCapacityFailed: Story = {
  args: {
    state: {
      ...state,
      stage: 'vaults',
      vaultCapacity: { status: 'error', errorMessage: 'Unable to check vault securitization.' },
    },
  },
};

export const VaultSelectionCapacityRefreshing: Story = {
  args: {
    state: {
      ...state,
      stage: 'vaults',
      vaultCapacity: { ...state.vaultCapacity, status: 'loading' },
    },
  },
};

export const VaultSelectionCapacityRefreshFailed: Story = {
  args: {
    state: {
      ...state,
      stage: 'vaults',
      vaultCapacity: {
        ...state.vaultCapacity,
        status: 'error',
        errorMessage: 'Unable to check vault securitization.',
      },
    },
  },
};

export const VaultSelectionFailed: Story = {
  args: { state: { ...state, stage: 'vaults' } },
  beforeEach: () => {
    Object.assign(getVaults().currentState, { isLoaded: false, error: 'Unable to connect to the mainchain.' });
  },
};

export const VaultSelectionRetried: Story = {
  args: { state: { ...state, stage: 'vaults' } },
  beforeEach: () => {
    Object.assign(getVaults().currentState, { isLoaded: false, error: 'Unable to connect to the mainchain.' });
    mocked(retryVaults).mockImplementation(async () => {
      Object.assign(getVaults().currentState, { isLoaded: true, isLoading: false, error: '' });
    });
  },
  play: async () => {
    isInteractive.value = true;
    await userEvent.click(within(document.body).getByRole('button', { name: 'Retry' }));
    isInteractive.value = false;
  },
};

export const VaultSelectionRefreshFailed: Story = {
  args: { state: { ...state, stage: 'vaults' } },
  beforeEach: () => {
    getVaults().currentState.error = 'Unable to refresh vaults. Previously loaded vaults are shown.';
  },
};

export const VaultSelectionEmpty: Story = {
  args: { state: { ...state, stage: 'vaults', sources: [], selectedVaultIds: [] } },
};

export const VaultExplanation: Story = {
  play: async () => {
    isInteractive.value = true;
    const body = within(document.body);
    await userEvent.hover(body.getByRole('button', { name: /Vaults/ }));
    isInteractive.value = false;
    await body.findAllByRole('tooltip', { hidden: true });
  },
};

export const SelectedVaultAmount: Story = {
  args: {
    state: {
      ...state,
      selectedVaultIds: [7],
      sources: [insuredSources[0]!, { ...insuredSources[1]!, selectedSatoshis: 0n }],
    },
  },
};

export const InMyVault: Story = {
  args: {
    state: {
      ...state,
      sources: [insuredSources[1]!],
      selectedVaultIds: [12],
    },
  },
};

export const VaultCapacityCapped: Story = {
  args: {
    state: {
      ...state,
      sources: [
        insuredSources[0]!,
        {
          ...insuredSources[1],
          unallocatedSatoshis: 30_000_000n,
          maximumLiquidSatoshis: 12_000_000n,
          selectedSatoshis: 12_000_000n,
        },
      ],
      preview: {
        ...preview,
        liquidityMicrogons: 40_800_000_000n,
        totalSecurityFeeMicrogons: 102_500_000n,
        securityFeeMicrogons: 27_500_000n,
        couponCreditMicrogons: 75_000_000n,
      },
    },
  },
};

export const VaultCapacityExplanation: Story = {
  args: {
    state: {
      ...state,
      selectedVaultIds: [7],
      sources: [
        {
          ...insuredSources[0]!,
          unallocatedSatoshis: 50_000_000n,
          maximumLiquidSatoshis: 1_324_999n,
          selectedSatoshis: 1_324_999n,
        },
      ],
      preview: { ...preview, liquidityMicrogons: 900_999_320n },
    },
  },
};

export const BelowVaultCapacity: Story = {
  args: {
    state: {
      ...state,
      selectedVaultIds: [7],
      sources: [{ ...insuredSources[0]!, maximumLiquidSatoshis: 25_000_000n, selectedSatoshis: 20_000_000n }],
      preview: { ...preview, liquidityMicrogons: 13_600_000_000n },
    },
  },
};

export const InsufficientWalletFunds: Story = {
  beforeEach: () => {
    Object.assign(useWallets(), { defaultArgonSpendableMicrogons: 5_000_000n });
  },
};

export const NoBitcoinAvailable: Story = {
  args: {
    state: {
      ...state,
      sources: insuredSources.map(source => ({
        ...source,
        unallocatedSatoshis: 0n,
        maximumLiquidSatoshis: 0n,
        selectedSatoshis: 0n,
      })),
    },
  },
};

export const BelowTreasuryCertificationRequirement: Story = {
  args: {
    state: { ...state, treasuryCertificationRequiredSatoshis: 60_000_000n },
  },
};

export const Submitting: Story = {
  args: {
    state: { ...state, isSubmitting: true },
  },
};

export const CreatingOnArgon: Story = {
  args: {
    state: { ...state, stage: 'creating', progressPct: 48 },
  },
};

export const TransactionFailed: Story = {
  args: {
    state: { ...state, stage: 'creating', progressPct: 48, errorMessage: 'Transaction dropped.' },
  },
};

export const TransactionRejected: Story = {
  args: {
    state: {
      ...state,
      stage: 'creating',
      progressPct: 48,
      errorMessage: 'The requested target-normalized BTC value is not present in recent price history.',
    },
  },
};

export const ExistingLiquidsPriceUnavailable: Story = {
  args: {
    state: {
      ...state,
      preview: undefined,
      errorMessage:
        'Existing Liquids need a Bitcoin price that is no longer available. Reduce the amount to Bitcoin already insured, or wait for an eligible price.',
    },
  },
};

export const InsufficientLiquidCoverage: Story = {
  args: {
    state: {
      ...state,
      preview: undefined,
      errorMessage:
        'This Bitcoin cannot cover the existing and selected Liquids at the current price. Reduce the amount or wait for an eligible price.',
    },
  },
};

export const CollectingArgons: Story = {
  args: {
    liquid: collectingLiquid,
    state: { ...state, stage: 'complete' },
  },
};

export const FinalCollectionFrame: Story = {
  args: {
    liquid: finalCollectionLiquid,
    state: { ...state, stage: 'complete' },
  },
};

export const CollectionScheduleUnavailable: Story = {
  args: {
    state: {
      ...state,
      stage: 'complete',
      errorMessage:
        'The Liquid was created, but its minting schedule is not available yet. Open it from Bitcoin Liquids when it appears.',
    },
  },
};

export const BatchFailed: Story = {
  args: {
    state: {
      ...state,
      errorMessage: 'The selected vault no longer has enough securitization available for this amount.',
    },
  },
};
