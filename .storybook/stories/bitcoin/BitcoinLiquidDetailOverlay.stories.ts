import { BitcoinFission } from '@argonprotocol/apps-core';
import type { Meta, StoryObj } from '@storybook/vue3-vite';
import BigNumber from 'bignumber.js';
import * as Vue from 'vue';
import { expect, fn, mocked, userEvent, waitFor, within } from 'storybook/test';

import { TopTab } from '../../../src-vue/interfaces/IConfig.ts';
import type { IBitcoinLockSummary } from '../../../src-vue/interfaces/IBitcoinLockSummary.ts';
import type { IBitcoinSecuritizationTerm } from '../../../src-vue/interfaces/IBitcoinSecuritizationTerm.ts';
import { createFinancialPosition } from '../../../src-vue/interfaces/IFinancialPosition.ts';
import { BitcoinLiquid } from '../../../src-vue/lib/BitcoinLiquid.ts';
import { reduceFinancialPositions } from '../../../src-vue/lib/financials/index.ts';
import type { TransactionInfo } from '../../../src-vue/lib/TransactionInfo.ts';
import { BitcoinLiquidClose } from '../../../src-vue/lib/txs/BitcoinLiquid.close.ts';
import { BitcoinLiquidRatchet } from '../../../src-vue/lib/txs/BitcoinLiquid.ratchet.ts';
import type { IBitcoinLiquidRatchetPreview } from '../../../src-vue/lib/txs/BitcoinLiquid.ratchet.ts';
import BitcoinLiquidDetailOverlay from '../../../src-vue/overlays/BitcoinLiquidDetailOverlay.vue';
import { getBitcoinTransactionOperations } from '../../../src-vue/stores/bitcoin.ts';
import { getCurrency } from '../../../src-vue/stores/currency.ts';
import { useFinancials } from '../../../src-vue/stores/financials.ts';
import { getMainchainClient } from '../../../src-vue/stores/mainchain.ts';
import { getVaults } from '../../../src-vue/stores/vaults.ts';
import { getWalletKeys } from '../../../src-vue/stores/wallets.ts';
import { setupAppScenario } from '../../scenarios/setupAppScenario.ts';

const fissions = [
  new BitcoinFission({
    ownerAccount: 'owner-account',
    fissionId: 1,
    liquidId: 1,
    utxoId: 101,
    satoshis: 30_000_000n,
    microgonsAtTargetPerBtc: 68_000_000_000n,
    liquidityPromised: 20_400_000_000n,
    createdAtArgonBlock: 12_400,
    ratchetNumber: 2,
    lastUpdatedArgonBlock: 18_200,
    ratchets: [
      {
        source: 'fission',
        sourceRatchetIndex: 0,
        ratchetNumber: 0,
        microgonsAtTargetPerBtc: 64_000_000_000n,
        liquidityPromised: 19_200_000_000n,
        amountMinted: 19_200_000_000n,
        amountBurned: 0n,
        mintPending: 0n,
        txFee: 180_000n,
        blockNumber: 12_400,
        blockTime: new Date('2026-04-03T15:00:00Z'),
        extrinsicIndex: 2,
      },
      {
        source: 'fission',
        sourceRatchetIndex: 1,
        ratchetNumber: 1,
        microgonsAtTargetPerBtc: 68_000_000_000n,
        liquidityPromised: 20_400_000_000n,
        amountMinted: 1_200_000_000n,
        amountBurned: 0n,
        mintPending: 0n,
        txFee: 190_000n,
        blockNumber: 18_200,
        blockTime: new Date('2026-07-18T11:30:00Z'),
        extrinsicIndex: 1,
      },
    ],
  }),
  new BitcoinFission({
    ownerAccount: 'owner-account',
    fissionId: 2,
    liquidId: 1,
    utxoId: 202,
    satoshis: 20_000_000n,
    microgonsAtTargetPerBtc: 68_000_000_000n,
    liquidityPromised: 13_600_000_000n,
    createdAtArgonBlock: 12_400,
    ratchetNumber: 2,
    lastUpdatedArgonBlock: 18_200,
    ratchets: [
      {
        source: 'fission',
        sourceRatchetIndex: 0,
        ratchetNumber: 0,
        microgonsAtTargetPerBtc: 64_000_000_000n,
        liquidityPromised: 12_800_000_000n,
        amountMinted: 12_800_000_000n,
        amountBurned: 0n,
        mintPending: 0n,
        txFee: 180_000n,
        blockNumber: 12_400,
        blockTime: new Date('2026-04-03T15:00:00Z'),
        extrinsicIndex: 2,
      },
      {
        source: 'fission',
        sourceRatchetIndex: 1,
        ratchetNumber: 1,
        microgonsAtTargetPerBtc: 68_000_000_000n,
        liquidityPromised: 13_600_000_000n,
        amountMinted: 800_000_000n,
        amountBurned: 0n,
        mintPending: 0n,
        txFee: 190_000n,
        blockNumber: 18_200,
        blockTime: new Date('2026-07-18T11:30:00Z'),
        extrinsicIndex: 1,
      },
    ],
  }),
];

