import * as Vue from 'vue';
import type { Meta, StoryObj } from '@storybook/vue3-vite';
import { fn, userEvent, within } from 'storybook/test';
import {
  createBitcoinUtxo,
  setupBitcoinOverlayScenario,
  type BitcoinOverlayScenario,
} from '../../scenarios/setupBitcoinOverlayScenario.ts';
import { BitcoinLockStatus } from '../../../src-vue/interfaces/IBitcoinLockRecord.ts';
import { BitcoinUtxoRole, BitcoinUtxoStatus } from '../../../src-vue/interfaces/IBitcoinUtxoRecord.ts';
import type { WalletForBitcoin } from '../../../src-vue/lib/WalletForBitcoin.ts';
import { useWallets } from '../../../src-vue/stores/wallets.ts';
import AlertBars from '../../../src-vue/navigation/AlertBars.vue';
import ConnectorChannel from '../../../src-vue/wallets/components/ConnectorChannel.vue';

let scenario: BitcoinOverlayScenario;
let open = true;
let isInteractive = false;
let showUnlockReceiver = false;
let requestedChannelUuid: string | undefined;
let requestedVaultId: number | undefined;
let observeFunding = () => undefined;

const meta = {
  title: 'Wallets/Bitcoin channel',
  component: ConnectorChannel,
  args: {
    direction: 'right',
    open: true,
    wallet: undefined as unknown as WalletForBitcoin,
  },
  render: () => ({
    components: { AlertBars, ConnectorChannel },
    setup() {
      const isOpen = Vue.ref(open);
      return {
        isInteractive,
        isOpen,
        requestedChannelUuid,
        requestedVaultId,
        showUnlockReceiver,
        wallet: useWallets().bitcoinWallet,
      };
    },
    template: `
      <div class="flex h-screen w-screen items-start justify-center bg-slate-800 pt-48">
        <AlertBars v-if="showUnlockReceiver" />
        <ConnectorChannel
          v-model:open="isOpen"
          :channelUuid="requestedChannelUuid"
          :vaultId="requestedVaultId"
          direction="right"
          :wallet="wallet"
        >
          <button class="rounded-full border border-white/30 bg-white px-5 py-3 font-semibold text-slate-700 shadow">
            Bitcoin channel
          </button>
        </ConnectorChannel>
        <div
          v-if="!isInteractive"
          data-testid="ConnectorChannel.fixedPreviewGuard"
          class="fixed inset-0 z-[999] cursor-not-allowed"
          aria-label="Channel controls are disabled in this fixed preview"
        >
          <span class="pointer-events-none absolute top-4 left-1/2 -translate-x-1/2 rounded bg-slate-900 px-3 py-1.5 text-sm font-semibold text-white shadow">
            Fixed state preview
          </span>
        </div>
      </div>
    `,
  }),
} satisfies Meta<typeof ConnectorChannel>;

export default meta;
type Story = StoryObj<typeof meta>;

function useScenario(status?: BitcoinLockStatus, hasObservedFunding = false) {
  scenario = setupBitcoinOverlayScenario();
  open = true;
  isInteractive = false;
  showUnlockReceiver = false;
  requestedChannelUuid = undefined;
  requestedVaultId = undefined;
  observeFunding = () => undefined;
  scenario.locks.splice(0);
  if (status) {
    scenario.lock.status = status;
    if (status === BitcoinLockStatus.LockFunded || status === BitcoinLockStatus.Releasing || hasObservedFunding) {
      scenario.replaceUtxoRecords([scenario.fundingRecord]);
    } else {
      scenario.replaceUtxoRecords([]);
    }
    scenario.locks.push(scenario.lock);
    if (![BitcoinLockStatus.LockIsProcessingOnArgon, BitcoinLockStatus.LockPendingFunding].includes(status)) {
      requestedChannelUuid = scenario.lock.uuid;
    }
  }
  scenario.bitcoinLocks.hasObservedFundingSignal = fn(lock => !!lock.fundingUtxo);
  scenario.bitcoinLocks.isFundingWindowExpired = fn(() => false);
  scenario.bitcoinLocks.confirmAddress = fn();
  return () => scenario.cleanup();
}

