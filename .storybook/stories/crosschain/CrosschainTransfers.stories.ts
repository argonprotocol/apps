import type { Meta, StoryObj } from '@storybook/vue3-vite';
import { MICROGONS_PER_ARGON, MoveToken, UnitOfMeasurement } from '@argonprotocol/apps-core';
import * as Vue from 'vue';
import { expect, fn, mocked, within } from 'storybook/test';
import AppScreen from '../../components/AppScreen.vue';
import { setupAppScenario } from '../../scenarios/setupAppScenario.ts';
import { TopTab } from '../../../src-vue/interfaces/IConfig.ts';
import { CrosschainHistory, type ICrosschainHistoryRecord } from '../../../src-vue/lib/CrosschainHistory.ts';
import CrosschainTransfers from '../../../src-vue/screens/CrosschainTransfers.vue';
import { getCurrency } from '../../../src-vue/stores/currency.ts';
import { getCrosschainHistory } from '../../../src-vue/stores/vaults.ts';

const meta = {
  title: 'Crosschain/Overview',
  component: CrosschainTransfers,
  render: () => ({
    components: { AppScreen, CrosschainTransfers },
    template: '<AppScreen><CrosschainTransfers /></AppScreen>',
  }),
} satisfies Meta<typeof CrosschainTransfers>;

export default meta;
type Story = StoryObj<typeof meta>;

export const RecoveredTransferTips: Story = {
  beforeEach: () => {
    setupAppScenario({
      selectedTab: TopTab.CrosschainTransfers,
      config: { hasActivatedCrosschain: true },
    });

    const currency = getCurrency();
    currency._key = UnitOfMeasurement.ARGN;
    currency.record = currency.recordsByKey[UnitOfMeasurement.ARGN];
    currency.symbol = currency.record.symbol;
    currency.isLoaded = true;

    const history = new CrosschainHistory(
      { vaultingAddress: '5SyntheticVaultingWallet' },
      {
        start: fn(async () => undefined),
        finalizedBlockHeader: { blockNumber: 10 },
      } as any,
      undefined,
      fn(async () => ({
        blocks: [],
        asOfBlock: 10,
        definitionVersion: 1,
        coverage: { fromBlock: 0, toBlock: 10, gaps: [] },
      })),
    );
    history.data = Vue.reactive(history.data) as typeof history.data;
    history.data.records = [recoveredAuthorization];

    mocked(getCrosschainHistory).mockReturnValue(history);
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const dashboard = canvas.getByTestId('CrosschainTransfersDashboard');
    const crosschainNavigation = canvas.getByTestId('LeftBar.goto(TopTab.CrosschainTransfers)');

    await expect(dashboard).toBeVisible();
    await expect(within(dashboard).getByText('Transfer Tips')).toBeVisible();
    await expect(within(dashboard).getByText('Tips Available')).toBeVisible();
    await expect(within(dashboard).getByText('1.25 ARGN tip')).toBeVisible();
    await expect(within(crosschainNavigation).getByText('₳1.25')).toBeVisible();
  },
};

const recoveredAuthorization: ICrosschainHistoryRecord = {
  accountId: '5SyntheticVaultingWallet',
  id: '0xblock:2',
  blockNumber: 10,
  blockTime: new Date('2026-08-15T12:00:00.000Z'),
  extrinsicIndex: 1,
  eventIndex: 2,
  details: {
    kind: 'transferAuthorization',
    transferId: '0xtransfer',
    authoritySigningKey: '0xauthority',
    authorityOwnerAccount: '5SyntheticVaultingWallet',
    sourceAccount: '5source',
    destinationAccount: '0xrecipient',
    moveToken: MoveToken.ARGN,
    amount: 5n * BigInt(MICROGONS_PER_ARGON),
    tip: 1_250_000n,
    microgonCollateral: 10n * BigInt(MICROGONS_PER_ARGON),
    micronotCollateral: 1_000_000n,
  },
};
