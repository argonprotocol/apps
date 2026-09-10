import type { Meta, StoryObj } from '@storybook/vue3-vite';
import * as Vue from 'vue';
import { fn, mocked } from 'storybook/test';
import { MotionGlobalConfig } from 'motion-v';
import { setupAppScenario } from '../../scenarios/setupAppScenario.ts';
import basicEmitter from '../../../src-vue/emitters/basicEmitter.ts';
import { ExtrinsicType, TransactionStatus } from '../../../src-vue/interfaces/ITransactionRecord.ts';
import TransactionsOverlay from '../../../src-vue/overlays/TransactionsOverlay.vue';
import { TopTab } from '../../../src-vue/interfaces/IConfig.ts';
import { getDbPromise } from '../../../src-vue/stores/helpers/dbPromise.ts';

const pendingCapitalTransaction = {
  id: 47,
  status: TransactionStatus.InBlock,
  followOnTxId: undefined,
  extrinsicHash: '0xcapital-change',
  extrinsicMethodJson: {},
  extrinsicType: ExtrinsicType.Transfer,
  metadataJson: {
    moveFrom: 'DefaultArgon',
    moveTo: 'MiningBot',
    assetsToMove: {
      ARGN: 8_833_860_000n,
      ARGNOT: 5_000_000_000n,
    },
    allocationChange: {
      id: 'mining-capital-47',
      targetMicrogons: 67_667_720_000n,
      targetMicronots: 44_084_250_000n,
      legIndex: 0,
      legs: [
        {
          moveFrom: 'DefaultArgon',
          moveTo: 'MiningBot',
          assetsToMove: {
            ARGN: 8_833_860_000n,
            ARGNOT: 5_000_000_000n,
          },
        },
      ],
    },
  },
  accountAddress: '5SyntheticInternalWallet',
  submittedAtTime: new Date('2026-09-02T12:00:00Z'),
  submittedAtBlockHeight: 2_000_100,
  submissionErrorJson: undefined,
  txNonce: 7,
  txTip: 0n,
  txFeePlusTip: 12_000n,
  blockHeight: 2_000_101,
  blockHash: '0xblock',
  blockTime: new Date('2026-09-02T12:01:00Z'),
  blockExtrinsicIndex: 2,
  blockExtrinsicEventsJson: [],
  blockExtrinsicErrorJson: undefined,
  finalizedHeadHeight: 2_000_102,
  finalizedHeadTime: new Date('2026-09-02T12:02:00Z'),
  isFinalized: false,
  createdAt: new Date('2026-09-02T12:00:00Z'),
  updatedAt: new Date('2026-09-02T12:02:00Z'),
};
const pendingExternalTransaction = {
  ...pendingCapitalTransaction,
  id: 48,
  status: TransactionStatus.Submitted,
  extrinsicHash: '0xexternal-transfer',
  metadataJson: {
    moveFrom: 'DefaultArgon',
    moveTo: 'External',
    externalAddress: '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY',
    assetsToMove: { ARGN: 125_000_000n },
  },
  submittedAtBlockHeight: 2_000_103,
  blockHeight: undefined,
  blockHash: undefined,
  blockTime: undefined,
  blockExtrinsicIndex: undefined,
  finalizedHeadHeight: 2_000_102,
  isFinalized: false,
};

const meta = {
  title: 'Wallets/Transactions overlay',
  component: TransactionsOverlay,
  beforeEach: () => {
    MotionGlobalConfig.skipAnimations = true;
    const { wallets } = setupAppScenario({ selectedTab: TopTab.Mining });
    Object.assign(wallets, { on: fn(() => fn()) });
    mocked(getDbPromise).mockReturnValue(
      Promise.resolve({
        walletTransfersTable: { fetchAll: fn(async () => []) },
        transactionsTable: { fetchAll: fn(async () => [pendingExternalTransaction, pendingCapitalTransaction]) },
      }) as unknown as ReturnType<typeof getDbPromise>,
    );
  },
  render: () => ({
    components: { TransactionsOverlay },
    setup() {
      Vue.onMounted(() => basicEmitter.emit('openTransactionsOverlay'));
      return {};
    },
    template: '<TransactionsOverlay />',
  }),
} satisfies Meta<typeof TransactionsOverlay>;

export default meta;
type Story = StoryObj<typeof meta>;

export const MoveTransactions: Story = {};