export const WalletOverview: Story = {
  beforeEach: () => {
    const cleanup = useScenario();
    isInteractive = true;
    scenario.lock.status = BitcoinLockStatus.Released;
    scenario.lock.removalBlockTime = new Date('2026-08-31T15:30:00.000Z');
    Object.assign(scenario.fundingRecord, {
      status: BitcoinUtxoStatus.ReleaseComplete,
      releaseToDestinationAddress: `0014${'55'.repeat(20)}`,
      releaseBitcoinNetworkFee: 18_000n,
      releaseTxid: 'a'.repeat(64),
    });
    scenario.replaceUtxoRecords([scenario.fundingRecord]);
    scenario.locks.push(
      {
        ...scenario.lock,
        uuid: 'synthetic-channel-81',
        utxoId: 81,
        status: BitcoinLockStatus.LockFunded,
        fundedSatoshis: 90_000_000n,
        securitizedSatoshis: 90_000_000n,
        fissionedSatoshis: 48_000_000n,
        scriptDetails: {
          ...scenario.lock.scriptDetails!,
          p2wshScriptHashHex: `0020${'81'.repeat(32)}`,
        },
        utxos: [],
        fundingUtxo: undefined,
      },
      {
        ...scenario.lock,
        uuid: 'synthetic-channel-103',
        utxoId: 103,
        status: BitcoinLockStatus.LockFunded,
        fundedSatoshis: 80_000_000n,
        securitizedSatoshis: 80_000_000n,
        fissionedSatoshis: 38_000_000n,
        scriptDetails: {
          ...scenario.lock.scriptDetails!,
          p2wshScriptHashHex: `0020${'82'.repeat(32)}`,
        },
        utxos: [],
        fundingUtxo: undefined,
      },
      {
        ...scenario.lock,
        uuid: 'synthetic-channel-122',
        utxoId: 122,
        status: BitcoinLockStatus.LockFunded,
        fundedSatoshis: 40_000_000n,
        securitizedSatoshis: 30_000_000n,
        fissionedSatoshis: 40_000_000n,
        scriptDetails: {
          ...scenario.lock.scriptDetails!,
          p2wshScriptHashHex: `0020${'83'.repeat(32)}`,
        },
        utxos: [],
        fundingUtxo: undefined,
      },
      scenario.lock,
    );
    scenario.bitcoinLocks.isFundingWindowExpired = fn(() => true);
    return cleanup;
  },
};

export const FailedChannel: Story = {
  beforeEach: () => {
    const cleanup = useScenario(BitcoinLockStatus.LockFailed);
    scenario.lock.blockExtrinsicErrorJson = { message: 'Synthetic channel creation failed.' };
    isInteractive = true;
    return cleanup;
  },
};

export const OrphanAfterLastChannelClosed: Story = {
  beforeEach: () => {
    const cleanup = useScenario(BitcoinLockStatus.Released);
    isInteractive = true;
    requestedChannelUuid = undefined;
    scenario.replaceUtxoRecords([
      scenario.fundingRecord,
      createBitcoinUtxo({
        id: 202,
        lockUtxoId: scenario.lock.utxoId!,
        role: BitcoinUtxoRole.Orphan,
        status: BitcoinUtxoStatus.Orphaned,
      }),
    ]);
    return cleanup;
  },
};

export const ArchivedChannel: Story = {
  name: 'Archived channels',
  beforeEach: () => {
    const cleanup = useScenario(BitcoinLockStatus.Released);
    isInteractive = true;
    requestedChannelUuid = undefined;
    scenario.lock.removalBlockTime = new Date('2026-08-31T15:30:00.000Z');
    Object.assign(scenario.fundingRecord, {
      status: BitcoinUtxoStatus.ReleaseComplete,
      releaseToDestinationAddress: `0014${'55'.repeat(20)}`,
      releaseBitcoinNetworkFee: 18_000n,
      releaseTxid: 'a'.repeat(64),
    });
    scenario.replaceUtxoRecords([scenario.fundingRecord]);
    scenario.locks.unshift({
      ...scenario.lock,
      uuid: 'synthetic-older-archived-channel',
      utxoId: 84,
      scriptDetails: {
        ...scenario.lock.scriptDetails!,
        p2wshScriptHashHex: `0020${'84'.repeat(32)}`,
      },
      removalBlockTime: new Date('2026-08-30T15:30:00.000Z'),
      updatedAt: new Date('2026-08-30T15:30:00.000Z'),
    });
    return cleanup;
  },
  play: async () => {
    const canvas = within(document.body);

    await userEvent.click(await canvas.findByRole('button', { name: 'View 2 archived channels' }));
  },
};

