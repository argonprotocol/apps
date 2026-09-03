import * as Vue from 'vue';
import { NetworkConfig } from '@argonprotocol/apps-core';
import type { Meta, StoryObj } from '@storybook/vue3-vite';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
import { expectEventuallyVisible } from '../../support/expectEventuallyVisible.ts';
import {
  createBitcoinUtxo,
  setupBitcoinOverlayScenario,
  type BitcoinOverlayScenario,
} from '../../scenarios/setupBitcoinOverlayScenario.ts';
import {
  BitcoinUtxoRole,
  BitcoinUtxoStatus,
  type IBitcoinUtxoRecord,
} from '../../../src-vue/interfaces/IBitcoinUtxoRecord.ts';
import { ExtrinsicType, TransactionStatus } from '../../../src-vue/interfaces/ITransactionRecord.ts';
import BitcoinOrphanRecoveryOverlay from '../../../src-vue/overlays/BitcoinOrphanRecoveryOverlay.vue';

let scenario: BitcoinOverlayScenario;
let orphanRecord: IBitcoinUtxoRecord;
const isInteractive = Vue.ref(false);

const meta = {
  title: 'Bitcoin/Orphan recovery',
  render: () => ({
    components: { BitcoinOrphanRecoveryOverlay },
    setup() {
      document.addEventListener('click', blockExternalLink, true);
      Vue.onMounted(() => {
        if (!isInteractive.value) disablePreview();
      });
      Vue.onUnmounted(() => {
        document.removeEventListener('click', blockExternalLink, true);
      });
      return { isInteractive, orphanRecord, scenario };
    },
    template: `
      <div class="fixed top-2 right-3 z-[10000] rounded-full border border-slate-400/40 bg-white/90 px-2.5 py-1 text-xs font-semibold text-slate-600 shadow-sm">
        {{ isInteractive ? 'Interactive preview' : 'Fixed state preview' }}
      </div>
      <BitcoinOrphanRecoveryOverlay :lock="scenario.lock" :record="orphanRecord" />
    `,
  }),
} satisfies Meta<typeof BitcoinOrphanRecoveryOverlay>;

export default meta;
type Story = StoryObj<typeof meta>;

export const OrphanedDeposit: Story = {
  beforeEach: () => {
    isInteractive.value = false;
    scenario = setupBitcoinOverlayScenario();
    scenario.replaceUtxoRecords([]);
    orphanRecord = createOrphanRecord(401);
  },
  play: async () => {
    const body = within(document.body);
    await expectEventuallyVisible(body.findByText('Orphaned Bitcoin received'));
  },
};

export const AdditionalDeposit: Story = {
  beforeEach: () => {
    isInteractive.value = false;
    scenario = setupBitcoinOverlayScenario();
    orphanRecord = createOrphanRecord(402, {
      firstSeenAt: new Date('2026-08-16T15:00:00.000Z'),
      firstSeenBitcoinHeight: 250_020,
    });
  },
  play: async () => {
    const body = within(document.body);
    await expectEventuallyVisible(body.findByText('Additional Bitcoin received'));
  },
};

export const InvalidDestination: Story = {
  beforeEach: () => {
    isInteractive.value = true;
    scenario = setupBitcoinOverlayScenario();
    orphanRecord = createOrphanRecord(403);
  },
  play: async () => {
    try {
      const body = within(document.body);
      await userEvent.type(
        await body.findByTestId('BitcoinOrphanRecoveryOverlay.returnDestination'),
        'not-a-bitcoin-address',
      );
      await expectEventuallyVisible(body.findByText(/Enter a valid Bitcoin address/i));
    } finally {
      disablePreview();
    }
  },
};

