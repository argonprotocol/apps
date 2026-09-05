import type { Meta, StoryObj } from '@storybook/vue3-vite';
import * as Vue from 'vue';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
import { setupWalletScenario } from '../../scenarios/setupWalletScenario.ts';
import basicEmitter, { type IWalletOverlayOptions } from '../../../src-vue/emitters/basicEmitter.ts';
import { WalletType } from '../../../src-vue/lib/Wallet.ts';
import WalletOverlay from '../../../src-vue/wallets/WalletOverlay.vue';
import { useWallets } from '../../../src-vue/stores/wallets.ts';
import { getBitcoinLocks, getBitcoinTransactionOperations } from '../../../src-vue/stores/bitcoin.ts';
import { getEthereumMoveTracker } from '../../../src-vue/stores/moveFromEthereum.ts';

let request: IWalletOverlayOptions;
let isInteractive = false;
let ethereumBalanceRefreshes: ReturnType<typeof fn>[] = [];
let bitcoinReleaseSubmit: ReturnType<typeof fn>;
let finishFirstBitcoinReleaseInitiation: (() => void) | undefined;

const meta = {
  title: 'Wallets/Overview',
  render: () => ({
    components: { WalletOverlay },
    setup() {
      Vue.onMounted(() => basicEmitter.emit('openWalletOverlay', request));
      return { isInteractive };
    },
    template: `
      <div class="relative h-screen w-screen overflow-hidden">
        <WalletOverlay />
        <div
          v-if="!isInteractive"
          data-testid="WalletOverlay.fixedPreviewGuard"
          class="fixed inset-0 z-[999] cursor-not-allowed"
          aria-label="Wallet controls are disabled in this fixed preview"
          title="Wallet controls are disabled in this fixed preview"
        >
          <span class="pointer-events-none absolute top-4 left-1/2 -translate-x-1/2 rounded bg-slate-900 px-3 py-1.5 text-sm font-semibold text-white shadow">
            Controls are disabled in this fixed preview.
          </span>
        </div>
      </div>
    `,
  }),
} satisfies Meta<typeof WalletOverlay>;

export default meta;
type Story = StoryObj<typeof meta>;

function useScenario(
  walletType: WalletType.argon | WalletType.bitcoin,
  view?: IWalletOverlayOptions['view'],
  scenario:
    | 'defaultArgon'
    | 'pendingBitcoinFunding'
    | 'pendingBitcoinRelease'
    | 'bitcoinSend'
    | 'bitcoinSendLocked'
    | 'bitcoinWalletDetails'
    | 'bitcoinWalletInsurancePending'
    | 'bitcoinWalletInsuranceUnavailable'
    | 'bitcoinWalletInsurancePriceIncrease'
    | 'bitcoinWalletInsuranceSubmitting'
    | 'bitcoinWalletInsuranceError'
    | 'privateKeyError' = 'defaultArgon',
  interactive = false,
) {
  setupWalletScenario(scenario);
  const wallets = useWallets();
  request = {
    wallet: walletType === WalletType.argon ? wallets.argonWallets.defaultArgonWallet : wallets.bitcoinWallet,
    view,
  };
  isInteractive = interactive;
}

function useBitcoinSendScenario() {
  useScenario(WalletType.argon, 'send', 'bitcoinSend', true);
}

function useLockedBitcoinSendScenario() {
  useScenario(WalletType.argon, 'send', 'bitcoinSendLocked', true);
}

function useBitcoinWalletDetailsScenario() {
  useScenario(WalletType.argon, undefined, 'bitcoinWalletDetails', true);
}

function useBitcoinWalletInsurancePendingScenario() {
  useScenario(WalletType.argon, undefined, 'bitcoinWalletInsurancePending', true);
}

function useBitcoinWalletInsuranceUnavailableScenario() {
  useScenario(WalletType.argon, undefined, 'bitcoinWalletInsuranceUnavailable', true);
}