export const Form: Story = {
  beforeEach: () => useScenario(),
};

export const CosignerInfo: Story = {
  beforeEach: () => useScenario(),
  play: async () => {
    const canvas = within(document.body);
    await userEvent.hover(await canvas.findByRole('button', { name: 'About this cosigner' }));
  },
};

export const FormInMyVault: Story = {
  beforeEach: () => {
    const cleanup = useScenario();
    scenario.config.upstreamOperator = undefined;
    scenario.myVault.data.createdVault = scenario.ownVault;
    requestedChannelUuid = undefined;
    return cleanup;
  },
};

export const FormWithCosignerChoice: Story = {
  beforeEach: () => {
    const cleanup = useScenario();
    scenario.myVault.data.createdVault = scenario.ownVault;
    isInteractive = true;
    return cleanup;
  },
  play: async () => {
    const canvas = within(document.body);
    await userEvent.click(await canvas.findByRole('combobox', { name: 'Cosigner' }));
    await userEvent.click(await canvas.findByRole('option', { name: 'My Vault' }));
  },
};

export const ExpiredRequestedChannel: Story = {
  beforeEach: () => {
    const cleanup = useScenario(BitcoinLockStatus.LockFunded);
    scenario.bitcoinLocks.isFundingWindowExpired = fn(() => true);
    return cleanup;
  },
};

export const CreateWithoutInsurance: Story = {
  beforeEach: () => {
    const cleanup = useScenario();
    isInteractive = true;
    const submit = scenario.bitcoinLockCreate.submit;
    scenario.bitcoinLockCreate.submit = fn(async input => {
      const txInfo = await submit(input);
      scenario.lock.status = BitcoinLockStatus.LockIsProcessingOnArgon;
      scenario.locks.push(scenario.lock);
      return txInfo;
    });
    return cleanup;
  },
  play: async () => {
    const canvas = within(document.body);
    const createButton = await canvas.findByRole('button', { name: /Create Channel/ });

    await userEvent.click(createButton);
  },
};

export const CreatedChannelSurvivesFinalizationHandoff: Story = {
  beforeEach: () => {
    const cleanup = useScenario();
    isInteractive = true;
    scenario.lock.fundedSatoshis = 0n;
    scenario.lock.fundingUtxo = undefined;
    scenario.lock.utxos = [];
    scenario.bitcoinLocks.getLockByUuid = fn(() => scenario.lock);
    const submit = scenario.bitcoinLockCreate.submit;
    scenario.bitcoinLockCreate.submit = fn(async input => {
      const txInfo = await submit(input);
      scenario.lock.status = BitcoinLockStatus.LockIsProcessingOnArgon;
      return txInfo;
    });
    return cleanup;
  },
  play: async () => {
    const canvas = within(document.body);
    await userEvent.click(await canvas.findByRole('button', { name: /Create Channel/ }));
  },
};

export const FeeWaiver: Story = {
  beforeEach: () => {
    const cleanup = useScenario();
    isInteractive = true;
    scenario.setFeeWaiver();
    const submit = scenario.bitcoinLockCreate.submit;
    scenario.bitcoinLockCreate.submit = fn(async input => {
      const txInfo = await submit(input);
      scenario.lock.status = BitcoinLockStatus.LockIsProcessingOnArgon;
      scenario.locks.push(scenario.lock);
      return txInfo;
    });
    return cleanup;
  },
  play: async () => {
    const canvas = within(document.body);
    const input = await canvas.findByTestId('input-number');
    await userEvent.click(input);
    await userEvent.keyboard('{Control>}a{/Control}10');
  },
};

export const CreatingOnArgon: Story = {
  beforeEach: () => useScenario(BitcoinLockStatus.LockIsProcessingOnArgon),
};

export const PreparingRequest: Story = {
  beforeEach: () => {
    const cleanup = useScenario();
    isInteractive = true;
    const request = scenario.defer();
    scenario.bitcoinLockCreate.submit = fn(async () => {
      await request.promise;
      throw new Error('Story cleanup ended the pending request.');
    });
    return cleanup;
  },
  play: async () => {
    const canvas = within(document.body);
    const input = await canvas.findByTestId('input-number');
    await userEvent.click(input);
    await userEvent.keyboard('10');
    await userEvent.click(canvas.getByRole('button', { name: /Create Channel/ }));
  },
};

