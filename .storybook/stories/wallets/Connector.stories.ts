import type { Meta, StoryObj } from '@storybook/vue3-vite';
import { createBitcoinUtxo, setupBitcoinOverlayScenario } from '../../scenarios/setupBitcoinOverlayScenario.ts';
import { BitcoinLockStatus } from '../../../src-vue/interfaces/IBitcoinLockRecord.ts';
import { BitcoinUtxoStatus } from '../../../src-vue/interfaces/IBitcoinUtxoRecord.ts';
import { useWallets } from '../../../src-vue/stores/wallets.ts';
import Connector from '../../../src-vue/wallets/components/Connector.vue';

const meta = {
  title: 'Wallets/Bitcoin connector',
  component: Connector,
  args: {
    direction: 'left',
    open: false,
  },
  render: args => ({
    components: { Connector },
    setup() {
      return { args, wallet: useWallets().bitcoinWallet };
    },
    template: `
      <div class="flex h-screen w-screen items-center justify-center bg-slate-800">
        <Connector :wallet="wallet" direction="left" :open="args.open" />
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
};

export const PendingUnattachedDeposit: Story = {
  args: { open: true },
  beforeEach: () => {
    const scenario = setupBitcoinOverlayScenario();
    scenario.lock.status = BitcoinLockStatus.LockFunded;
    scenario.lock.scriptDetails!.p2wshScriptHashHex = scenario.bitcoinLocks
      .createCosignScript({ lock: scenario.lock, fundedSatoshis: scenario.lock.fundedSatoshis })
      .calculateScriptPubkey();
    scenario.replaceUtxoRecords([
      scenario.fundingRecord,
      createBitcoinUtxo({
        id: 202,
        lockUtxoId: scenario.lock.utxoId!,
        status: BitcoinUtxoStatus.SeenOnMempool,
        satoshis: 1_000_000n,
      }),
    ]);
    return () => scenario.cleanup();
  },
};

export const ExpiredFundedChannel: Story = {
  beforeEach: () => {
    const scenario = setupBitcoinOverlayScenario();
    scenario.lock.status = BitcoinLockStatus.LockFunded;
    scenario.bitcoinLocks.isFundingWindowExpired = () => true;
    return () => scenario.cleanup();
  },
};