const securitizationTerms: IBitcoinSecuritizationTerm[] = [
  {
    utxoId: 101,
    termIndex: 0,
    origin: 'created',
    startTick: 0,
    startBlockNumber: 12_400,
    startExtrinsicIndex: 2,
    securitizedSatoshis: 30_000_000n,
    cumulativeNetSecurityFee: 4_000_000n,
    addedNetSecurityFee: 4_000_000n,
  },
  {
    utxoId: 202,
    termIndex: 0,
    origin: 'created',
    startTick: 0,
    startBlockNumber: 12_400,
    startExtrinsicIndex: 2,
    securitizedSatoshis: 20_000_000n,
    cumulativeNetSecurityFee: 2_750_000n,
    addedNetSecurityFee: 2_750_000n,
  },
  {
    utxoId: 101,
    termIndex: 1,
    origin: 'resecuritized',
    startTick: 0,
    startBlockNumber: 18_200,
    startExtrinsicIndex: 1,
    securitizedSatoshis: 30_000_000n,
    cumulativeNetSecurityFee: 5_600_000n,
    addedNetSecurityFee: 1_600_000n,
  },
  {
    utxoId: 202,
    termIndex: 1,
    origin: 'resecuritized',
    startTick: 0,
    startBlockNumber: 18_200,
    startExtrinsicIndex: 1,
    securitizedSatoshis: 20_000_000n,
    cumulativeNetSecurityFee: 3_850_000n,
    addedNetSecurityFee: 1_100_000n,
  },
];

const creationOnlyFissions = fissions.map(
  fission => new BitcoinFission({ ...fission, ratchets: fission.ratchets.slice(0, 1) }),
);
const downRatchetFissions = fissions.map(fission => {
  const microgonsAtTargetPerBtc = 60_000_000_000n;
  const liquidityPromised = (fission.satoshis * microgonsAtTargetPerBtc) / 100_000_000n;
  return new BitcoinFission({
    ...fission,
    microgonsAtTargetPerBtc,
    liquidityPromised,
    ratchetNumber: 3,
    lastUpdatedArgonBlock: 20_100,
    ratchets: [
      ...fission.ratchets,
      {
        source: 'fission',
        sourceRatchetIndex: 2,
        ratchetNumber: 2,
        microgonsAtTargetPerBtc,
        liquidityPromised,
        amountMinted: liquidityPromised,
        amountBurned: fission.liquidityPromised,
        mintPending: 0n,
        txFee: 210_000n,
        blockNumber: 20_100,
        blockTime: new Date('2026-08-08T09:15:00Z'),
        extrinsicIndex: 3,
      },
    ],
  });
});
const fullHistoryFissions = downRatchetFissions.map(fission => {
  const microgonsAtTargetPerBtc = 66_000_000_000n;
  const liquidityPromised = (fission.satoshis * microgonsAtTargetPerBtc) / 100_000_000n;
  return new BitcoinFission({
    ...fission,
    microgonsAtTargetPerBtc,
    liquidityPromised,
    ratchetNumber: 4,
    lastUpdatedArgonBlock: 22_300,
    ratchets: [
      ...fission.ratchets,
      {
        source: 'fission',
        sourceRatchetIndex: 3,
        ratchetNumber: 3,
        microgonsAtTargetPerBtc,
        liquidityPromised,
        amountMinted: liquidityPromised - fission.liquidityPromised,
        amountBurned: 0n,
        mintPending: 0n,
        txFee: 220_000n,
        blockNumber: 22_300,
        blockTime: new Date('2026-08-21T17:45:00Z'),
        extrinsicIndex: 1,
      },
    ],
  });
});

