import * as Vue from 'vue';
import type { Meta, StoryObj } from '@storybook/vue3-vite';
import { expect, fn, within } from 'storybook/test';
import { expectEventuallyVisible } from '../../support/expectEventuallyVisible.ts';
import {
  createBitcoinUtxo,
  setupBitcoinOverlayScenario,
  type BitcoinOverlayScenario,
} from '../../scenarios/setupBitcoinOverlayScenario.ts';
import { BitcoinLockStatus } from '../../../src-vue/interfaces/IBitcoinLockRecord.ts';
import { BitcoinUtxoStatus, type IBitcoinUtxoRecord } from '../../../src-vue/interfaces/IBitcoinUtxoRecord.ts';
import { ExtrinsicType, TransactionStatus } from '../../../src-vue/interfaces/ITransactionRecord.ts';
import type { IBitcoinOrphanedUtxoFundingMetadata } from '../../../src-vue/lib/BitcoinLocks.ts';
import basicEmitter from '../../../src-vue/emitters/basicEmitter.ts';
import BitcoinLockingOverlay from '../../../src-vue/overlays/BitcoinLockingOverlay.vue';

let scenario: BitcoinOverlayScenario;
let requestedLock: BitcoinOverlayScenario['lock'] | undefined;

const meta = {
  title: 'Bitcoin/Locking',
  component: BitcoinLockingOverlay,
  render: () => ({
    components: { BitcoinLockingOverlay },
    setup() {
      Vue.onMounted(() => {
        basicEmitter.emit('openBitcoinLock', requestedLock ? { lock: requestedLock } : undefined);
        void Vue.nextTick(() => {
          document.querySelector('[data-testid="BitcoinLockingOverlay"]')?.setAttribute('inert', '');
        });
      });
      return {};
    },
    template: `
      <div class="fixed top-2 right-3 z-[10000] rounded-full border border-slate-400/40 bg-white/90 px-2.5 py-1 text-xs font-semibold text-slate-600 shadow-sm">
        Fixed state preview
      </div>
      <BitcoinLockingOverlay />
    `,
  }),
} satisfies Meta<typeof BitcoinLockingOverlay>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Loading: Story = {
  beforeEach: () => {
    scenario = setupBitcoinOverlayScenario();
    requestedLock = undefined;
    const refresh = scenario.defer();
    scenario.financials.refreshVaults = fn(() => refresh.promise);
    return () => scenario.cleanup();
  },
  play: async () => {
    await expectEventuallyVisible(within(document.body).findByText('Loading...'));
  },
};

export const VaultRefreshError: Story = {
  beforeEach: () => {
    scenario = setupBitcoinOverlayScenario();
    requestedLock = undefined;
    scenario.financials.refreshVaults = fn(async () => {
      throw new Error('Vault availability could not be loaded from Argon.');
    });
  },
  play: async () => {
    await expectEventuallyVisible(within(document.body).findByText('Unable to refresh vault availability'));
  },
};

export const SelectVault: Story = {
  beforeEach: () => {
    scenario = setupBitcoinOverlayScenario();
    requestedLock = undefined;
    scenario.config.upstreamOperator = undefined;
    scenario.myVault.data.createdVault = null;
    scenario.myVault.data.metadata = null;
  },
  play: async () => {
    await expectEventuallyVisible(within(document.body).findByText('Atlas Operator Vault'));
  },
};

export const Start: Story = {
  beforeEach: () => {
    scenario = setupBitcoinOverlayScenario();
    requestedLock = undefined;
  },
  play: async () => {
    await expectEventuallyVisible(within(document.body).findByText('Choose How Much Bitcoin to Liquid Lock'));
  },
};

export const FeeWaiver: Story = {
  beforeEach: () => {
    scenario = setupBitcoinOverlayScenario();
    requestedLock = undefined;
    scenario.setFeeWaiver();
  },
  play: async () => {
    await expectEventuallyVisible(within(document.body).findByText(/fee waiver from Atlas Operator/));
  },
};

export const FeeWaiverResumeSignedInitialization: Story = {
  beforeEach: () => {
    scenario = setupBitcoinOverlayScenario();
    requestedLock = undefined;
    scenario.setFeeWaiver(20_400_000n, 12_500_000n);
  },
  play: async () => {
    const amount = await within(document.body).findByTestId('LockStart.bitcoinAmount');
    await expectEventuallyVisible(Promise.resolve(amount));
    await expect(amount).toHaveAttribute('data-synced-satoshis', '12500000');
  },
};