export const ReadyForBitcoin: Story = {
  beforeEach: () => useScenario(BitcoinLockStatus.LockPendingFunding),
};

export const RestoredPendingFunding: Story = {
  beforeEach: () => useScenario(BitcoinLockStatus.LockPendingFunding),
};

export const FocusedPendingChannel: Story = {
  beforeEach: () => {
    const cleanup = useScenario(BitcoinLockStatus.LockPendingFunding);
    scenario.locks.unshift({
      ...scenario.lock,
      uuid: 'different-pending-channel',
      utxoId: 202,
      scriptDetails: {
        ...scenario.lock.scriptDetails!,
        p2wshScriptHashHex: `0020${'55'.repeat(32)}`,
      },
    });
    requestedChannelUuid = scenario.lock.uuid;
    return cleanup;
  },
};

export const FundingObservedDuringCurrentVisit: Story = {
  beforeEach: () => {
    const cleanup = useScenario(BitcoinLockStatus.LockPendingFunding);
    observeFunding = () => {
      scenario.locks[0].fundingUtxo = scenario.fundingRecord;
    };
    return cleanup;
  },
  play: async () => {
    observeFunding();
    await Vue.nextTick();
  },
};

export const PendingChannelFunding: Story = {
  beforeEach: () => {
    const cleanup = useScenario(BitcoinLockStatus.LockPendingFunding, true);
    scenario.fundingRecord.satoshis = 5_000_000n;
    scenario.lock.fundedSatoshis = 0n;
    scenario.lockProcessing.receivedSatoshis = scenario.fundingRecord.satoshis;
    return cleanup;
  },
};

export const FundingFinalizesDuringCurrentVisit: Story = {
  beforeEach: () => {
    const cleanup = useScenario(BitcoinLockStatus.LockPendingFunding, true);
    isInteractive = true;
    return cleanup;
  },
  play: async () => {
    scenario.lock.status = BitcoinLockStatus.LockFunded;
    await Vue.nextTick();
  },
};

export const PreviousFundedChannel: Story = {
  beforeEach: () => {
    const cleanup = useScenario(BitcoinLockStatus.LockPendingFunding, true);
    isInteractive = true;
    return cleanup;
  },
};

export const RestoreError: Story = {
  beforeEach: () => {
    const cleanup = useScenario(BitcoinLockStatus.LockPendingFunding);
    const transientError = new Error('Synthetic channel restore failure.');
    scenario.bitcoinLocks.data.readiness = 'error';
    scenario.bitcoinLocks.data.loadError = transientError;
    Object.defineProperty(scenario.bitcoinLocks, 'currentLoadPromise', {
      configurable: true,
      writable: true,
      value: Promise.reject(transientError),
    });
    const retryLoad = fn(() => {
      scenario.bitcoinLocks.data.readiness = 'loading';
      scenario.bitcoinLocks.data.loadError = undefined;
      const retry = Promise.resolve().then(() => {
        scenario.bitcoinLocks.data.readiness = 'ready';
      });
      Object.defineProperty(scenario.bitcoinLocks, 'currentLoadPromise', {
        configurable: true,
        writable: true,
        value: retry,
      });
      return retry;
    });
    scenario.bitcoinLocks.load = retryLoad;
    isInteractive = true;
    return cleanup;
  },
};

export const __namedExportsOrder = [
  'WalletOverview',
  'Form',
  'CosignerInfo',
  'FormInMyVault',
  'FormWithCosignerChoice',
  'ExpiredRequestedChannel',
  'CreateWithoutInsurance',
  'CreatedChannelSurvivesFinalizationHandoff',
  'FeeWaiver',
  'PreparingRequest',
  'CreatingOnArgon',
  'ReadyForBitcoin',
  'RestoredPendingFunding',
  'FocusedPendingChannel',
  'RestoreError',
  'FundingObservedDuringCurrentVisit',
  'PendingChannelFunding',
  'FundingFinalizesDuringCurrentVisit',
  'PreviousFundedChannel',
  'FailedChannel',
  'ArchivedChannel',
  'OrphanAfterLastChannelClosed',
];