const defaultRatchetPreview: IBitcoinLiquidRatchetPreview = {
  liquidId: 1,
  fissionIds: [1, 2],
  skippedFissionIds: [],
  sourceLiquidity: 34_000_000_000n,
  newLiquidity: 35_600_000_000n,
  amountToMint: 1_600_000_000n,
  amountToBurn: 0n,
  lockChanges: [],
  errors: [],
  canRatchet: true,
};
const unavailableRatchetPreview: IBitcoinLiquidRatchetPreview = {
  ...defaultRatchetPreview,
  newLiquidity: defaultRatchetPreview.sourceLiquidity,
  amountToMint: 0n,
  canRatchet: false,
};
const downRatchetPreview: IBitcoinLiquidRatchetPreview = {
  ...defaultRatchetPreview,
  newLiquidity: 30_000_000_000n,
  amountToMint: 30_000_000_000n,
  amountToBurn: 30_000_000_000n,
};

let liquid: BitcoinLiquid;

function setupDetails(
  args: {
    ratchetPercent?: number;
    isRatchetAvailable?: boolean;
    isRatchetLoading?: boolean;
    isRatcheting?: boolean;
    ratchetProgressPct?: number;
    ratchetProgressLabel?: string;
    ratchetPreview?: IBitcoinLiquidRatchetPreview;
    ratchetRequiredWalletBalanceMicrogons?: bigint;
    ratchetAvailableWalletBalanceMicrogons?: bigint;
    ratchetUnavailableReason?: string;
    ratchetQuoteError?: string;
    pendingLiquidity?: bigint;
    pendingMintPerFrame?: bigint;
    myVaultId?: number;
    closeQuoteDelayMs?: number;
    isClosing?: boolean;
    closeProgressPct?: number;
    closeProgressLabel?: string;
    closeError?: string;
    closeQuoteError?: string;
    closeFeeMicrogons?: bigint;
    closeAvailableWalletBalanceMicrogons?: bigint;
    fissions?: BitcoinFission[];
    displayLiquidWithoutTerms?: boolean;
  } = {},
) {
  setupAppScenario({ selectedTab: TopTab.BitcoinLocks, myVaultId: args.myVaultId });
  getCurrency().priceIndex = Vue.shallowReactive(getCurrency().priceIndex);
  const ratchetPercent = args.ratchetPercent ?? 4.75;
  const ratchetRate = BigInt(Math.round(68_000_000_000 * (1 + ratchetPercent / 100)));
  getCurrency().priceIndex.btcUsdPrice = BigNumber(ratchetRate.toString()).dividedBy(1_000_000);

  const scenarioFissions = (args.fissions ?? fissions).map(fission => {
    const clone = new BitcoinFission({ ...fission });
    clone.pendingMints.splice(0);
    return clone;
  });
  const pendingLiquidity = args.pendingLiquidity ?? 6_800_000_000n;
  if (pendingLiquidity) {
    scenarioFissions[0].pendingMints.push({
      queueIndex: 1,
      fissionId: scenarioFissions[0].fissionId,
      utxoId: scenarioFissions[0].utxoId,
      ownerAccount: scenarioFissions[0].ownerAccount,
      remainingAmount: pendingLiquidity,
      maxAmountPerFrame: args.pendingMintPerFrame ?? 680_000_000n,
    });
  }

  const financialLiquid = BitcoinLiquid.create({
    liquidId: scenarioFissions[0].liquidId,
    fissions: scenarioFissions,
    terms: securitizationTerms,
  });
  liquid = args.displayLiquidWithoutTerms
    ? BitcoinLiquid.create({ liquidId: scenarioFissions[0].liquidId, fissions: scenarioFissions })
    : financialLiquid;
  const lockSummaries = [
    {
      utxoId: 101,
      satoshis: 30_000_000n,
      unlockAmount: 20_400_000_000n,
      record: { vaultId: 11 },
    },
    {
      utxoId: 202,
      satoshis: 20_000_000n,
      unlockAmount: 13_600_000_000n,
      record: { vaultId: 22 },
    },
  ] as IBitcoinLockSummary[];
  const position = createFinancialPosition(
    'bitcoin-liquid',
    {
      id: 'bitcoin-liquid:1',
      label: 'Bitcoin Liquid 1',
      lifecycle: 'active',
      liquidId: 1,
      liquid: financialLiquid,
      locks: lockSummaries.map(summary => summary.record),
      insuranceCost: 12_000_000n,
      transactionFees: 500_000n,
      totalFees: 12_500_000n,
      receivedLiquidity: liquid.receivedLiquidity,
      pendingLiquidity: liquid.pendingLiquidity,
      repaymentAmount: 34_000_000_000n,
      totalReturn: 40.4,
      startedAt: new Date('2026-04-03T15:00:00Z'),
    },
    {
      currentValue: 0n,
      investedCost: liquid.liquidityPromised,
      paidIncome: 0n,
      settledPrincipalValue: 0n,
    },
  );
  mocked(useFinancials).mockReturnValue(
    Vue.reactive({
      financialPositionAggregate: reduceFinancialPositions([
        {
          group: 'bitcoin',
          state: 'ready',
          positions: [position],
          observation: { observedAt: new Date('2026-08-21T17:45:00Z'), blockNumber: 22_300 },
        },
      ]),
      bitcoinLockDisplayRecords: lockSummaries,
    }) as unknown as ReturnType<typeof useFinancials>,
  );
  mocked(getVaults, { partial: true }).mockReturnValue({
    operatorNamesByVaultId: Vue.reactive({
      11: 'Atlas Operator',
      22: 'Meridian Vault',
    }),
  });
  const isRatchetAvailable = args.isRatchetAvailable ?? false;
  const unavailableReason =
    args.ratchetUnavailableReason ?? 'No locked Bitcoin has reached the minimum 5% price change.';
  const preview = {
    ...(args.ratchetPreview ?? (isRatchetAvailable ? defaultRatchetPreview : unavailableRatchetPreview)),
    canRatchet: isRatchetAvailable,
    errors: isRatchetAvailable ? [] : [unavailableReason],
  };
  const ratchetRequiredWalletBalanceMicrogons = args.ratchetRequiredWalletBalanceMicrogons ?? 3_500_000n;
  let ratchetQuoteAttempts = 0;
  const bitcoinLiquidRatchet = Object.assign(Object.create(BitcoinLiquidRatchet.prototype), {
    getPendingRatchetTxInfo: fn(() =>
      args.isRatcheting
        ? createPendingTransaction(args.ratchetProgressPct ?? 0, args.ratchetProgressLabel ?? '')
        : undefined,
    ),
    previewRatchet: fn(async () => preview),
    prepare: fn(async () => {
      if (args.ratchetQuoteError && ratchetQuoteAttempts++ === 0) throw new Error(args.ratchetQuoteError);
      return {
        client: { consts: { balances: { existentialDeposit: { toBigInt: () => 0n } } } },
        includeExistentialDeposit: false,
        unavailableBalance: ratchetRequiredWalletBalanceMicrogons - 2_500_000n,
        txFeePlusTip: 2_500_000n,
        availableBalance: args.ratchetAvailableWalletBalanceMicrogons ?? 10_000_000n,
      };
    }),
    submit: fn(async () => createPendingTransaction(0, 'Preparing transaction...')),
  });
  let closeQuoteAttempts = 0;
  const bitcoinLiquidClose = Object.assign(Object.create(BitcoinLiquidClose.prototype), {
    getPendingLiquidTxInfo: fn(() => {
      if (args.closeError) return createPendingTransaction(0, '', args.closeError);
      if (args.isClosing) {
        return createPendingTransaction(args.closeProgressPct ?? 0, args.closeProgressLabel ?? '');
      }
    }),
    prepare: fn(async () => {
      if (args.closeQuoteDelayMs) await new Promise(resolve => setTimeout(resolve, args.closeQuoteDelayMs));
      if (args.closeQuoteError && closeQuoteAttempts++ === 0) throw new Error(args.closeQuoteError);
      return {
        client: { consts: { balances: { existentialDeposit: { toBigInt: () => 0n } } } },
        unavailableBalance: 33_999_998_867n,
        txFeePlusTip: args.closeFeeMicrogons ?? 500_000n,
        availableBalance: args.closeAvailableWalletBalanceMicrogons ?? 40_000_000_000n,
      };
    }),
    submit: fn(async () => createPendingTransaction(0, 'Preparing transaction...')),
  });
  mocked(getBitcoinTransactionOperations, { partial: true }).mockReturnValue({
    bitcoinLiquidClose,
    bitcoinLiquidRatchet,
  });
  if (args.isRatchetLoading) {
    mocked(getMainchainClient).mockReturnValue(new Promise(() => undefined));
  } else {
    mocked(getMainchainClient).mockResolvedValue({
      query: { bitcoinLocks: { microgonPerBtcHistory: fn(async () => [[0, ratchetRate]]) } },
    } as never);
  }
  Object.assign(getWalletKeys(), {
    getLiquidLockingKeypair: fn(async () => ({ address: 'owner-account' }) as never),
  });
}