export const FeeWaiverNeedsWalletFunding: Story = {
  beforeEach: () => {
    scenario = setupBitcoinOverlayScenario();
    requestedLock = undefined;
    scenario.liquidLockingWallet.availableMicrogons = 0n;
    scenario.bitcoinLocks.getInitializeFeeEstimate = fn(async () => ({
      canAfford: false,
      requiredWalletBalanceMicrogons: 2_125_000n,
      securityFee: 2_000_000n,
      txFeePlusTip: 125_000n,
    }));
    scenario.setFeeWaiver();
  },
  play: async () => {
    await expectEventuallyVisible(within(document.body).findByText(/wallet needs a balance of .*2\.13/));
  },
};

export const ArgonProcessing: Story = {
  beforeEach: () => {
    scenario = setupBitcoinOverlayScenario();
    requestedLock = scenario.lock;
    scenario.lock.status = BitcoinLockStatus.LockIsProcessingOnArgon;
    scenario.replaceUtxoRecords([]);
  },
  play: async () => {
    await expectEventuallyVisible(within(document.body).findByText(/awaiting confirmation/));
  },
};

export const ArgonSubmitting: Story = {
  beforeEach: () => {
    scenario = setupBitcoinOverlayScenario();
    requestedLock = scenario.lock;
    scenario.lock.status = BitcoinLockStatus.LockIsProcessingOnArgon;
    scenario.replaceUtxoRecords([]);
    scenario.lockProcessing.confirmations = 0;
    scenario.lockProcessing.expectedConfirmations = 0;
  },
  play: async () => {
    await expectEventuallyVisible(within(document.body).findByText('Submitting to chain'));
  },
};

export const Failed: Story = {
  beforeEach: () => {
    scenario = setupBitcoinOverlayScenario();
    requestedLock = scenario.lock;
    scenario.lock.status = BitcoinLockStatus.LockFailed;
    scenario.lock.blockExtrinsicErrorJson = { message: 'The lock request was rejected because the vault closed.' };
    scenario.replaceUtxoRecords([]);
  },
  play: async () => {
    await expectEventuallyVisible(
      within(document.body).findByText('The lock request was rejected because the vault closed.'),
    );
  },
};

export const ReadyForBitcoin: Story = {
  beforeEach: () => {
    scenario = setupBitcoinOverlayScenario();
    requestedLock = scenario.lock;
    scenario.lock.status = BitcoinLockStatus.LockPendingFunding;
    scenario.replaceUtxoRecords([]);
    scenario.lockProcessing.confirmations = -1;
    scenario.lockProcessing.receivedSatoshis = undefined;
  },
  play: async () => {
    await expectEventuallyVisible(within(document.body).findByRole('heading', { name: /Finish Locking Your Bitcoin/ }));
  },
};

export const BitcoinConfirmations: Story = {
  beforeEach: () => {
    scenario = setupBitcoinOverlayScenario();
    requestedLock = scenario.lock;
    scenario.lock.status = BitcoinLockStatus.LockPendingFunding;
    scenario.replaceUtxoRecords([
      createBitcoinUtxo({
        id: 302,
        lockUtxoId: scenario.lock.utxoId!,
        status: BitcoinUtxoStatus.SeenOnMempool,
        satoshis: scenario.lock.satoshis,
      }),
    ]);
    scenario.lockProcessing.progressPct = 46;
    scenario.lockProcessing.confirmations = 2;
  },
  play: async () => {
    await expectEventuallyVisible(within(document.body).findByText(/waiting for final confirmation on Bitcoin/i));
  },
};

export const FundingMismatch: Story = {
  beforeEach: () => {
    scenario = setupBitcoinOverlayScenario();
    requestedLock = scenario.lock;
    scenario.lock.status = BitcoinLockStatus.LockPendingFunding;
    scenario.replaceUtxoRecords([]);
    const candidate = createBitcoinUtxo({
      id: 301,
      lockUtxoId: scenario.lock.utxoId!,
      status: BitcoinUtxoStatus.FundingCandidate,
      satoshis: scenario.lock.satoshis + 1_250_000n,
    });
    scenario.replaceUtxoRecords([candidate]);
  },
  play: async () => {
    const body = within(document.body);
    await expectEventuallyVisible(body.findByText(/Choose whether to keep or return this Bitcoin deposit/i));
    await expectEventuallyVisible(body.findByText('1 sat/vbyte'));
    await expect(body.findByTestId('LockFundingMismatch.feeRate')).resolves.toHaveTextContent('Medium = ~30 min');
  },
};