export const CheckingFee: Story = {
  beforeEach: () => {
    isInteractive.value = true;
    scenario = setupBitcoinOverlayScenario();
    orphanRecord = createOrphanRecord(404);
    const quote = scenario.defer();
    scenario.bitcoinOrphanRelease.prepare = fn(async () => {
      await quote.promise;
      return { canAfford: true, availableBalance: 25_000_000n, txFeePlusTip: 125_000n } as never;
    });
    return () => scenario.cleanup();
  },
  play: async () => {
    try {
      const body = within(document.body);
      await userEvent.type(await body.findByTestId('BitcoinOrphanRecoveryOverlay.returnDestination'), returnAddress());
      await expectEventuallyVisible(body.findByText('Checking the Internal App Wallet transaction fee...'));
    } finally {
      disablePreview();
    }
  },
};

export const InsufficientArgonFee: Story = {
  beforeEach: () => {
    isInteractive.value = true;
    scenario = setupBitcoinOverlayScenario();
    orphanRecord = createOrphanRecord(405);
    scenario.bitcoinOrphanRelease.prepare = fn(async () => ({
      canAfford: false,
      availableBalance: 25_000n,
      txFeePlusTip: 125_000n,
    }) as never);
  },
  play: async () => {
    try {
      const body = within(document.body);
      await userEvent.type(await body.findByTestId('BitcoinOrphanRecoveryOverlay.returnDestination'), returnAddress());
      await expectEventuallyVisible(body.findByText(/to the Internal App Wallet to cover/i));
    } finally {
      disablePreview();
    }
  },
};

export const FeeQuoteError: Story = {
  beforeEach: () => {
    isInteractive.value = true;
    scenario = setupBitcoinOverlayScenario();
    orphanRecord = createOrphanRecord(406);
    scenario.bitcoinOrphanRelease.prepare = fn(async () => {
      throw new Error('Synthetic quote error');
    });
  },
  play: async () => {
    try {
      const body = within(document.body);
      await userEvent.type(await body.findByTestId('BitcoinOrphanRecoveryOverlay.returnDestination'), returnAddress());
      await expectEventuallyVisible(body.findByText('Unable to check the Argon transaction fee. Please try again.'));
    } finally {
      disablePreview();
    }
  },
};

export const AffordableReturn: Story = {
  beforeEach: () => {
    isInteractive.value = true;
    scenario = setupBitcoinOverlayScenario();
    orphanRecord = createOrphanRecord(407);
  },
  play: async () => {
    try {
      const body = within(document.body);
      await userEvent.type(await body.findByTestId('BitcoinOrphanRecoveryOverlay.returnDestination'), returnAddress());
      await waitFor(async () => {
        await expect(body.getByRole('button', { name: 'Return Bitcoin' })).toBeEnabled();
      });
    } finally {
      disablePreview();
    }
  },
};

export const ArgonRequest: Story = {
  beforeEach: () => {
    isInteractive.value = false;
    scenario = setupBitcoinOverlayScenario();
    orphanRecord = createReleaseRecord(408, BitcoinUtxoStatus.ReleaseIsProcessingOnArgon);
    scenario.orphanTransactions.set(
      orphanRecord.id,
      scenario.createTransactionInfo({
        status: TransactionStatus.Submitted,
        extrinsicType: ExtrinsicType.BitcoinOrphanedUtxoRelease,
        progress: { progressPct: 38, confirmations: 1, expectedConfirmations: 4 },
        metadata: {
          releaseKind: 'Orphan',
          utxoId: scenario.lock.utxoId!,
          utxoRecordId: orphanRecord.id,
          utxoRef: { txid: orphanRecord.txid, vout: orphanRecord.vout },
        },
      }),
    );
    return () => scenario.cleanup();
  },
  play: async () => {
    const body = within(document.body);
    await expectEventuallyVisible(body.findByText(/Argon Block/));
    await expectEventuallyVisible(body.findByText('38.00%'));
  },
};

export const AwaitingVaultSignature: Story = {
  beforeEach: () => {
    isInteractive.value = false;
    scenario = setupBitcoinOverlayScenario();
    orphanRecord = createReleaseRecord(409, BitcoinUtxoStatus.ReleaseIsProcessingOnArgon);
  },
  play: async () => {
    await expectEventuallyVisible(within(document.body).findByText('Awaiting vault signature'));
  },
};