function createPendingTransaction(progressPct: number, progressMessage: string, error?: string): TransactionInfo {
  return {
    subscribeToProgress: fn((callback: Parameters<TransactionInfo['subscribeToProgress']>[0]) => {
      void callback(
        { progressPct, progressMessage, confirmations: 0, expectedConfirmations: 4, isMaxed: false },
        error ? new Error(error) : undefined,
      );
      return fn();
    }),
    waitForPostProcessing: new Promise<void>(() => undefined),
    getStatus: fn(() => ({ error: undefined })),
  } as unknown as TransactionInfo;
}

const meta = {
  title: 'Bitcoin/Liquid Details',
  render: () => ({
    components: { BitcoinLiquidDetailOverlay },
    setup() {
      return { liquid };
    },
    template: '<BitcoinLiquidDetailOverlay :liquid="liquid" />',
  }),
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

export const Active: Story = {
  beforeEach: () => setupDetails({ isRatchetAvailable: true }),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body);
    await expect(canvas.findByText('TOTAL FEES')).resolves.toBeTruthy();
    await expect(canvas.findByText(/12.50/)).resolves.toBeTruthy();
    await expect(canvas.findByText('Recorded costs to date')).resolves.toBeTruthy();
    await expect(canvas.findByText('RETURN TO DATE')).resolves.toBeTruthy();
    await expect(canvas.findByText('40.4%')).resolves.toBeTruthy();
    await expect(canvas.findByText('Since this Liquid opened')).resolves.toBeTruthy();
    await userEvent.hover(canvas.getByRole('button', { name: /₳6,800.00 still minting/ }));
    await expect(canvas.findByRole('heading', { name: 'Pending mint schedule' })).resolves.toBeTruthy();
    await expect(canvas.findAllByText('Next daily payout')).resolves.toBeTruthy();
    await expect(canvas.findAllByText('₳680.00')).resolves.toBeTruthy();
    await expect(canvas.findAllByText(/10 daily payouts remaining/)).resolves.toBeTruthy();
    await expect(canvas.queryByText(/12.00 insurance/)).not.toBeInTheDocument();
    await expect(canvas.findByRole('heading', { name: 'RATCHET OPPORTUNITY' })).resolves.toBeTruthy();
    await expect(canvas.findByRole('heading', { name: 'HISTORY' })).resolves.toBeTruthy();
    await expect(canvas.findByText(/Would unlock/)).resolves.toBeTruthy();
    await userEvent.hover(canvas.getByRole('button', { name: 'What is a ratchet?' }));
    const explanations = await canvas.findAllByText(/A ratchet updates the Liquid to Bitcoin's latest price/);
    await expect(explanations.some(element => element.getClientRects().length > 0)).toBe(true);
  },
};