function useBitcoinWalletInsurancePriceIncreaseScenario() {
  useScenario(WalletType.argon, undefined, 'bitcoinWalletInsurancePriceIncrease', true);
}

function useBitcoinWalletInsuranceSubmittingScenario() {
  useScenario(WalletType.argon, undefined, 'bitcoinWalletInsuranceSubmitting', true);
}

function useBitcoinWalletInsuranceErrorScenario() {
  useScenario(WalletType.argon, undefined, 'bitcoinWalletInsuranceError', true);
}

function useBitcoinFeeErrorScenario() {
  useBitcoinSendScenario();
  const calculateBitcoinNetworkFee = getBitcoinLocks().calculateBitcoinNetworkFee as ReturnType<typeof fn>;
  calculateBitcoinNetworkFee.mockRejectedValueOnce(new Error('Unable to estimate network fees.'));
}

function useConcurrentBitcoinSendScenario() {
  useBitcoinSendScenario();
  bitcoinReleaseSubmit = getBitcoinTransactionOperations().bitcoinLockRelease.submit as ReturnType<typeof fn>;
  bitcoinReleaseSubmit.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        finishFirstBitcoinReleaseInitiation = () => resolve(undefined);
      }),
  );
}

function usePartiallyFailedBitcoinSendScenario() {
  useConcurrentBitcoinSendScenario();
  bitcoinReleaseSubmit.mockRejectedValueOnce(new Error('Synthetic second release initiation failure.'));
}

function useFocusRefreshScenario() {
  useScenario(WalletType.argon, undefined, 'defaultArgon', true);
  ethereumBalanceRefreshes = useWallets().ethereumWallets.persistedWallets.map(wallet => {
    const refresh = fn(async () => undefined);
    wallet.refresh = refresh;
    return refresh;
  });
}

function usePendingBitcoinFundingScenario() {
  useScenario(WalletType.argon, undefined, 'pendingBitcoinFunding', true);
}

function usePendingTransferLoadErrorScenario() {
  usePendingBitcoinFundingScenario();
  const loadInboundTransfers = getEthereumMoveTracker().load as ReturnType<typeof fn>;
  loadInboundTransfers.mockRejectedValueOnce(new Error('Synthetic inbound transfer load failure.'));
}

function usePendingBitcoinReleaseScenario() {
  useScenario(WalletType.argon, undefined, 'pendingBitcoinRelease', true);
}

export const MainWallet: Story = {
  beforeEach: () => useScenario(WalletType.argon),
  play: async () => {
    const canvas = within(document.body);

    await expect(canvas.findByRole('dialog', { name: 'Internal App Wallet' })).resolves.toBeVisible();
    await expect(canvas.findByText('Internal App Wallet', { selector: 'span' })).resolves.toBeVisible();
    await expect(canvas.getByText('Ethereum Treasury')).toBeVisible();
    await expect(canvas.getByText('Ethereum Savings')).toBeVisible();
    await expect(
      canvas.getByTestId('WalletOverlay').querySelector('rect[width^="calc"], rect[height^="calc"]'),
    ).toBeNull();
    await expect(canvas.getByTestId('WalletOverlay.fixedPreviewGuard')).toBeVisible();
  },
};