export const AcceptingMismatch: Story = {
  beforeEach: () => {
    scenario = setupBitcoinOverlayScenario();
    requestedLock = scenario.lock;
    scenario.lock.status = BitcoinLockStatus.LockPendingFunding;
    const candidate = createMismatchCandidate(303, BitcoinUtxoStatus.FundingCandidate);
    scenario.replaceUtxoRecords([candidate]);
    scenario.mismatchAcceptTransactions.set(
      candidate.id,
      scenario.createTransactionInfo<IBitcoinOrphanedUtxoFundingMetadata>({
        status: TransactionStatus.Submitted,
        extrinsicType: ExtrinsicType.BitcoinOrphanedUtxoUseAsFunding,
        metadata: {
          utxoId: scenario.lock.utxoId!,
          utxoRecordId: candidate.id,
          utxoRef: { txid: candidate.txid, vout: candidate.vout },
          receivedSatoshis: candidate.satoshis,
        },
      }),
    );
    return () => scenario.cleanup();
  },
  play: async () => {
    await expectEventuallyVisible(within(document.body).findByText('Updating your lock on Argon.'));
  },
};

export const AcceptedMismatch: Story = {
  beforeEach: () => {
    scenario = setupBitcoinOverlayScenario();
    requestedLock = scenario.lock;
    scenario.lock.status = BitcoinLockStatus.LockPendingFunding;
    const candidate = createMismatchCandidate(309, BitcoinUtxoStatus.FundingCandidate);
    scenario.replaceUtxoRecords([candidate]);
    scenario.mismatchAcceptTransactions.set(
      candidate.id,
      scenario.createTransactionInfo<IBitcoinOrphanedUtxoFundingMetadata>({
        status: TransactionStatus.Finalized,
        extrinsicType: ExtrinsicType.BitcoinOrphanedUtxoUseAsFunding,
        metadata: {
          utxoId: scenario.lock.utxoId!,
          utxoRecordId: candidate.id,
          utxoRef: { txid: candidate.txid, vout: candidate.vout },
          receivedSatoshis: candidate.satoshis,
        },
      }),
    );
    return () => scenario.cleanup();
  },
  play: async () => {
    const body = within(document.body);
    await expectEventuallyVisible(body.findByText('Finalizing your updated lock.'));
    await expectEventuallyVisible(
      body.findByText('Your lock update is confirmed on Argon. Finalizing your locked amount now.'),
    );
  },
};

export const ReturningMismatchOnArgon: Story = {
  beforeEach: () => {
    scenario = setupBitcoinOverlayScenario();
    requestedLock = scenario.lock;
    scenario.lock.status = BitcoinLockStatus.LockPendingFunding;
    const candidate = createMismatchCandidate(304, BitcoinUtxoStatus.ReleaseIsProcessingOnArgon, {
      releaseToDestinationAddress: `0014${'55'.repeat(20)}`,
      releaseBitcoinNetworkFee: 18_000n,
    });
    scenario.replaceUtxoRecords([candidate]);
    scenario.orphanTransactions.set(
      candidate.id,
      scenario.createTransactionInfo({
        extrinsicType: ExtrinsicType.BitcoinOrphanedUtxoRelease,
        metadata: {
          releaseKind: 'Orphan',
          utxoId: scenario.lock.utxoId!,
          utxoRecordId: candidate.id,
          utxoRef: { txid: candidate.txid, vout: candidate.vout },
        },
      }),
    );
    return () => scenario.cleanup();
  },
  play: async () => {
    const body = within(document.body);
    await expectEventuallyVisible(body.findByText('Returning this Bitcoin deposit.'));
    await expectEventuallyVisible(body.getByText(/Argon Block/));
  },
};

export const ReturningMismatchOnBitcoin: Story = {
  beforeEach: () => {
    scenario = setupBitcoinOverlayScenario();
    requestedLock = scenario.lock;
    scenario.lock.status = BitcoinLockStatus.LockPendingFunding;
    scenario.replaceUtxoRecords([
      createMismatchCandidate(305, BitcoinUtxoStatus.ReleaseIsProcessingOnBitcoin, {
        requestedReleaseAtTick: 10_010,
        releaseToDestinationAddress: `0014${'55'.repeat(20)}`,
        releaseBitcoinNetworkFee: 18_000n,
        releaseCosignVaultSignature: new Uint8Array([1, 2, 3]),
        releaseCosignHeight: 250_020,
        releaseTxid: 'synthetic-mismatch-return',
      }),
    ]);
    scenario.releaseLifecycle.progressPct = 67;
    scenario.releaseLifecycle.confirmations = 3;
  },
  play: async () => {
    const body = within(document.body);
    await expectEventuallyVisible(body.findByText('Returning this Bitcoin deposit.'));
    await expectEventuallyVisible(body.getByText(/Bitcoin Block/));
  },
};

