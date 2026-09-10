import * as Vue from 'vue';
import { BitcoinFission, type Vault } from '@argonprotocol/apps-core';
import type { Meta, StoryObj } from '@storybook/vue3-vite';
import { userEvent, within } from 'storybook/test';
import { TopTab } from '../../../src-vue/interfaces/IConfig.ts';
import type { IBitcoinLiquidSource } from '../../../src-vue/interfaces/IBitcoinLiquidSource.ts';
import BitcoinLiquidCreationOverlay from '../../../src-vue/overlays/BitcoinLiquidCreationOverlay.vue';
import { BitcoinLiquid } from '../../../src-vue/lib/BitcoinLiquid.ts';
import type { IBitcoinLiquidCreatePreview } from '../../../src-vue/lib/txs/BitcoinLiquid.create.ts';
import type { BitcoinLiquidCreationState } from '../../../src-vue/overlays/BitcoinLiquidCreationState.ts';
import { useWallets } from '../../../src-vue/stores/wallets.ts';
import { useFinancials } from '../../../src-vue/stores/financials.ts';
import { getVaults } from '../../../src-vue/stores/vaults.ts';
import { setupAppScenario } from '../../scenarios/setupAppScenario.ts';

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
    vaultName: 'My Vault',
    unallocatedSatoshis: 20_000_000n,
    maximumLiquidSatoshis: 20_000_000n,
    selectedSatoshis: 20_000_000n,
  },
];
const selectableVaults = [
  { vaultId: 7, operatorAccountId: '5AtlasOperator' } as Vault,
  { vaultId: 12, operatorAccountId: '5MyVaultOperator' } as Vault,
];

const collectingFission = new BitcoinFission({
  ownerAccount: '5SyntheticLiquidOwner',
  fissionId: 401,
  liquidId: 401,
  utxoId: 101,
  satoshis: 50_000_000n,
  microgonsAtTargetPerBtc: 68_000_000_000n,
  liquidityPromised: 34_000_000_000n,
  createdAtArgonBlock: 1_200,
  ratchetNumber: 0,
  lastUpdatedArgonBlock: 1_200,
});
collectingFission.pendingMints.push({
  queueIndex: 44,
  fissionId: 401,
  utxoId: 101,
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
  maximumSatoshisByUtxoId: {},
} satisfies IBitcoinLiquidCreatePreview;
const state = {
  stage: 'form',
  sources: insuredSources,
  selectedVaultIds: [7, 12],
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
      const storyKey = Vue.computed(() => {
        return args.state.sources
          .map(
            source =>
              `${source.key}:${source.unallocatedSatoshis}:${source.selectedSatoshis}:${source.maximumLiquidSatoshis}`,
          )
          .join('|');
      });

      return { args, storyKey };
    },
    template: `
      <BitcoinLiquidCreationOverlay :key="storyKey" v-bind="args" />
      <div class="fixed inset-0 z-[10000] cursor-not-allowed" aria-label="Liquid controls are disabled in this fixed preview">
        <span class="pointer-events-none absolute top-4 left-1/2 -translate-x-1/2 rounded bg-slate-900 px-3 py-1.5 text-sm font-semibold text-white shadow">
          Fixed state preview
        </span>
      </div>
    `,
  }),
  beforeEach: () => {
    setupAppScenario({
      selectedTab: TopTab.BitcoinLocks,
      config: { upstreamOperator: { name: 'Atlas Operator', vaultId: 7 } },
    });
    Object.assign(useWallets(), { defaultArgonSpendableMicrogons: 100_000_000n });
    Object.assign(useFinancials(), {
      vaultsIsLoaded: true,
      vaultsActiveRecords: selectableVaults,
    });
    const vaults = getVaults();
    Object.assign(vaults.operatorNamesByVaultId, { 7: 'Atlas Operator', 12: 'My Vault' });
    Object.assign(vaults.vaultsById, Object.fromEntries(selectableVaults.map(vault => [vault.vaultId, vault])));
  },
} satisfies Meta<{
  state: BitcoinLiquidCreationState;
  liquid?: BitcoinLiquid;
}>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Form: Story = {};

export const VaultSelection: Story = {
  args: {
    state: { ...state, stage: 'vaults' },
  },
};

export const VaultExplanation: Story = {
  play: async () => {
    const body = within(document.body);
    await userEvent.hover(body.getByRole('button', { name: /Vaults/ }));
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
  ...VaultCapacityCapped,
  play: async () => {
    const body = within(document.body);
    const maxAmountLabel = body.getByText("You're At Max Amount");
    const infoButton = maxAmountLabel.nextElementSibling;
    if (!(infoButton instanceof HTMLElement)) throw new Error('Max amount info trigger was not rendered.');

    await userEvent.hover(infoButton);
    await body.findByRole('tooltip');
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