export const PartialRatchetAvailable: Story = {
  beforeEach: () => setupDetails({ ratchetPercent: 2.55, isRatchetAvailable: true }),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body);
    await userEvent.click(canvas.getByRole('button', { name: 'Start Ratchet' }));
    await expect(canvas.findByRole('heading', { name: 'Review this ratchet' })).resolves.toBeTruthy();
    await expect(canvas.findByText(/additional liquidity at the new Bitcoin price/)).resolves.toBeTruthy();
    await expect(canvas.findByText(/This ratchet costs/)).resolves.toBeTruthy();
    const confirmButton = await canvas.findByRole('button', { name: 'Confirm Ratchet' });
    await waitFor(async () => {
      await expect(confirmButton.getBoundingClientRect().top).toBeGreaterThanOrEqual(0);
      await expect(confirmButton.getBoundingClientRect().bottom).toBeLessThanOrEqual(
        canvasElement.ownerDocument.documentElement.clientHeight,
      );
    });
  },
};

export const DownRatchetAvailable: Story = {
  beforeEach: () =>
    setupDetails({
      ratchetPercent: -11.76,
      isRatchetAvailable: true,
      ratchetPreview: downRatchetPreview,
      ratchetRequiredWalletBalanceMicrogons: 30_003_500_000n,
      ratchetAvailableWalletBalanceMicrogons: 35_000_000_000n,
    }),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body);
    await userEvent.click(canvas.getByRole('button', { name: 'Start Ratchet' }));
    await expect(canvas.findByText(/A downward ratchet requires/)).resolves.toBeTruthy();
  },
};