export const MismatchReturned: Story = {
  beforeEach: () => {
    scenario = setupBitcoinOverlayScenario();
    requestedLock = scenario.lock;
    scenario.lock.status = BitcoinLockStatus.LockExpiredWaitingForFunding;
    scenario.bitcoinLocks.verifyExpirationTime = fn(() => scenario.scenarioStartedAt - 1_000);
    scenario.replaceUtxoRecords([
      createMismatchCandidate(306, BitcoinUtxoStatus.ReleaseComplete, {
        requestedReleaseAtTick: 10_010,
        releaseToDestinationAddress: `0014${'55'.repeat(20)}`,
        releaseBitcoinNetworkFee: 18_000n,
        releaseCosignVaultSignature: new Uint8Array([1, 2, 3]),
        releaseCosignHeight: 250_020,
        releaseTxid: 'synthetic-complete-mismatch-return',
        releasedAtBitcoinHeight: 250_026,
      }),
    ]);
  },
  play: async () => {
    const body = within(document.body);
    await expectEventuallyVisible(body.findByText('Mismatch Bitcoin Deposit Returned'));
    await expectEventuallyVisible(body.getByText(/start a new Bitcoin lock/i));
  },
};

export const MismatchReadyToResume: Story = {
  beforeEach: () => {
    scenario = setupBitcoinOverlayScenario();
    requestedLock = scenario.lock;
    scenario.lock.status = BitcoinLockStatus.LockFundingReadyToResume;
    scenario.replaceUtxoRecords([
      createMismatchCandidate(307, BitcoinUtxoStatus.ReleaseComplete, {
        requestedReleaseAtTick: 10_010,
        releaseToDestinationAddress: `0014${'55'.repeat(20)}`,
        releaseBitcoinNetworkFee: 18_000n,
        releaseCosignVaultSignature: new Uint8Array([1, 2, 3]),
        releaseCosignHeight: 250_020,
        releaseTxid: 'synthetic-complete-mismatch-return',
        releasedAtBitcoinHeight: 250_026,
      }),
    ]);
  },
  play: async () => {
    await expectEventuallyVisible(within(document.body).findByRole('button', { name: 'Resume Lock Funding' }));
  },
};

export const MismatchError: Story = {
  beforeEach: () => {
    scenario = setupBitcoinOverlayScenario();
    requestedLock = scenario.lock;
    scenario.lock.status = BitcoinLockStatus.LockPendingFunding;
    scenario.replaceUtxoRecords([createMismatchCandidate(308, BitcoinUtxoStatus.FundingCandidate)]);
    scenario.bitcoinLocks.data.mismatchErrorsByLockUtxoId[scenario.lock.utxoId!] =
      'The mismatch return could not be reconciled with Argon.';
  },
  play: async () => {
    await expectEventuallyVisible(
      within(document.body).findByText('The mismatch return could not be reconciled with Argon.'),
    );
  },
};

export const ExpiredFunding: Story = {
  beforeEach: () => {
    scenario = setupBitcoinOverlayScenario();
    requestedLock = scenario.lock;
    scenario.lock.status = BitcoinLockStatus.LockExpiredWaitingForFunding;
    scenario.replaceUtxoRecords([]);
  },
  play: async () => {
    await expectEventuallyVisible(
      within(document.body).findByText(/lock expired before Bitcoin funding was confirmed/i),
    );
  },
};

export const Minting: Story = {
  beforeEach: () => {
    scenario = setupBitcoinOverlayScenario();
    requestedLock = scenario.lock;
    scenario.lock.status = BitcoinLockStatus.LockedAndIsMinting;
  },
  play: async () => {
    await expectEventuallyVisible(within(document.body).findByText(/Argon has processed and locked/i));
  },
};

function createMismatchCandidate(id: number, status: BitcoinUtxoStatus, overrides: Partial<IBitcoinUtxoRecord> = {}) {
  return createBitcoinUtxo({
    id,
    lockUtxoId: scenario.lock.utxoId!,
    status,
    satoshis: scenario.lock.satoshis + 1_250_000n,
    ...overrides,
  });
}
