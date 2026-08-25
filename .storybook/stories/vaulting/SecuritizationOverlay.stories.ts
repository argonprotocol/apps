import type { Meta, StoryObj } from '@storybook/vue3-vite';
import { TxResult } from '@argonprotocol/apps-core';
import { type ArgonClient } from '@argonprotocol/mainchain';
import * as Vue from 'vue';
import { expect, fn, mocked, spyOn, userEvent, waitFor, within } from 'storybook/test';
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

    await waitFor(() => expect(body.getAllByText('Removing 1 ARGN').at(-1)).toBeVisible());
    await waitFor(() => expect(body.getAllByRole('button', { name: 'Update Securitization' }).at(-1)).toBeEnabled());
  },
};

export const Submit: Story = {
  beforeEach: () => setupSecuritizationScenario(),
  play: async () => {
    const body = await submitWalletMaximum();

    await waitFor(() => expect(body.getAllByText('Waiting for 3rd Block…').at(-1)).toBeVisible());
    await waitFor(() => expect(body.getAllByText('Securitization').at(-1)).toBeVisible());
  },
};

export const RestoredPending: Story = {
  beforeEach: () => setupSecuritizationScenario('restoring'),
  play: async () => {
    const body = within(document.body);
    getMyVault().data.pendingAllocateTxInfo = createSecuritizationTransaction();

    await waitFor(() => expect(body.getAllByText('Waiting for 3rd Block…').at(-1)).toBeVisible());
    await Promise.resolve();
    await Promise.resolve();
    await expect(body.queryByText('A securitization change is required')).not.toBeInTheDocument();
    await expect(body.queryByText('ERROR')).not.toBeInTheDocument();
    await waitFor(() => expect(body.getAllByText('Adding 500 ARGN').at(-1)).toBeVisible());
    await waitFor(() => expect(body.getAllByRole('button', { name: 'Update Securitization' }).at(-1)).toBeDisabled());
  },
};

export const RestoredPendingFromPreviousVersion: Story = {
  beforeEach: () => setupSecuritizationScenario('restoring'),
  play: async () => {
    const body = within(document.body);
    const txInfo = createSecuritizationTransaction();
    delete txInfo.tx.metadataJson.securitizationChangeMicrogons;
    txInfo.tx.metadataJson.committedMicronots = 750_000_000n;

    getMyVault().data.pendingAllocateTxInfo = txInfo;

    await waitFor(() => expect(body.getAllByText('Adding 1,300 ARGN').at(-1)).toBeVisible());
    await waitFor(() => expect(body.getAllByText('Adding 750 ARGNOT').at(-1)).toBeVisible());
  },
};

export const Completed: Story = {
  beforeEach: () => setupSecuritizationScenario('completed'),
  play: async () => {
    const body = within(document.body);
    const txInfo = createSecuritizationTransaction();
    getMyVault().data.pendingAllocateTxInfo = txInfo;

    await waitFor(() => expect(body.getAllByText('Waiting for 3rd Block…').at(-1)).toBeVisible());

    getMyVault().data.pendingAllocateTxInfo = null;

    await waitFor(() => expect(body.queryByText('Waiting for 3rd Block…')).not.toBeInTheDocument());
    await waitFor(() => expect(body.getAllByText('Securitization').at(-1)).toBeVisible());
    await waitFor(() => expect(body.getAllByRole('button', { name: 'Update Securitization' }).at(-1)).toBeDisabled());
  },
};

export const Submitting: Story = {
  beforeEach: () => setupSecuritizationScenario('submitting'),
  play: async () => {
    const body = await submitWalletMaximum();

    await expect(body.findByRole('button', { name: 'Submitting…' })).resolves.toBeDisabled();
    const cancelButton = await body.findByRole('button', { name: 'Cancel' });
    await expect(cancelButton).toBeEnabled();
    await userEvent.click(cancelButton);
    await waitFor(() => expect(body.queryByText('Securitization')).not.toBeInTheDocument());
  },
};

export const SubmitFailed: Story = {
  beforeEach: () => setupSecuritizationScenario('error'),
  play: async () => {
    const body = await submitWalletMaximum();

    await waitFor(() =>
      expect(body.getAllByText('The securitization transaction could not be submitted.').at(-1)).toBeVisible(),
    );
    await expect(body.findByRole('button', { name: 'Update Securitization' })).resolves.toBeEnabled();
  },
};

function setupSecuritizationScenario(state: 'ready' | 'submitting' | 'error' | 'restoring' | 'completed' = 'ready') {
  const { wallets } = setupAppScenario({ selectedTab: TopTab.Vaulting });
  const createdVault = createScenarioVault();
  const currency = getCurrency();
  const currentMyVault = getMyVault();
  const pendingTxInfo = createSecuritizationTransaction();
  let securityMicrogons = createdVault.securitization;
  if (state === 'restoring') securityMicrogons = 1_200_000_000n;
  if (state === 'completed') {
    securityMicrogons = pendingTxInfo.tx.metadataJson.securitizationMicrogons ?? createdVault.securitization;
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
  await expect(body.queryByText(/Your wallet needs another .* ARGN/)).not.toBeInTheDocument();
  await userEvent.click(await body.findByRole('button', { name: 'Update Securitization' }));
  return body;
}