export const PriceAtPar: Story = {
  beforeEach: () => setupDetails({ ratchetPercent: 0, pendingLiquidity: 0n }),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body);
    const headings = await canvas.findAllByText('LIQUIDITY RECEIVED');
    await expect(headings.some(heading => heading.getClientRects().length > 0)).toBe(true);
    await expect(canvas.findByText('Added to your wallet')).resolves.toBeTruthy();
  },
};

export const LockedBitcoin: Story = {
  beforeEach: () => setupDetails(),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body);
    await expect(canvas.findByText('Cosigners: Atlas Operator and Meridian Vault')).resolves.toBeTruthy();
    await userEvent.click(canvas.getByTitle('Show locked Bitcoin details'));
    await expect(canvas.findByText('Cosigner: Atlas Operator')).resolves.toBeTruthy();
    await expect(canvas.findByText('Cosigner: Meridian Vault')).resolves.toBeTruthy();
  },
};

export const LockedBitcoinInMyVault: Story = {
  beforeEach: () => setupDetails({ fissions: [fissions[0]], myVaultId: 11 }),
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement.ownerDocument.body).findByText('In my Vault')).resolves.toBeTruthy();
  },
};

export const History: Story = {
  beforeEach: () => setupDetails({ isRatchetAvailable: true }),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body);
    await expect(canvas.findByText(/^₳34,000\.00$/, { selector: 'strong' })).resolves.toBeTruthy();
    await expect(canvas.findByText(/^₳32,000\.00$/, { selector: 'strong' })).resolves.toBeTruthy();
    await expect(canvas.findByText('₳2.89 fees')).resolves.toBeTruthy();
    await userEvent.hover(canvas.getByRole('button', { name: /unlocked/ }));
    await expect(canvas.findByText('Bitcoin price target')).resolves.toBeTruthy();
    await expect(canvas.findByText('Transaction fee')).resolves.toBeTruthy();
    await expect(canvas.findByText(/^₳0\.19$/)).resolves.toBeTruthy();
    await expect(canvas.findByText('Securitization fee')).resolves.toBeTruthy();
    await expect(canvas.findByText(/^₳2\.70$/)).resolves.toBeTruthy();
  },
};

export const CreationHistory: Story = {
  beforeEach: () => setupDetails({ fissions: creationOnlyFissions, displayLiquidWithoutTerms: true }),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body);
    await expect(canvas.findByText(/^₳32,000\.00$/, { selector: 'strong' })).resolves.toBeTruthy();
    await expect(canvas.findByText('₳6.93 fees')).resolves.toBeTruthy();
  },
};

export const DownRatchetHistory: Story = {
  beforeEach: () => setupDetails({ fissions: downRatchetFissions }),
};

export const RatchetAvailabilityLoading: Story = {
  beforeEach: () => setupDetails({ isRatchetLoading: true }),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body);
    await expect(canvas.findByText(/^₳32,000\.00$/, { selector: 'strong' })).resolves.toBeTruthy();
    await expect(canvas.findByText('(BTC change +4.75%)')).resolves.toBeTruthy();
    await expect(canvas.queryByText(/Would unlock/)).not.toBeInTheDocument();
  },
};