export const BitcoinWalletDetails: Story = {
  beforeEach: useBitcoinWalletDetailsScenario,
  play: async () => {
    const canvas = within(document.body);

    const detailsToggle = await canvas.findByRole('button', { name: 'Show Bitcoin details' });
    await expect(detailsToggle).toHaveTextContent(/\(\s*\)/);
    await expect(detailsToggle).toHaveClass('text-slate-500');
    await expect(detailsToggle).toHaveAttribute('aria-expanded', 'false');
    await expect(detailsToggle.querySelector('svg')).not.toBeNull();
    await expect(canvas.queryByText(/fee paid/)).not.toBeInTheDocument();

    await userEvent.click(detailsToggle);
    await expect(detailsToggle).toHaveTextContent(/\(\s*\)/);
    await expect(detailsToggle).toHaveAttribute('aria-expanded', 'true');
    const lockRows = canvas.getAllByRole('button', { name: /Channel/ });
    await expect(lockRows).toHaveLength(3);
    await expect(canvas.getAllByRole('button', { name: 'Testing Channel' })).toHaveLength(2);
    await expect(canvas.getByRole('button', { name: 'Backup Channel' })).toBeVisible();
    await expect(canvas.getByText('Cosigner: Testing')).toBeVisible();
    await expect(canvas.getByText('Cosigner: Backup')).toBeVisible();
    await expect(canvas.getAllByText('0.01 BTC', { selector: 'span' })).toHaveLength(2);
    await expect(canvas.getByText('0.02 BTC', { selector: 'span' })).toBeVisible();
    await expect(within(lockRows[0]).getByText('bc1qst...ook101')).toBeVisible();
    await expect(within(lockRows[0]).getByText('₳500 insurance')).toBeVisible();
    await expect(within(lockRows[1]).getByText('₳750 insurance')).toBeVisible();
    await expect(within(lockRows[2]).getByText('₳350 insurance')).toBeVisible();
    await expect(canvas.queryByText('Insurance details')).not.toBeInTheDocument();

    const bitcoinRow = canvas.getByText('0.04 BTC', { selector: 'span' }).closest('li');
    const detailsPanel = canvas.getByText('Cosigner: Testing').closest('li');
    await expect(bitcoinRow).not.toBeNull();
    await expect(detailsPanel).not.toBeNull();
    if (!bitcoinRow || !detailsPanel) return;
    await expect(bitcoinRow.nextElementSibling).toBe(detailsPanel);
    await expect(detailsPanel.nextElementSibling).toHaveTextContent('ARGN waiting to mint');
    await expect(detailsPanel).toHaveClass(
      'ml-4',
      'mb-2',
      'rounded-bl-lg',
      'border-l',
      'border-b',
      'border-slate-300/70',
      'pt-2',
      'pr-2',
      'pb-3',
      'pl-3',
    );
    await expect(detailsPanel.className).not.toContain('bg-slate');

    await userEvent.click(lockRows[0]);
    await expect(canvas.findByTestId('ConnectorChannel')).resolves.toBeVisible();
    await expect(canvas.findByRole('heading', { name: 'Update Insurance with Testing' })).resolves.toBeVisible();
    await expect(canvas.findByTestId('ConnectorChannel.addInsuranceAmount')).resolves.toBeVisible();
    await expect(lockRows[0]).toHaveClass('bg-argon-100/40', 'ring-1', 'ring-argon-300/30');
    await expect(canvas.queryByRole('button', { name: /Back to/ })).not.toBeInTheDocument();
    await expect(canvas.queryByRole('button', { name: 'Send Bitcoin' })).not.toBeInTheDocument();
    await expect(canvas.queryByText('Create Bitcoin Channel')).not.toBeInTheDocument();

    await userEvent.click(canvas.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(canvas.queryByTestId('ConnectorChannel')).not.toBeInTheDocument());
    await expect(lockRows[0]).not.toHaveClass('bg-argon-100/40');
  },
};

