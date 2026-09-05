import type { Meta, StoryObj } from '@storybook/vue3-vite';
import { expect, within } from 'storybook/test';
import { setupBitcoinOverlayScenario } from '../../scenarios/setupBitcoinOverlayScenario.ts';
import { BitcoinLockStatus } from '../../../src-vue/interfaces/IBitcoinLockRecord.ts';
import { useWallets } from '../../../src-vue/stores/wallets.ts';
import Connector from '../../../src-vue/wallets/components/Connector.vue';

const meta = {
  title: 'Wallets/Bitcoin connector',
  component: Connector,
  args: {
    direction: 'left',
    open: false,
  },
  render: () => ({
    components: { Connector },
    setup() {
      return { wallet: useWallets().bitcoinWallet };
    },
    template: `
      <div class="flex h-screen w-screen items-center justify-center bg-slate-800">
        <Connector :wallet="wallet" direction="left" :open="false" />
      </div>
    `,
  }),
} satisfies Meta<typeof Connector>;

export default meta;
type Story = StoryObj<typeof meta>;

export const NoOpenChannel: Story = {
  beforeEach: () => {
    const scenario = setupBitcoinOverlayScenario();
    scenario.locks.splice(0);
    return () => scenario.cleanup();
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('Create Channel')).toBeVisible();
    await expect(canvas.queryByText(/^₳/)).not.toBeInTheDocument();
    await expect(canvas.queryByTestId('Connector.bitcoinChannelAddress.copyContent()')).not.toBeInTheDocument();
  },
};

export const OpenChannel: Story = {
  beforeEach: () => {
    const scenario = setupBitcoinOverlayScenario();
    scenario.lock.status = BitcoinLockStatus.LockPendingFunding;
    scenario.replaceUtxoRecords([]);
    scenario.bitcoinLocks.hasObservedFundingSignal = () => false;
    scenario.bitcoinLocks.isFundingWindowExpired = () => false;
    scenario.lock.scriptDetails!.p2wshScriptHashHex = scenario.bitcoinLocks
      .createCosignScript({ lock: scenario.lock, fundedSatoshis: scenario.lock.fundedSatoshis })
      .calculateScriptPubkey();
    return () => scenario.cleanup();
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('₳850')).toBeVisible();
    await expect(canvas.queryByText(/fee paid/)).not.toBeInTheDocument();
    await expect(canvas.getByTestId('Connector.bitcoinChannelAddress.copyContent()')).toBeVisible();
    await expect(canvas.queryByText('₳0.34')).not.toBeInTheDocument();
  },
};

export const FundedOpenChannel: Story = {
  beforeEach: () => {
    const scenario = setupBitcoinOverlayScenario();
    scenario.lock.status = BitcoinLockStatus.LockFunded;
    scenario.bitcoinLocks.isFundingWindowExpired = () => false;
    scenario.lock.scriptDetails!.p2wshScriptHashHex = scenario.bitcoinLocks
      .createCosignScript({ lock: scenario.lock, fundedSatoshis: scenario.lock.fundedSatoshis })
      .calculateScriptPubkey();
    return () => scenario.cleanup();
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('₳850')).toBeVisible();
    await expect(canvas.getByTestId('Connector.bitcoinChannelAddress.copyContent()')).toBeVisible();
    await expect(canvas.queryByText('Create Channel')).not.toBeInTheDocument();
  },
};

export const ExpiredFundedChannel: Story = {
  beforeEach: () => {
    const scenario = setupBitcoinOverlayScenario();
    scenario.lock.status = BitcoinLockStatus.LockFunded;
    scenario.bitcoinLocks.isFundingWindowExpired = () => true;
    return () => scenario.cleanup();
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('Create Channel')).toBeVisible();
    await expect(canvas.queryByText(/^₳/)).not.toBeInTheDocument();
    await expect(canvas.queryByTestId('Connector.bitcoinChannelAddress.copyContent()')).not.toBeInTheDocument();
  },
};
