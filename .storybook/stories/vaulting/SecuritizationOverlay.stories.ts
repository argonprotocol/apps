import type { Meta, StoryObj } from '@storybook/vue3-vite';
import { type ArgonClient, TxResult } from '@argonprotocol/apps-core';
import * as Vue from 'vue';
import { fn, mocked, spyOn, userEvent, within } from 'storybook/test';
import { TopTab } from '../../../src-vue/interfaces/IConfig.ts';
import type { IVaultIncreaseAllocationMetadata } from '../../../src-vue/lib/MyVault.ts';
import { TransactionInfo } from '../../../src-vue/lib/TransactionInfo.ts';
import {
  ExtrinsicType,
  TransactionStatus,
  type ITransactionRecord,
} from '../../../src-vue/lib/db/TransactionsTable.ts';
import basicEmitter from '../../../src-vue/emitters/basicEmitter.ts';
import SecuritizationOverlay from '../../../src-vue/overlays/SecuritizationOverlay.vue';
import { getBitcoinLocks } from '../../../src-vue/stores/bitcoin.ts';
import { getCurrency } from '../../../src-vue/stores/currency.ts';
import { getMainchainClient } from '../../../src-vue/stores/mainchain.ts';
import { useVaultingAssetBreakdown } from '../../../src-vue/stores/vaultingAssetBreakdown.ts';
import { getMyVault } from '../../../src-vue/stores/vaults.ts';
import { createScenarioVault } from '../../scenarios/createScenarioVault.ts';
import { setupAppScenario } from '../../scenarios/setupAppScenario.ts';

const meta = {
  title: 'Vaulting/Securitization',
  component: SecuritizationOverlay,
  render: () => ({
    components: { SecuritizationOverlay },
    setup() {
      Vue.onMounted(() => basicEmitter.emit('openSecuritizationOverlay'));
    },
    template: '<SecuritizationOverlay />',
  }),
} satisfies Meta<typeof SecuritizationOverlay>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Ready: Story = {
  beforeEach: () => setupSecuritizationScenario(),
};

export const Remove: Story = {
  beforeEach: () => setupSecuritizationScenario(),
  play: async () => {
    const body = within(document.body);
    const [argonInput] = await body.findAllByTestId('input-number');

    await userEvent.click(argonInput);
    await userEvent.keyboard('{ArrowDown}');
    await Vue.nextTick();
  },
};

export const ScheduledDelayedRelease: Story = {
  beforeEach: () => setupSecuritizationScenario('scheduledDelayedRelease'),
};

export const ProposedDelayedRelease: Story = {
  beforeEach: () => setupSecuritizationScenario('proposedDelayedRelease'),
  play: async () => {
    const body = within(document.body);
    const [argonInput] = await body.findAllByTestId('input-number');

    await userEvent.click(argonInput);
    await userEvent.keyboard('{ArrowDown}');
    await Vue.nextTick();
  },
};

export const WaitingForBitcoinLockRelease: Story = {
  beforeEach: () => setupSecuritizationScenario('waitingForBitcoinLockRelease'),
};

export const ArgonotWalletMaxKeepsDeposit: Story = {
  beforeEach: () => setupSecuritizationScenario(),
  play: async () => {
    const body = within(document.body);
    const argonotWalletMax = (await body.findAllByRole('button', { name: 'Wallet Max' })).at(-1)!;

    await userEvent.click(argonotWalletMax);
    await Vue.nextTick();
  },
};

export const MaxReturnsAboveWalletMaximum: Story = {
  beforeEach: () => setupSecuritizationScenario('maxReturnsAboveWalletMaximum'),
};

export const Submit: Story = {
  beforeEach: () => setupSecuritizationScenario(),
  play: async () => {
    await submitWalletMaximum();
  },
};

export const RestoredPending: Story = {
  beforeEach: () => setupSecuritizationScenario('restoring'),
  play: async () => {
    getMyVault().data.pendingAllocateTxInfo = createSecuritizationTransaction();
    await Vue.nextTick();
  },
};