export const UpdateInsurancePending: Story = {
  beforeEach: useBitcoinWalletInsurancePendingScenario,
  play: async () => {
    const canvas = within(document.body);

    await userEvent.click(await canvas.findByRole('button', { name: 'Show Bitcoin details' }));
    const channelRow = canvas.getAllByRole('button', { name: /Channel/ })[0];
    await userEvent.click(channelRow);

    let insuranceOverlay = await canvas.findByTestId('ConnectorChannel');
    await expect(within(insuranceOverlay).getByRole('button', { name: 'Updating Insurance...' })).toBeDisabled();
    await expect(
      within(insuranceOverlay).getByText('You can close this window without stopping the transaction.'),
    ).toBeVisible();
    await userEvent.click(within(insuranceOverlay).getByTestId('WalletOverlay.closeRight()'));
    await waitFor(() => expect(canvas.queryByTestId('ConnectorChannel')).not.toBeInTheDocument());

    await userEvent.click(channelRow);
    insuranceOverlay = await canvas.findByTestId('ConnectorChannel');
    await expect(within(insuranceOverlay).getByRole('button', { name: 'Updating Insurance...' })).toBeDisabled();
    await expect(
      within(insuranceOverlay).getByText('You can close this window without stopping the transaction.'),
    ).toBeVisible();
  },
};

export const UpdateInsuranceWithoutCosignerCapacity: Story = {
  beforeEach: useBitcoinWalletInsuranceUnavailableScenario,
  play: async () => {
    const canvas = within(document.body);

    await userEvent.click(await canvas.findByRole('button', { name: 'Show Bitcoin details' }));
    await userEvent.click(canvas.getAllByRole('button', { name: /Channel/ })[0]);
    const insuranceOverlay = await canvas.findByTestId('ConnectorChannel');
    await expect(
      within(insuranceOverlay).findByText('Testing does not currently have capacity for more insurance.'),
    ).resolves.toBeVisible();

    const borderedPanel = insuranceOverlay.firstElementChild as HTMLElement;
    const cancelButton = within(insuranceOverlay).getByRole('button', { name: 'Cancel' });
    await expect(cancelButton.getBoundingClientRect().bottom).toBeLessThanOrEqual(
      borderedPanel.getBoundingClientRect().bottom,
    );
  },
};

export const UpdateInsuranceAfterBitcoinPriceIncrease: Story = {
  beforeEach: useBitcoinWalletInsurancePriceIncreaseScenario,
  play: async () => {
    const canvas = within(document.body);

    await userEvent.click(await canvas.findByRole('button', { name: 'Show Bitcoin details' }));
    await userEvent.click(canvas.getAllByRole('button', { name: /Channel/ })[0]);
    const insuranceOverlay = await canvas.findByTestId('ConnectorChannel');
    await expect(within(insuranceOverlay).findByText(/₳680.00 maximum/)).resolves.toBeVisible();
    await expect(within(insuranceOverlay).findByText(/0.005 BTC at the current market price/)).resolves.toBeVisible();
    await expect(within(insuranceOverlay).getByRole('button', { name: 'Update Insurance' })).toBeDisabled();
  },
};

export const UpdatingInsurance: Story = {
  beforeEach: useBitcoinWalletInsuranceSubmittingScenario,
  play: async () => {
    const canvas = within(document.body);

    await userEvent.click(await canvas.findByRole('button', { name: 'Show Bitcoin details' }));
    await userEvent.click(canvas.getAllByRole('button', { name: /Channel/ })[0]);
    const insuranceOverlay = await canvas.findByTestId('ConnectorChannel');
    const amount = within(insuranceOverlay).getByTestId('input-number');
    await userEvent.click(amount);
    await userEvent.keyboard('{Control>}a{/Control}600');
    await userEvent.click(within(insuranceOverlay).getByRole('button', { name: 'Update Insurance' }));
    await expect(
      within(insuranceOverlay).findByRole('button', { name: 'Updating Insurance...' }),
    ).resolves.toBeDisabled();
    await expect(
      within(insuranceOverlay).getByText('You can close this window without stopping the transaction.'),
    ).toBeVisible();
  },
};