export const PreparingBitcoinReturn: Story = {
  beforeEach: () => {
    isInteractive.value = false;
    scenario = setupBitcoinOverlayScenario();
    orphanRecord = createReleaseRecord(410, BitcoinUtxoStatus.ReleaseIsProcessingOnArgon, {
      releaseCosignVaultSignature: new Uint8Array([1, 2, 3]),
      releaseCosignHeight: 250_021,
    });
  },
  play: async () => {
    await expectEventuallyVisible(within(document.body).findByText('Preparing Bitcoin return'));
  },
};

export const BitcoinConfirmations: Story = {
  beforeEach: () => {
    isInteractive.value = false;
    scenario = setupBitcoinOverlayScenario();
    orphanRecord = createReleaseRecord(411, BitcoinUtxoStatus.ReleaseIsProcessingOnBitcoin, {
      releaseCosignVaultSignature: new Uint8Array([1, 2, 3]),
      releaseCosignHeight: 250_021,
      releaseTxid: 'synthetic-orphan-return',
    });
    scenario.releaseLifecycle.progressPct = 67;
  },
  play: async () => {
    await expectEventuallyVisible(within(document.body).findByText('Returning on Bitcoin'));
  },
};

export const Returned: Story = {
  beforeEach: () => {
    isInteractive.value = false;
    scenario = setupBitcoinOverlayScenario();
    orphanRecord = createReleaseRecord(412, BitcoinUtxoStatus.ReleaseComplete, {
      releaseCosignVaultSignature: new Uint8Array([1, 2, 3]),
      releaseCosignHeight: 250_021,
      releaseTxid: 'synthetic-complete-orphan-return',
      releasedAtBitcoinHeight: 250_028,
    });
  },
  play: async () => {
    await expectEventuallyVisible(within(document.body).findByText('Bitcoin returned'));
  },
};

export const StatusError: Story = {
  beforeEach: () => {
    isInteractive.value = false;
    scenario = setupBitcoinOverlayScenario();
    orphanRecord = createReleaseRecord(413, BitcoinUtxoStatus.ReleaseIsProcessingOnArgon, {
      statusError: 'The vault signature expired before the return was broadcast.',
    });
  },
  play: async () => {
    await expectEventuallyVisible(
      within(document.body).findByText('The vault signature expired before the return was broadcast.'),
    );
  },
};

function createOrphanRecord(id: number, overrides: Partial<IBitcoinUtxoRecord> = {}): IBitcoinUtxoRecord {
  return createBitcoinUtxo({
    id,
    lockUtxoId: scenario.lock.utxoId!,
    role: BitcoinUtxoRole.Orphan,
    status: BitcoinUtxoStatus.Orphaned,
    satoshis: scenario.lock.securitizedSatoshis - 1_250_000n,
    ...overrides,
  });
}

function createReleaseRecord(
  id: number,
  status: BitcoinUtxoStatus,
  overrides: Partial<IBitcoinUtxoRecord> = {},
): IBitcoinUtxoRecord {
  return createBitcoinUtxo({
    id,
    lockUtxoId: scenario.lock.utxoId!,
    role: BitcoinUtxoRole.Orphan,
    status,
    releaseToDestinationAddress: `0014${'66'.repeat(20)}`,
    releaseBitcoinNetworkFee: 18_000n,
    requestedReleaseAtTick: Math.floor(Date.UTC(2026, 7, 16, 14, 25) / NetworkConfig.tickMillis),
    ...overrides,
  });
}

function returnAddress(): string {
  return scenario.bitcoinLocks.formatP2wshAddress(`0020${'77'.repeat(32)}`);
}

function blockExternalLink(event: MouseEvent): void {
  const element = event.target instanceof Element ? event.target : undefined;
  const externalLink = element?.closest('a[href^="http"]');
  if (!externalLink?.closest('[data-testid="BitcoinOrphanRecoveryOverlay"]')) return;

  event.preventDefault();
  event.stopImmediatePropagation();
}

function disablePreview(): void {
  isInteractive.value = false;
  document.querySelector('[data-testid="BitcoinOrphanRecoveryOverlay"]')?.setAttribute('inert', '');
}