export const RestoredPendingFromPreviousVersion: Story = {
  beforeEach: () => setupSecuritizationScenario('restoring'),
  play: async () => {
    const txInfo = createSecuritizationTransaction();
    delete txInfo.tx.metadataJson.securitizationChangeMicrogons;
    txInfo.tx.metadataJson.committedMicronots = 750_000_000n;

    getMyVault().data.pendingAllocateTxInfo = txInfo;
    await Vue.nextTick();
  },
};

export const Completed: Story = {
  beforeEach: () => setupSecuritizationScenario('completed'),
  play: async () => {
    const txInfo = createSecuritizationTransaction();
    getMyVault().data.pendingAllocateTxInfo = txInfo;
    await Vue.nextTick();

    getMyVault().data.pendingAllocateTxInfo = null;
    await Vue.nextTick();
  },
};

export const Submitting: Story = {
  beforeEach: () => setupSecuritizationScenario('submitting'),
  play: async () => {
    await submitWalletMaximum();
  },
};

export const SubmitFailed: Story = {
  beforeEach: () => setupSecuritizationScenario('error'),
  play: async () => {
    await submitWalletMaximum();
  },
};

function setupSecuritizationScenario(
  state:
    | 'ready'
    | 'submitting'
    | 'error'
    | 'restoring'
    | 'completed'
    | 'scheduledDelayedRelease'
    | 'proposedDelayedRelease'
    | 'waitingForBitcoinLockRelease'
    | 'maxReturnsAboveWalletMaximum' = 'ready',
) {
  const { wallets } = setupAppScenario({ selectedTab: TopTab.Vaulting });
  const hasDelayedRelease =
    state === 'scheduledDelayedRelease' ||
    state === 'proposedDelayedRelease' ||
    state === 'waitingForBitcoinLockRelease';
  const createdVault = createScenarioVault(
    state === 'proposedDelayedRelease'
      ? {
          securitization: 1_550_000_000n,
          securitizationTarget: 1_550_000_000n,
          securitizationLocked: 1_550_000_000n,
        }
      : hasDelayedRelease
        ? {
            securitizationTarget: 1_200_000_000n,
            securitizationLocked: 1_550_000_000n,
            securitizationReleaseSchedule: new Map([[860_720, 350_000_000n]]),
          }
        : {},
  );
  const currency = getCurrency();
  const currentMyVault = getMyVault();
  const currentBitcoinLocks = getBitcoinLocks();
  const pendingTxInfo = createSecuritizationTransaction();
  let securityMicrogons = createdVault.securitization;
  if (state === 'restoring') securityMicrogons = 1_200_000_000n;
  if (state === 'completed') {
    securityMicrogons = pendingTxInfo.tx.metadataJson.securitizationMicrogons ?? createdVault.securitization;
    createdVault.securitization = securityMicrogons;
    createdVault.securitizationTarget = securityMicrogons;
  }

  const myVaultData = Vue.shallowReactive({
    ...currentMyVault.data,
    createdVault,
    pendingAllocateTxInfo: null,
  } as typeof currentMyVault.data);
  const setVaultSecuritization = fn(async () => {
    if (state === 'submitting') return await new Promise<TransactionInfo>(() => undefined);
    if (state === 'error') throw new Error('The securitization transaction could not be submitted.');

    myVaultData.pendingAllocateTxInfo = pendingTxInfo;
    return pendingTxInfo;
  });

  wallets.defaultArgonSpendableMicrogons = 1_000_000_000n;
  wallets.defaultArgonWallet.availableMicrogons = 1_000_000_000n;
  wallets.defaultArgonWallet.availableMicronots = 1_000_000_000n;
  wallets.defaultArgonWallet.totalMicronots = 1_000_000_000n;
  if (state === 'maxReturnsAboveWalletMaximum') {
    wallets.defaultArgonWallet.availableMicronots = 500_000_000n;
    wallets.defaultArgonWallet.totalMicronots = 500_000_000n;
  }

  mocked(getMyVault).mockReturnValue({
    ...currentMyVault,
    data: myVaultData,
    createdVault,
    vaultId: createdVault.vaultId,
    buildSecuritizationTx: fn(async () => {
      if (state === 'restoring') throw new Error('A securitization change is required');
      return {
        paymentInfo: fn(async () => ({ partialFee: { toBigInt: () => 10_000n } })),
      };
    }),
    setVaultSecuritization,
  } as unknown as ReturnType<typeof getMyVault>);
  mocked(useVaultingAssetBreakdown, { partial: true }).mockReturnValue(
    Vue.reactive({
      securityMicrogons,
      securityMicronots: 0n,
      securityMicronotsActivated: 0n,
    }),
  );
  mocked(getBitcoinLocks, { partial: true }).mockReturnValue(
    Object.assign(Object.create(currentBitcoinLocks), {
      data: Vue.reactive({ oracleBitcoinBlockHeight: 860_000 }),
      getAllLocks: fn(() =>
        state === 'proposedDelayedRelease' ? [{ vaultId: createdVault.vaultId, fundedSatoshis: 0n }] : [],
      ),
      isInactiveForVaultDisplay: fn(() => false),
      isLockFunded: fn(() => true),
      getSecuritizationHoldExpirationTime: fn(() => Date.UTC(2026, 8, 20, 16)),
    }),
  );
  mocked(getMainchainClient).mockResolvedValue({} as Awaited<ReturnType<typeof getMainchainClient>>);
  mocked(getCurrency, { partial: true }).mockReturnValue(
    Object.assign(currency, {
      fetchMicrogonsInCirculation: fn(async () => 10_000_000_000n),
      fetchMicronotsInCirculation: fn(async () => 5_000_000_000n),
    }),
  );
}