export const UpdateInsuranceError: Story = {
  beforeEach: useBitcoinWalletInsuranceErrorScenario,
  play: async () => {
    const canvas = within(document.body);

    await userEvent.click(await canvas.findByRole('button', { name: 'Show Bitcoin details' }));
    await userEvent.click(canvas.getAllByRole('button', { name: /Channel/ })[0]);
    const insuranceOverlay = await canvas.findByTestId('ConnectorChannel');
    const amount = within(insuranceOverlay).getByTestId('input-number');
    await userEvent.click(amount);
    await userEvent.keyboard('{Control>}a{/Control}600');
    await userEvent.click(within(insuranceOverlay).getByRole('button', { name: 'Update Insurance' }));
    await expect(
      within(insuranceOverlay).findByText('Synthetic insurance transaction failure.'),
    ).resolves.toBeVisible();
  },
};

export const RefreshEthereumBalancesOnFocus: Story = {
  beforeEach: useFocusRefreshScenario,
  play: async () => {
    const canvas = within(document.body);

    await expect(canvas.findByText('Internal App Wallet', { selector: 'span' })).resolves.toBeVisible();
    window.dispatchEvent(new Event('focus'));
    for (const refresh of ethereumBalanceRefreshes) await expect(refresh).toHaveBeenCalledOnce();

    ethereumBalanceRefreshes.forEach(refresh => refresh.mockClear());
    await userEvent.click(canvas.getByTestId('WalletOverlay.closeRight()'));
    window.dispatchEvent(new Event('focus'));
    for (const refresh of ethereumBalanceRefreshes) expect(refresh).not.toHaveBeenCalled();
  },
};

export const BitcoinConnector: Story = {
  beforeEach: () => useScenario(WalletType.bitcoin),
  play: async () => {
    const canvas = within(document.body);

    await expect(canvas.findByText('Create Bitcoin Channel')).resolves.toBeVisible();
    await expect(canvas.getByTestId('WalletOverlay.fixedPreviewGuard')).toBeVisible();
  },
};

export const BitcoinChannelFundingPending: Story = {
  beforeEach: usePendingBitcoinFundingScenario,
  play: async () => {
    const canvas = within(document.body);

    await expect(canvas.findByRole('button', { name: '1 Transfer Pending' })).resolves.toBeVisible();
    await expect(canvas.getByTestId('WalletOverlay').querySelector('.transfer-particle-right')).not.toBeNull();
    await userEvent.click(canvas.getByRole('button', { name: '1 Transfer Pending' }));
    await expect(canvas.findByText('0.05 BTC from Bitcoin Network to Testing Channel')).resolves.toBeVisible();
    await expect(canvas.getByText(/Bitcoin confirmation 2 of 4/)).toBeVisible();
  },
};

export const BitcoinChannelReleasePending: Story = {
  beforeEach: usePendingBitcoinReleaseScenario,
  play: async () => {
    const canvas = within(document.body);

    await expect(canvas.findByRole('button', { name: '1 Transfer Pending' })).resolves.toBeVisible();
    await expect(canvas.getByTestId('WalletOverlay').querySelector('.transfer-particle-left')).not.toBeNull();
    await userEvent.click(canvas.getByRole('button', { name: '1 Transfer Pending' }));
    await expect(canvas.findByText(/0.05 BTC from Testing Channel to /)).resolves.toBeVisible();
    await expect(canvas.getByText(/Bitcoin confirmation 2 of 4/)).toBeVisible();
  },
};

export const PendingTransferLoadFailureKeepsAvailableRows: Story = {
  beforeEach: usePendingTransferLoadErrorScenario,
  play: async () => {
    const canvas = within(document.body);

    await expect(canvas.findByRole('button', { name: '1 Transfer Pending' })).resolves.toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: '1 Transfer Pending' }));
    await expect(canvas.findByText(/Bitcoin confirmation 2 of 4/)).resolves.toBeVisible();
    await expect(canvas.findByText(/Synthetic inbound transfer load failure/)).resolves.toBeVisible();
    await userEvent.keyboard('{Escape}');
    await userEvent.click(canvas.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(canvas.queryByText(/Synthetic inbound transfer load failure/)).not.toBeInTheDocument());
  },
};

