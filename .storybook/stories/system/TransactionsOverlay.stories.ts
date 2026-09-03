import type { Meta, StoryObj } from '@storybook/vue3-vite';
import * as Vue from 'vue';
import { expect, fn, mocked, waitFor, within } from 'storybook/test';
import { setupAppScenario } from '../../scenarios/setupAppScenario.ts';
import basicEmitter from '../../../src-vue/emitters/basicEmitter.ts';
import {
  ExtrinsicType,
  type ITransactionRecord,
  TransactionStatus,
} from '../../../src-vue/interfaces/ITransactionRecord.ts';
import TransactionsOverlay from '../../../src-vue/overlays/TransactionsOverlay.vue';
import { TopTab } from '../../../src-vue/interfaces/IConfig.ts';
import { getDbPromise } from '../../../src-vue/stores/helpers/dbPromise.ts';
import { useWallets } from '../../../src-vue/stores/wallets.ts';

const meta = {
  title: 'System/Transactions',
  component: TransactionsOverlay,
  render: () => ({
    components: { TransactionsOverlay },
    setup() {
      Vue.onMounted(() => basicEmitter.emit('openTransactionsOverlay'));
    },
    template: `
      <div class="relative h-screen w-screen overflow-hidden">
        <TransactionsOverlay />
        <div
          data-testid="TransactionsOverlay.fixedPreviewGuard"
          class="fixed inset-0 z-[999] cursor-not-allowed"
          aria-label="Transaction controls are disabled in this fixed preview"
          title="Transaction controls are disabled in this fixed preview"
        />
      </div>
    `,
  }),
} satisfies Meta<typeof TransactionsOverlay>;

export default meta;
type Story = StoryObj<typeof meta>;

export const CurrentAndPriorRecords: Story = {
  beforeEach: () => {
    setupAppScenario({ selectedTab: TopTab.Home });
    const wallets = useWallets();
    wallets.on = fn(() => fn());

    const transactions = [
      createTransaction(1, ExtrinsicType.BitcoinResecuritize, {
        bitcoin: {
          utxoId: 2,
          vaultId: 1,
          securitizedSatoshis: 709_140n,
          microgonsAtTargetPerBtc: 113_207_547_169n,
          securityFee: 29_193_414n,
        },
      }),
      createTransaction(2, ExtrinsicType.BitcoinRequestRelease, {
        utxoId: 2,
        toScriptPubkey: '0014prior',
        bitcoinNetworkFee: 1_000n,
      }),
      createTransaction(3, ExtrinsicType.BitcoinRequestRelease, {
        utxoId: 3,
        toScriptPubkey: '0014current',
        bitcoinNetworkFee: 1_000n,
        redemptionAmount: 16_500_000n,
      }),
      createTransaction(4, ExtrinsicType.BitcoinRatchet, {
        utxoId: 4,
        addedSecuritizationMicrogons: 12_500_000n,
      }),
      createTransaction(5, ExtrinsicType.BitcoinRatchet, {
        liquidId: 5,
        fissionIds: [10],
        resecuritizedUtxoIds: [],
      }),
      createTransaction(6, ExtrinsicType.TreasuryReleaseBondLot, {
        bondLotId: 6,
        releasedBondMicrogons: 45_000_000n,
      }),
      createTransaction(7, ExtrinsicType.OperationalSetProfileName, { operatorName: 'Atlas' }),
      createTransaction(8, ExtrinsicType.OperationalClaimRewards, {
        amount: 12_000_000n,
        claimAccount: 'argon',
      }),
      createTransaction(9, ExtrinsicType.OperationalActivateAndClaim, {
        rewardAccount: 'argon',
        vaultLockMicrogons: 100_000_000n,
        rewardMicrogons: 50_000_000n,
        claimedMicrogons: 50_000_000n,
      }),
      createTransaction(10, ExtrinsicType.CrosschainTransferRegisterMintingAuthority, {
        actionType: 'registerMintingAuthority',
        authorityIndex: 1,
        destinationSigningKey: '0x01',
        microgonCollateral: 10_000_000n,
        micronotCollateral: 2_000_000n,
      }),
    ];

    mocked(getDbPromise).mockReturnValue(
      Promise.resolve({
        walletTransfersTable: { fetchAll: fn(async () => []) },
        transactionsTable: { fetchAll: fn(async () => transactions) },
      }) as unknown as ReturnType<typeof getDbPromise>,
    );
  },
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body);

    await waitFor(() => expect(body.getByRole('row', { name: /Updated Bitcoin Insurance/ })).toBeVisible());
    await expect(
      within(body.getByRole('row', { name: /Updated Bitcoin Insurance/ })).getByText('0.0070914 BTC'),
    ).toBeVisible();
    await expect(body.getByRole('row', { name: /Requested Bitcoin Release --/ })).toBeVisible();
    await expect(body.getByRole('row', { name: /Requested Bitcoin Release 16.5 ARGN/ })).toBeVisible();
    await expect(body.getByRole('row', { name: /Ratcheted Bitcoin Lock 12.5 ARGN/ })).toBeVisible();
    await expect(body.getByRole('row', { name: /Ratcheted Bitcoin Liquid --/ })).toBeVisible();
    await expect(body.getByRole('row', { name: /Scheduled Bond Release 45 ARGN/ })).toBeVisible();
    await expect(body.getByRole('row', { name: /Updated Operational Profile/ })).toBeVisible();
    await expect(body.getByRole('row', { name: /Claimed Operational Rewards 12 ARGN/ })).toBeVisible();
    await expect(body.getByRole('row', { name: /Activated Operational Account 50 ARGN/ })).toBeVisible();
    await expect(body.getByRole('row', { name: /Registered Minting Authority 10 ARGN \+ 2 ARGNOT/ })).toBeVisible();
    await expect(body.getByTestId('TransactionsOverlay.fixedPreviewGuard')).toBeVisible();
  },
};

function createTransaction(id: number, extrinsicType: ExtrinsicType, metadataJson: unknown): ITransactionRecord {
  const occurredAt = new Date(`2026-09-01T22:${String(30 + id).padStart(2, '0')}:00.000Z`);
  return {
    id,
    status: TransactionStatus.Finalized,
    extrinsicHash: `0x${id}`,
    extrinsicMethodJson: {},
    extrinsicType,
    metadataJson,
    accountAddress: useWallets().defaultArgonWallet.address,
    submittedAtTime: occurredAt,
    submittedAtBlockHeight: 2_190 + id,
    submissionErrorJson: undefined,
    txTip: 0n,
    txFeePlusTip: 100n,
    blockHeight: 2_190 + id,
    blockHash: `0xblock${id}`,
    blockTime: occurredAt,
    blockExtrinsicIndex: id,
    blockExtrinsicEventsJson: [],
    blockExtrinsicErrorJson: undefined,
    finalizedHeadHeight: 2_210,
    finalizedHeadTime: new Date('2026-09-01T23:00:00.000Z'),
    isFinalized: true,
    createdAt: occurredAt,
    updatedAt: occurredAt,
  };
}