function createSecuritizationTransaction(): TransactionInfo<IVaultIncreaseAllocationMetadata> {
  const submittedAtTime = new Date('2026-08-20T12:00:00.000Z');
  const tx: ITransactionRecord = {
    id: 42,
    status: TransactionStatus.InBlock,
    extrinsicHash: '0xsynthetic',
    extrinsicMethodJson: {},
    extrinsicType: ExtrinsicType.VaultIncreaseAllocation,
    metadataJson: {
      securitizationMicrogons: 2_500_000_000n,
      securitizationChangeMicrogons: 500_000_000n,
      vaultId: 7,
    },
    accountAddress: '5SyntheticVaultingWallet',
    submittedAtTime,
    submittedAtBlockHeight: 18_510,
    submissionErrorJson: undefined,
    txTip: 0n,
    txFeePlusTip: 10_000n,
    blockHeight: 18_511,
    blockHash: '0xsyntheticblock',
    blockTime: submittedAtTime,
    blockExtrinsicIndex: 1,
    blockExtrinsicEventsJson: [],
    blockExtrinsicErrorJson: undefined,
    finalizedHeadHeight: 18_512,
    finalizedHeadTime: submittedAtTime,
    isFinalized: false,
    createdAt: submittedAtTime,
    updatedAt: submittedAtTime,
  };
  const txResult = new TxResult({} as ArgonClient, {
    accountAddress: tx.accountAddress,
    method: tx.extrinsicMethodJson,
    nonce: 0,
    signedHash: tx.extrinsicHash,
    submittedTime: tx.submittedAtTime,
    submittedAtBlockNumber: tx.submittedAtBlockHeight,
  });
  const info = new TransactionInfo<IVaultIncreaseAllocationMetadata>({ tx, txResult });
  spyOn(info, 'getStatus').mockReturnValue({
    progressPct: 54,
    confirmations: 1,
    expectedConfirmations: 4,
    error: undefined,
    isFinalized: false,
    isMaxed: false,
  });
  spyOn(info, 'subscribeToProgress').mockImplementation(callback => {
    queueMicrotask(() =>
      callback({
        progressPct: 54,
        progressMessage: 'Waiting for 3rd Block…',
        confirmations: 1,
        expectedConfirmations: 4,
        isMaxed: false,
      }),
    );
    return fn();
  });
  return info;
}

async function submitWalletMaximum() {
  const body = within(document.body);
  const walletMaximumButtons = await body.findAllByRole('button', { name: 'Wallet Max' });
  await userEvent.click(walletMaximumButtons[0]);
  await userEvent.click(await body.findByRole('button', { name: 'Update Securitization' }));
  await Vue.nextTick();
}
