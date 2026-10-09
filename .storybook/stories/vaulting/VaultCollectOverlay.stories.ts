import type { Meta, StoryObj } from '@storybook/vue3-vite';
import * as Vue from 'vue';
import type { IBitcoinCooperativeReleaseRequest } from '@argonprotocol/apps-core';
import { TopTab } from '../../../src-vue/interfaces/IConfig.ts';
import VaultCollectOverlay from '../../../src-vue/overlays/VaultCollectOverlay.vue';
import { getMyVault } from '../../../src-vue/stores/vaults.ts';
import { useCertificationController } from '../../../src-vue/stores/certificationController.ts';
import { setupAppScenario } from '../../scenarios/setupAppScenario.ts';
import { createExternalBitcoinLock } from '../../scenarios/setupBitcoinOverlayScenario.ts';

const meta = {
  title: 'Vaulting/Collect Bitcoin requests',
  component: VaultCollectOverlay,
  beforeEach: () => {
    setupAppScenario({ selectedTab: TopTab.Vaulting });
  },
  render: () => ({
    components: { VaultCollectOverlay },
    setup() {
      Vue.onMounted(async () => {
        await Vue.nextTick();
        const dialog = document.querySelector('[role="dialog"]');
        dialog?.setAttribute('inert', '');
        dialog?.querySelectorAll('details').forEach(details => (details.open = true));
      });
    },
    template:
      '<div class="fixed top-2 right-3 z-[10000] rounded-full border border-slate-400/40 bg-white/90 px-2.5 py-1 text-xs font-semibold text-slate-600">Fixed state preview</div><VaultCollectOverlay />',
  }),
} satisfies Meta<typeof VaultCollectOverlay>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Requests: Story = {
  beforeEach: () => {
    showReturns();
    const { data } = getMyVault();
    data.pendingCollectRevenue = 2_000_000n;
    data.expiringCollectAmount = data.pendingCollectRevenue;
    data.nextCollectDueDate = Date.now() + 24 * 60 * 60 * 1_000;
    data.nextCosignDueDate = data.nextCollectDueDate;
    const lock = {
      ...createExternalBitcoinLock().lockDetails,
      lockId: 43,
      ownerAccount: '5SyntheticRiverOwner',
      fundedSatoshis: 1_000_000n,
      securitizedSatoshis: 1_000_000n,
      securitizationCoverageMicrogons: 1_000_000_000n,
      securitizationRatio: 1,
      fundingUtxos: [{ utxoRef: { txid: `0x${'43'.repeat(32)}`, vout: 0 }, satoshis: 1_000_000n }],
    };
    data.pendingCosignLocksById.set(lock.lockId, {
      lock,
      targetValue: lock.securitizationCoverageMicrogons,
      releaseNumber: 1,
      releaseRequest: {
        ...request,
        lockId: lock.lockId,
        destinationSatoshis: 999_000n,
        releaseNumber: 1,
        cosignDueFrame: 100,
        securitizationAtRisk: lock.securitizationCoverageMicrogons,
      },
    });
    getMyVault().bitcoinLocks.cooperativeReleases.data.requests[1].verificationError =
      'Argon is still checking this deposit.';
  },
};

export const ServerUnavailable: Story = {
  beforeEach: () => {
    showReturns();
    getMyVault().bitcoinLocks.cooperativeReleases.data.refreshError = 'The operator server is unavailable.';
  },
};

const request: IBitcoinCooperativeReleaseRequest = {
  version: 1,
  releaseId: 'synthetic-return-1',
  ownerAccount: '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY',
  vaultId: 7,
  lockId: 42,
  createdAtArgonBlock: 123,
  utxoRef: { txid: `0x${'42'.repeat(32)}`, outputIndex: 0 },
  satoshis: 100_000n,
  toScriptPubkey: `0x0014${'12'.repeat(20)}`,
  destinationSatoshis: 99_000n,
  changeSatoshis: 0n,
  bitcoinNetworkFee: 1_000n,
  feeRatePerSatVb: 5n,
  expectedTransactionId: `0x${'24'.repeat(32)}`,
  requestSignature: `0x${'11'.repeat(65)}`,
};

function showReturns() {
  useCertificationController().setOperationalInvites([
    {
      id: 1,
      name: 'Northstar',
      fromName: 'Atlas',
      inviteCode: 'synthetic-northstar',
      defaultAccountId: request.ownerAccount,
      createdAt: new Date('2026-10-06T12:00:00Z'),
    },
    {
      id: 2,
      name: 'River',
      fromName: 'Atlas',
      inviteCode: 'synthetic-river',
      defaultAccountId: '5SyntheticRiverOwner',
      createdAt: new Date('2026-10-06T12:00:00Z'),
    },
  ]);
  getMyVault().bitcoinLocks.cooperativeReleases.data.requests = [0, 1].map(index => ({
    request: {
      ...request,
      releaseId: `synthetic-return-${index + 1}`,
      utxoRef: { ...request.utxoRef, outputIndex: index },
    },
    createdAt: new Date('2026-10-06T12:00:00Z'),
    updatedAt: new Date('2026-10-06T12:00:00Z'),
  }));
}