export const RatchetBelowMinimum: Story = {
  beforeEach: () =>
    setupDetails({
      ratchetPercent: 1.2,
      ratchetUnavailableReason: 'No locked Bitcoin has reached the minimum 5% price change.',
    }),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body);
    const reason = 'No locked Bitcoin has reached the minimum 5% price change.';
    const amounts = await canvas.findAllByText(/^₳34,000\.00$/, { selector: 'strong' });
    await expect(amounts.some(element => element.getClientRects().length > 0)).toBe(true);
    const rowReasons = await canvas.findAllByText(reason, { selector: 'p' });
    await expect(rowReasons.some(element => element.getClientRects().length > 0)).toBe(true);
    await expect(canvas.getByRole('button', { name: 'Start Ratchet' })).toBeDisabled();
  },
};

export const RatchetWithoutCosignerCapacity: Story = {
  beforeEach: () =>
    setupDetails({
      ratchetPercent: 8.25,
      ratchetPreview: defaultRatchetPreview,
      ratchetUnavailableReason: 'Testing does not have enough available securitization for this ratchet.',
    }),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body);
    const reason = 'Testing does not have enough available securitization for this ratchet.';
    await expect(canvas.findByText(/^₳35,600\.00$/, { selector: 'strong' })).resolves.toBeTruthy();
    await expect(canvas.findByText(/Would unlock ₳1,600\.00/)).resolves.toBeTruthy();
    await expect(canvas.findByText('(BTC change +8.25%)')).resolves.toBeTruthy();
    const rowReasons = await canvas.findAllByText(reason, { selector: 'p' });
    await expect(rowReasons.some(element => element.getClientRects().length > 0)).toBe(true);
    await expect(canvas.queryByText('Fees unavailable')).not.toBeInTheDocument();
    await expect(canvas.getByRole('button', { name: 'Start Ratchet' })).toBeDisabled();
  },
};

export const RatchetFeeUnavailable: Story = {
  beforeEach: () =>
    setupDetails({
      isRatchetAvailable: true,
      ratchetQuoteError: 'The transaction fee service is temporarily unavailable.',
    }),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body);
    await userEvent.click(canvas.getByRole('button', { name: 'Start Ratchet' }));
    await expect(canvas.findByText('The transaction fee service is temporarily unavailable.')).resolves.toBeTruthy();
    await expect(canvas.getByRole('button', { name: 'Retry fee estimate' })).toBeEnabled();
    await expect(canvas.getByRole('button', { name: 'Confirm Ratchet' })).toBeDisabled();
  },
};

export const RatchetFeeRetry: Story = {
  beforeEach: () =>
    setupDetails({
      isRatchetAvailable: true,
      ratchetQuoteError: 'The transaction fee service is temporarily unavailable.',
    }),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body);
    await userEvent.click(canvas.getByRole('button', { name: 'Start Ratchet' }));
    await userEvent.click(canvas.getByRole('button', { name: 'Retry fee estimate' }));
    await expect(canvas.findByText(/This ratchet costs/)).resolves.toBeTruthy();
    await expect(canvas.getByRole('button', { name: 'Confirm Ratchet' })).toBeEnabled();
  },
};

export const RatchetWithoutEnoughWalletBalance: Story = {
  beforeEach: () =>
    setupDetails({
      ratchetPercent: -11.76,
      isRatchetAvailable: true,
      ratchetPreview: downRatchetPreview,
      ratchetRequiredWalletBalanceMicrogons: 30_003_500_000n,
      ratchetAvailableWalletBalanceMicrogons: 1_000_000_000n,
    }),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body);
    await userEvent.click(canvas.getByRole('button', { name: 'Start Ratchet' }));
    await expect(canvas.findByText(/Your Internal App Wallet needs/)).resolves.toBeTruthy();
    await expect(canvas.getByRole('button', { name: 'Confirm Ratchet' })).toBeDisabled();
  },
};

export const FullHistory: Story = {
  beforeEach: () => setupDetails({ fissions: fullHistoryFissions }),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body);
    await userEvent.click(canvas.getByRole('button', { name: 'Show full history' }));
    const fullHistory = canvas.getByRole('heading', { name: 'Full history' }).parentElement!;
    await expect(fullHistory).toBeVisible();
    await userEvent.click(within(fullHistory).getAllByRole('button', { name: /unlocked|pocketed/ })[0]);
    await expect(within(fullHistory).getByText('Bitcoin price target')).toBeVisible();
  },
};