export const SendTokens: Story = {
  beforeEach: () => useScenario(WalletType.argon, 'send'),
  play: async () => {
    const canvas = within(document.body);

    await expect(canvas.findByRole('heading', { name: 'Send From Internal' })).resolves.toBeVisible();
    await expect(canvas.findByTestId('WalletViewSend.destination')).resolves.toBeVisible();
    await expect(document.querySelectorAll('article.opacity-20')).toHaveLength(0);
    await expect(canvas.getByTestId('WalletOverlay.fixedPreviewGuard')).toBeVisible();
  },
};

export const SendBitcoinFromChannels: Story = {
  beforeEach: useBitcoinSendScenario,
  play: async () => {
    const canvas = within(document.body);

    await expect(canvas.findByRole('heading', { name: 'Send From Internal' })).resolves.toBeVisible();
    await userEvent.click(canvas.getByTestId('WalletViewSend.token'));
    await userEvent.click(canvas.getByTestId('BTC'));
    await expect(canvas.getByTestId('WalletViewSend.amount')).toHaveTextContent('0.03');
    await expect(canvas.findByText(/0.04 BTC backs Liquids/)).resolves.toBeVisible();
    await expect(canvas.getByText(/remaining 0.01 BTC is unavailable to send/)).toBeVisible();
    await expect(canvas.queryByText(/0.05 BTC is used by Liquids/)).not.toBeInTheDocument();
    await expect(canvas.getByText('Bitcoin Network Speed')).toBeVisible();
    await expect(canvas.queryByText(/how much you're willing to pay/)).not.toBeInTheDocument();
    await expect(canvas.getByTestId('WalletViewSend.bitcoinFeeRate')).not.toHaveClass('h-auto', 'py-3');
    const costOfSend = within(canvas.getByTestId('WalletViewSend.cost'));
    await expect(costOfSend.getByText(/^0 BTC \(/)).toBeVisible();
    await expect(costOfSend.getByText(/^0 ARGN \(/)).toBeVisible();
    await userEvent.type(
      canvas.getByTestId('WalletTransferForm.destinationAddress'),
      'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh',
    );
    await expect(costOfSend.findByText('Bitcoin Network')).resolves.toBeVisible();
    await expect(costOfSend.getByText('Argon Network')).toBeVisible();
    await expect(canvas.findByRole('button', { name: /Send Bitcoin/ })).resolves.toBeEnabled();
  },
};

export const SendBitcoinFeeError: Story = {
  beforeEach: useBitcoinFeeErrorScenario,
  play: async () => {
    const canvas = within(document.body);

    await userEvent.click(canvas.getByTestId('WalletViewSend.token'));
    await userEvent.click(canvas.getByTestId('BTC'));
    await userEvent.type(
      canvas.getByTestId('WalletTransferForm.destinationAddress'),
      'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh',
    );
    await expect(canvas.findByText('Unable to estimate network fees.')).resolves.toBeVisible();
    const costOfSend = within(canvas.getByTestId('WalletViewSend.cost'));
    await expect(costOfSend.getByText(/^0 BTC \(/)).toBeVisible();
    await expect(costOfSend.getByText(/^0 ARGN \(/)).toBeVisible();
    await expect(canvas.getByRole('button', { name: /Send Bitcoin/ })).toBeDisabled();
    await userEvent.click(canvas.getByRole('button', { name: 'Retry fee estimate' }));
    await expect(costOfSend.findByText('Bitcoin Network')).resolves.toBeVisible();
    await waitFor(() => expect(canvas.getByRole('button', { name: /Send Bitcoin/ })).toBeEnabled());
  },
};

export const SendBitcoinLockedInLiquid: Story = {
  beforeEach: useLockedBitcoinSendScenario,
  play: async () => {
    const canvas = within(document.body);

    await userEvent.click(canvas.getByTestId('WalletViewSend.token'));
    await userEvent.click(canvas.getByTestId('BTC'));
    await expect(canvas.getByTestId('WalletViewSend.maximum')).toHaveTextContent('0 BTC');
    await expect(
      canvas.getByText(
        'No Bitcoin is available to send. 0.04 BTC backs Liquids, and the remaining 0.01 BTC is unavailable to send until the whole Channel is releasable.',
      ),
    ).toBeVisible();
    await expect(canvas.queryByRole('button', { name: 'Open Wallet' })).not.toBeInTheDocument();
    await expect(canvas.queryByTestId('WalletViewSend.destination')).not.toBeInTheDocument();
    await expect(canvas.queryByText('Bitcoin Network Speed')).not.toBeInTheDocument();
    await expect(canvas.queryByTestId('WalletViewSend.cost')).not.toBeInTheDocument();
    await userEvent.click(canvas.getByRole('button', { name: 'Details' }));
    await expect(
      canvas.getByText('Each Channel must be entirely unused by Liquids before it can be sent.'),
    ).toBeVisible();
    await expect(canvas.getByText('Cosigner: Testing')).toBeVisible();
    await expect(canvas.queryByText(/does not have enough ARGN/)).not.toBeInTheDocument();
    await expect(canvas.getByRole('button', { name: /Send Bitcoin/ })).toBeDisabled();
  },
};

export const SendBitcoinReactsToLiquidAllocation: Story = {
  beforeEach: useBitcoinSendScenario,
  play: async () => {
    const canvas = within(document.body);

    await userEvent.click(canvas.getByTestId('WalletViewSend.token'));
    await userEvent.click(canvas.getByTestId('BTC'));
    await expect(canvas.getByTestId('WalletViewSend.amount')).toHaveTextContent('0.03');

    const newlyAllocatedChannel = getBitcoinLocks()
      .getAllLocks()
      .find(channel => channel.utxoId === 101)!;
    newlyAllocatedChannel.fissionedSatoshis = newlyAllocatedChannel.fundedSatoshis;

    await waitFor(() => expect(canvas.getByTestId('WalletViewSend.amount')).toHaveTextContent('0.02'));
    await expect(canvas.findByText(/0.05 BTC backs Liquids/)).resolves.toBeVisible();
  },
};

export const SendBitcoinAtZeroBalance: Story = {
  beforeEach: () => useScenario(WalletType.argon, 'send', 'defaultArgon', true),
  play: async () => {
    const canvas = within(document.body);

    await userEvent.click(canvas.getByTestId('WalletViewSend.token'));
    await expect(canvas.getByTestId('BTC')).not.toHaveClass('opacity-50');
    await userEvent.click(canvas.getByTestId('BTC'));
    await expect(canvas.getByTestId('WalletViewSend.maximum')).toHaveTextContent('0 BTC');
    await expect(canvas.getByRole('button', { name: /Send Bitcoin/ })).toBeDisabled();
  },
};

export const SendMultipleBitcoinLocksIndependently: Story = {
  beforeEach: useConcurrentBitcoinSendScenario,
  play: async () => {
    const canvas = within(document.body);

    await userEvent.click(canvas.getByTestId('WalletViewSend.token'));
    await userEvent.click(canvas.getByTestId('BTC'));
    await userEvent.type(
      canvas.getByTestId('WalletTransferForm.destinationAddress'),
      'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh',
    );
    await userEvent.click(await canvas.findByRole('button', { name: /Send Bitcoin/ }));
    await waitFor(() => expect(bitcoinReleaseSubmit).toHaveBeenCalledTimes(2));
    finishFirstBitcoinReleaseInitiation?.();
  },
};

export const SendMultipleBitcoinLocksWaitsForEveryStart: Story = {
  beforeEach: usePartiallyFailedBitcoinSendScenario,
  play: async () => {
    const canvas = within(document.body);

    await userEvent.click(canvas.getByTestId('WalletViewSend.token'));
    await userEvent.click(canvas.getByTestId('BTC'));
    await userEvent.type(
      canvas.getByTestId('WalletTransferForm.destinationAddress'),
      'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh',
    );
    await userEvent.click(await canvas.findByRole('button', { name: /Send Bitcoin/ }));
    await waitFor(() => expect(bitcoinReleaseSubmit).toHaveBeenCalledTimes(2));
    finishFirstBitcoinReleaseInitiation?.();
    await expect(canvas.findByText('Synthetic second release initiation failure.')).resolves.toBeVisible();
  },
};

export const CloseReturnsToMain: Story = {
  beforeEach: () => useScenario(WalletType.argon, 'send', 'defaultArgon', true),
  play: async () => {
    const canvas = within(document.body);

    await expect(canvas.findByRole('heading', { name: 'Send From Internal' })).resolves.toBeVisible();
    await userEvent.click(canvas.getByTestId('WalletOverlay.closeRight()'));
    await expect(canvas.findByText('Internal App Wallet', { selector: 'span' })).resolves.toBeVisible();
    await expect(canvas.getByTestId('WalletOverlay')).toBeVisible();
  },
};

export const BackClosesOpenSendMenu: Story = {
  beforeEach: useBitcoinSendScenario,
  play: async () => {
    const canvas = within(document.body);

    await expect(canvas.findByRole('heading', { name: 'Send From Internal' })).resolves.toBeVisible();
    await userEvent.click(canvas.getByTestId('WalletViewSend.token'));
    await userEvent.click(canvas.getByTestId('BTC'));
    await userEvent.click(canvas.getByTestId('WalletViewSend.destinationMenu'));
    await expect(canvas.findByTestId('Bitcoin Network Address')).resolves.toBeVisible();
    await userEvent.click(canvas.getByTestId('WalletHeader.back()'));
    await expect(canvas.findByText('Internal App Wallet', { selector: 'span' })).resolves.toBeVisible();
  },
};

export const ReceiveTokens: Story = {
  beforeEach: () => useScenario(WalletType.argon, 'receive', 'defaultArgon', true),
  play: async () => {
    const canvas = within(document.body);

    await expect(canvas.findByRole('heading', { name: 'Receive Into Internal' })).resolves.toBeVisible();
    await userEvent.click(canvas.getByTestId('WalletViewReceive.address.copyContent()'));
    await expect(navigator.clipboard.writeText).toHaveBeenCalledWith('5StorybookInternalArgonWallet');
    await userEvent.click(canvas.getByTestId('WalletViewReceive.openBitcoinConnector()'));
    await expect(canvas.findByText('Create Bitcoin Channel')).resolves.toBeVisible();
  },
};

export const PrivateKey: Story = {
  beforeEach: () => useScenario(WalletType.argon, 'privateKey', 'defaultArgon', true),
  play: async () => {
    const canvas = within(document.body);

    await expect(canvas.findByRole('heading', { name: 'Private Key' })).resolves.toBeVisible();
    await expect(canvas.findByText('5StorybookInternalArgonWallet')).resolves.toBeVisible();
    await userEvent.click(await canvas.findByRole('button', { name: 'Show' }));
    await expect(canvas.getByText(`0x${'12'.repeat(32)}`)).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: 'Copy to Clipboard' }));
    await expect(canvas.findByRole('button', { name: 'Copied!' })).resolves.toBeVisible();
  },
};

export const PrivateKeyExportError: Story = {
  beforeEach: () => useScenario(WalletType.argon, 'privateKey', 'privateKeyError'),
  play: async () => {
    const canvas = within(document.body);

    await expect(canvas.findByText('Synthetic private-key export failure.')).resolves.toBeVisible();
    await expect(canvas.getByRole('button', { name: 'Copy to Clipboard' })).toBeDisabled();
    await expect(canvas.getByTestId('WalletOverlay.fixedPreviewGuard')).toBeVisible();
  },
};
