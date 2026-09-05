import * as Vue from 'vue';
import { BitcoinFission } from '@argonprotocol/apps-core';
import type { Meta, StoryObj } from '@storybook/vue3-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { TopTab } from '../../../src-vue/interfaces/IConfig.ts';
import type { IBitcoinLiquidSource } from '../../../src-vue/interfaces/IBitcoinLiquidSource.ts';
import BitcoinLiquidCreationOverlay from '../../../src-vue/overlays/BitcoinLiquidCreationOverlay.vue';
import { BitcoinLiquid } from '../../../src-vue/lib/BitcoinLiquid.ts';
import type { IBitcoinLiquidCreatePreview } from '../../../src-vue/lib/txs/BitcoinLiquid.create.ts';
import type { BitcoinLiquidCreationState } from '../../../src-vue/overlays/BitcoinLiquidCreationState.ts';
import { useWallets } from '../../../src-vue/stores/wallets.ts';
import { setupAppScenario } from '../../scenarios/setupAppScenario.ts';

const insuredSources: IBitcoinLiquidSource[] = [
  {
    key: 'atlas',
    cosigner: 'Atlas Operator',
    isMyVault: false,
    unallocatedSatoshis: 30_000_000n,
    maximumLiquidSatoshis: 30_000_000n,
    selectedSatoshis: 30_000_000n,
  },
  {
    key: 'my-vault',
    cosigner: 'My Vault',
    isMyVault: true,
    unallocatedSatoshis: 20_000_000n,
    maximumLiquidSatoshis: 20_000_000n,
    selectedSatoshis: 20_000_000n,
  },
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
  },
} satisfies Meta<{
  state: BitcoinLiquidCreationState;
  liquid?: BitcoinLiquid;
}>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Form: Story = {
  play: async () => {
    const body = within(document.body);

    await waitFor(() => expect(body.getByRole('dialog', { name: 'Create a Bitcoin Liquid' })).toBeVisible());
    await waitFor(() => expect(body.getByText('Vaults')).toBeVisible());
    await expect(body.getByText('2 selected')).toBeVisible();
    await userEvent.hover(body.getByText('Vaults'));
    await waitFor(() => {
      const tooltip = body
        .getAllByText('Selected vaults: Atlas Operator and my Vault.')
        .find(element => element.getAttribute('aria-hidden') !== 'true');
      expect(tooltip).toBeVisible();
    });
    await expect(body.getByText('Choose Amount')).toBeVisible();
    await expect(body.getByText('Collect Argons')).toBeVisible();
    await expect(
      body.getByText(
        /Your Bitcoin Liquid helps stabilize the Argon stablecoin while giving you your Bitcoin’s full market value/,
      ),
    ).toBeVisible();
    await expect(
      body.queryByText(/Bitcoin remains on the Bitcoin blockchain, but it cannot be sent while the Liquid is open/),
    ).not.toBeInTheDocument();
  },
};

export const InMyVault: Story = {
  args: {
    state: {
      ...state,
      sources: [insuredSources[1]!],
    },
  },
  play: async () => {
    const body = within(document.body);

    await waitFor(() => expect(body.getByText('In my Vault')).toBeVisible());
    await expect(body.queryByText('Co-signer')).not.toBeInTheDocument();
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
  play: async () => {
    const body = within(document.body);

    const maxAmountLabel = body.getByText("You're At Max Amount");
    const infoButton = maxAmountLabel.nextElementSibling;
    if (!(infoButton instanceof HTMLElement)) throw new Error('Max amount info trigger was not rendered.');
    await userEvent.hover(infoButton);
    const tooltipText =
      'Your wallet has 0.6 BTC available, but the selected vaults can currently securitize 0.42 BTC for this Liquid.';
    await waitFor(async () => {
      const tooltips = await body.findAllByText(tooltipText);
      await expect(tooltips.some(element => element.getClientRects().length > 0)).toBe(true);
    });
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
  play: async () => {
    const body = within(document.body);
    await expect(
      body.getByText("You don't have Bitcoin available in your wallet.", { exact: false }),
    ).toBeInTheDocument();
    await expect(body.getByRole('button', { name: 'Create Liquid', hidden: true })).toBeDisabled();
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
  play: async () => {
    const body = within(document.body);

    await waitFor(() => expect(body.getByText('Liquid Amount')).toBeVisible());
    await expect(body.getByRole('button', { name: 'Submitting...' })).toBeDisabled();
    await expect(body.queryByText('Creating Liquid...')).not.toBeInTheDocument();
  },
};

export const CreatingOnArgon: Story = {
  args: {
    state: { ...state, stage: 'creating', progressPct: 48 },
  },
  play: async () => {
    const body = within(document.body);

    await waitFor(() => expect(body.getByText('Creating Liquid...')).toBeVisible());
    await expect(body.queryByText('Liquid Amount')).not.toBeInTheDocument();
    await expect(body.queryByRole('button', { name: 'Create Liquid' })).not.toBeInTheDocument();
  },
};

export const TransactionFailed: Story = {
  args: {
    state: { ...state, stage: 'creating', progressPct: 48, errorMessage: 'Transaction dropped.' },
  },
  play: async () => {
    const body = within(document.body);

    await waitFor(() => expect(body.getByText('Transaction dropped.')).toBeVisible());
    await expect(body.getByRole('button', { name: 'Try Again' })).toBeVisible();
    await expect(body.queryByText('Liquid Amount')).not.toBeInTheDocument();
  },
};

export const CollectingArgons: Story = {
  args: {
    liquid: collectingLiquid,
    state: { ...state, stage: 'complete' },
  },
  play: async () => {
    const body = within(document.body);

    await waitFor(() => expect(body.getByRole('img', { name: 'Liquid created' })).toBeVisible());
    await expect(body.getByRole('heading', { name: 'Collect Argons Daily' })).toBeVisible();
    await expect(body.getByText(/₳3,400.00 is expected in each daily payout/)).toBeVisible();
    await expect(body.getByText(/remaining ₳34,000.00 should reach your Internal App Wallet by about/)).toBeVisible();
    await expect(body.queryByText('Expected each day')).not.toBeInTheDocument();
    await expect(body.queryByText('₳34,000.00')).not.toBeInTheDocument();
    await expect(body.getByRole('button', { name: 'Done' })).toBeVisible();
    await expect(body.queryByText('Liquid Amount')).not.toBeInTheDocument();
  },
};

export const FinalCollectionFrame: Story = {
  args: {
    liquid: finalCollectionLiquid,
    state: { ...state, stage: 'complete' },
  },
  play: async () => {
    const body = within(document.body);

    await waitFor(() =>
      expect(body.getByText(/remaining ₳1,500.00 is expected in the next daily payout/)).toBeVisible(),
    );
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
      errorMessage: 'The cosigner no longer has enough securitization available for this amount.',
    },
  },
};