export const CloseConfirmation: Story = {
  beforeEach: () => setupDetails({ closeFeeMicrogons: 1_688n }),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body);
    await userEvent.click(canvas.getByRole('button', { name: /Repay .* Close Liquid/ }));
    await expect(canvas.findByText(/unlock .* BTC in your Bitcoin wallet/)).resolves.toBeTruthy();
    const closeReview = canvas.getByRole('heading', { name: 'Close this Liquid' }).parentElement!;
    await expect(within(closeReview).getByText('Repayment amount')).toBeVisible();
    await expect(within(closeReview).getByText('Estimated fees')).toBeVisible();
    await expect(within(closeReview).getByText('₳33,999.998867')).toBeVisible();
    await expect(within(closeReview).getByText('₳0.001688')).toBeVisible();
    await expect(within(closeReview).getByText('Amount removed from wallet')).toBeVisible();
    await expect(within(closeReview).getByText('₳34,000.000555')).toBeVisible();
  },
};

export const CloseQuoteWhilePriceUpdates: Story = {
  beforeEach: () => setupDetails({ closeQuoteDelayMs: 250 }),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body);
    await userEvent.click(canvas.getByRole('button', { name: /Repay .* Close Liquid/ }));
    await expect(canvas.findAllByText('Calculating...')).resolves.toHaveLength(2);

    let price = 68_000;
    const priceUpdates = setInterval(() => {
      getCurrency().priceIndex.btcUsdPrice = new BigNumber(++price);
    }, 50);
    try {
      await waitFor(() => expect(canvas.getByRole('button', { name: 'Repay & Close Liquid' })).toBeEnabled(), {
        timeout: 700,
      });
    } finally {
      clearInterval(priceUpdates);
    }
  },
};

export const CloseWithoutEnoughWalletBalance: Story = {
  beforeEach: () => setupDetails({ closeAvailableWalletBalanceMicrogons: 1_000_000_000n }),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body);
    await userEvent.click(canvas.getByRole('button', { name: /Repay .* Close Liquid/ }));
    await expect(canvas.findByText(/Your Internal App Wallet needs/)).resolves.toBeTruthy();
    await expect(canvas.getByRole('button', { name: 'Repay & Close Liquid' })).toBeDisabled();
  },
};

export const CloseFeeUnavailable: Story = {
  beforeEach: () => setupDetails({ closeQuoteError: 'The close fee service is temporarily unavailable.' }),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body);
    await userEvent.click(canvas.getByRole('button', { name: /Repay .* Close Liquid/ }));
    await expect(canvas.findByText('The close fee service is temporarily unavailable.')).resolves.toBeTruthy();
    await expect(canvas.getByRole('button', { name: 'Retry fee estimate' })).toBeEnabled();
    await expect(canvas.getByRole('button', { name: 'Repay & Close Liquid' })).toBeDisabled();
  },
};

export const CloseFeeRetry: Story = {
  beforeEach: () => setupDetails({ closeQuoteError: 'The close fee service is temporarily unavailable.' }),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body);
    await userEvent.click(canvas.getByRole('button', { name: /Repay .* Close Liquid/ }));
    await userEvent.click(canvas.getByRole('button', { name: 'Retry fee estimate' }));
    await expect(canvas.getByRole('button', { name: 'Repay & Close Liquid' })).toBeEnabled();
  },
};

export const Closing: Story = {
  beforeEach: () =>
    setupDetails({
      isClosing: true,
      closeProgressPct: 42,
      closeProgressLabel: 'Waiting for Argon block 2 of 4',
    }),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body);
    await expect(canvas.getByRole('heading', { name: 'Closing Liquid' })).toBeVisible();
    await expect(canvas.getByText('Waiting for Argon block 2 of 4')).toBeVisible();
  },
};

export const Ratcheting: Story = {
  beforeEach: () =>
    setupDetails({
      isRatchetAvailable: true,
      isRatcheting: true,
      ratchetProgressPct: 42,
      ratchetProgressLabel: 'Waiting for Argon block 2 of 4',
    }),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body);
    const heading = await canvas.findByRole('heading', { name: 'Ratcheting Liquid' });
    await expect(heading).toBeVisible();
    await expect(within(heading.parentElement!).getByText('Waiting for Argon block 2 of 4')).toBeVisible();
  },
};

export const CloseError: Story = {
  beforeEach: () => setupDetails({ closeError: 'The repayment amount changed. Review the Liquid and try again.' }),
};
