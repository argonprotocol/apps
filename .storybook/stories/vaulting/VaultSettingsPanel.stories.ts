import type { Meta, StoryObj } from '@storybook/vue3-vite';
import * as Vue from 'vue';
import basicEmitter from '../../../src-vue/emitters/basicEmitter.ts';
import BigNumber from 'bignumber.js';
import { fn, userEvent, within } from 'storybook/test';
import VaultSettingsPanel from '../../../src-vue/panels/VaultSettingsPanel.vue';
import { getArgonBonds } from '../../../src-vue/stores/argonBonds.ts';
import { getBitcoinLocks } from '../../../src-vue/stores/bitcoin.ts';
import { getConfig } from '../../../src-vue/stores/config.ts';
import { getCurrency } from '../../../src-vue/stores/currency.ts';
import { getMyVault } from '../../../src-vue/stores/vaults.ts';
import { useWallets } from '../../../src-vue/stores/wallets.ts';
import { MyVault, type IVaultIncreaseAllocationMetadata } from '../../../src-vue/lib/MyVault.ts';
import { ExtrinsicType, TransactionStatus } from '../../../src-vue/lib/db/TransactionsTable.ts';
import { createScenarioTransactionInfo } from '../../scenarios/setupBitcoinOverlayScenario.ts';
import { setupVaultingPortfolioScenario } from '../../scenarios/setupVaultingPortfolioScenario.ts';

const meta = {
  title: 'Vaulting/Settings Preview',
  component: VaultSettingsPanel,
  beforeEach: () => {
    setupVaultingPortfolioScenario();
    const currency = getCurrency();
    currency.isLoaded = true;
    currency.microgonsPer.BTC = 68_000_000_000n;
    const myVault = getMyVault();
    myVault.buildSecuritizationTx = fn(
      async () =>
        ({
          paymentInfo: fn(async () => ({ partialFee: { toBigInt: () => 10_000n } })),
        }) as unknown as Awaited<ReturnType<MyVault['buildSecuritizationTx']>>,
    );
    myVault.setVaultSecuritization = fn(async () => {
      throw new Error('Funding is disabled in this fixed preview.');
    });
    myVault.updateSettings = fn(async () => {
      throw new Error('Saving is disabled in this fixed preview.');
    });
    myVault.data.argonotCommitment = {
      heldMicronots: 750_000_000n,
      committedMicronots: 750_000_000n,
      encumberedMicronots: 100_000_000n,
    };
    Object.defineProperty(
      myVault,
      'argonotSecuritizationTarget',
      Object.getOwnPropertyDescriptor(MyVault.prototype, 'argonotSecuritizationTarget')!,
    );
    myVault.createdVault!.terms = { bitcoinBaseFee: 2_000_000n, bitcoinAnnualPercentRate: BigNumber(0.034) };
    getConfig().vaultingRules.btcFlatFee = 2_000_000n;
    getConfig().vaultingRules.btcPctFee = 3.4;
    Object.assign(useWallets(), { defaultArgonSpendableMicrogons: 1_000_000_000n });
    useWallets().defaultArgonWallet.availableMicronots = 3_000_000_000n;
    getBitcoinLocks().data.oracleBitcoinBlockHeight = 860_000;
    const dateNow = Date.now;
    Date.now = () => Date.UTC(2026, 9, 5, 12);
    const interactions = new AbortController();
    const stopFixedPreviewInteraction = (event: Event) => {
      if (!document.querySelector('[role="dialog"][data-fixed-preview]')) return;
      if (event instanceof KeyboardEvent && event.key !== 'Escape') return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    window.addEventListener('pointerdown', stopFixedPreviewInteraction, { capture: true, signal: interactions.signal });
    window.addEventListener('click', stopFixedPreviewInteraction, { capture: true, signal: interactions.signal });
    window.addEventListener('keydown', stopFixedPreviewInteraction, { capture: true, signal: interactions.signal });
    return () => {
      Date.now = dateNow;
      interactions.abort();
    };
  },
  afterEach: () => {
    document.querySelectorAll('[role="dialog"]').forEach(dialog => {
      dialog.setAttribute('data-fixed-preview', '');
      dialog
        .querySelectorAll('button:not([aria-label$="details"]), input, [role="slider"], [contenteditable]')
        .forEach(control => {
          control.setAttribute('inert', '');
        });
    });
  },
  render: () => ({
    components: { VaultSettingsPanel },
    setup() {
      Vue.onMounted(() => basicEmitter.emit('openVaultSettingsOverlay'));
    },
    template: `
      <div class="fixed top-2 right-3 z-[10000] rounded-full border border-slate-400/40 bg-white/90 px-2.5 py-1 text-xs font-semibold text-slate-600 shadow-sm">Fixed settings preview · Example values</div>
      <VaultSettingsPanel />
    `,
  }),
} satisfies Meta<typeof VaultSettingsPanel>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Settings: Story = {};

export const PositionEdit: Story = {
  play: async () => {
    await userEvent.hover(await within(document.body).findByTestId('settings-argn-position'));
  },
};

export const MaxReturnsGuidance: Story = {
  play: async () => {
    const canvas = within(document.body);
    await userEvent.hover(await canvas.findByText('+1,650 for Max Returns'));
    await canvas.findByRole('tooltip');
  },
};

export const FullySecuritized: Story = {
  beforeEach: () => {
    getMyVault().data.argonotCommitment = {
      heldMicronots: 2_400_000_000n,
      committedMicronots: 2_400_000_000n,
      encumberedMicronots: 100_000_000n,
    };
  },
};

export const AddArgons: Story = {
  play: async () => {
    const canvas = within(document.body);
    await userEvent.click(await canvas.findByRole('button', { name: 'Edit ARGN securitization' }));
    const popover = within(await canvas.findByRole('dialog', { name: 'Securitization editor' }));
    const input = within(popover.getByTestId('settings-funding-amount')).getByTestId('input-number');
    await userEvent.clear(input);
    await userEvent.type(input, '500');
    await userEvent.tab();
  },
};

export const AddArgonotsForMaxReturns: Story = {
  play: async () => {
    const canvas = within(document.body);
    await userEvent.click(await canvas.findByRole('button', { name: 'Edit ARGNOT securitization' }));
    const popover = within(await canvas.findByRole('dialog', { name: 'Securitization editor' }));
    await userEvent.click(popover.getByRole('button', { name: 'Max Returns' }));
  },
};

export const AddArgonsWalletMaximum: Story = {
  play: async () => {
    const canvas = within(document.body);
    await userEvent.click(await canvas.findByRole('button', { name: 'Edit ARGN securitization' }));
    const popover = within(await canvas.findByRole('dialog', { name: 'Securitization editor' }));
    const slider = popover.getByRole('slider', { name: 'ARGN amount to add' });
    await userEvent.click(slider);
    await userEvent.keyboard('{End}');
  },
};

export const AddArgonotsWalletMaximum: Story = {
  play: async () => {
    const canvas = within(document.body);
    await userEvent.click(await canvas.findByRole('button', { name: 'Edit ARGNOT securitization' }));
    const popover = within(await canvas.findByRole('dialog', { name: 'Securitization editor' }));
    const slider = popover.getByRole('slider', { name: 'ARGNOT amount to add' });
    await userEvent.click(slider);
    await userEvent.keyboard('{End}');
  },
};

export const WithdrawBeforeFrameCommitment: Story = {
  beforeEach: () => {
    const vault = getMyVault().createdVault!;
    vault.committedMicrogons = 1_900_000_000n;
    vault.securitizationLocked = 1_900_000_000n;
  },
  play: async () => {
    const canvas = within(document.body);
    await userEvent.click(await canvas.findByRole('button', { name: 'Edit ARGN securitization' }));
    const popover = within(await canvas.findByRole('dialog', { name: 'Securitization editor' }));
    await userEvent.click(popover.getByRole('radio', { name: 'Withdraw' }));
  },
};

export const EmptyWallet: Story = {
  beforeEach: () => {
    Object.assign(useWallets(), { defaultArgonSpendableMicrogons: 0n });
  },
  play: async () => {
    const canvas = within(document.body);
    await userEvent.click(await canvas.findByRole('button', { name: 'Edit ARGN securitization' }));
    await canvas.findByRole('dialog', { name: 'Securitization editor' });
  },
};

export const RemoveArgons: Story = {
  play: async () => {
    const canvas = within(document.body);
    await userEvent.click(await canvas.findByRole('button', { name: 'Edit ARGN securitization' }));
    const popover = within(await canvas.findByRole('dialog', { name: 'Securitization editor' }));
    await userEvent.click(popover.getByRole('radio', { name: 'Withdraw' }));
    const input = within(popover.getByTestId('settings-funding-amount')).getByTestId('input-number');
    await userEvent.clear(input);
    await userEvent.type(input, '300');
    await userEvent.tab();
  },
};

export const RemoveArgonots: Story = {
  beforeEach: () => {
    const myVault = getMyVault();
    myVault.data.argonotCommitment = { ...myVault.data.argonotCommitment, committedMicronots: 500_000_000n };
  },
  play: async () => {
    const canvas = within(document.body);
    await userEvent.click(await canvas.findByRole('button', { name: 'Edit ARGNOT securitization' }));
    const popover = within(await canvas.findByRole('dialog', { name: 'Securitization editor' }));
    await userEvent.click(popover.getByRole('radio', { name: 'Withdraw' }));
    const input = within(popover.getByTestId('settings-funding-amount')).getByTestId('input-number');
    await userEvent.clear(input);
    await userEvent.type(input, '300');
    await userEvent.tab();
  },
};

export const TransactionInProgress: Story = {
  beforeEach: () => {
    getMyVault().data.pendingAllocateTxInfo = createScenarioTransactionInfo<IVaultIncreaseAllocationMetadata>({
      extrinsicType: ExtrinsicType.VaultIncreaseAllocation,
      metadata: {
        vaultId: 7,
        securitizationMicrogons: 2_900_000_000n,
        securitizationTargetChangeMicrogons: 500_000_000n,
        securitizationChangeMicrogons: 500_000_000n,
      },
      progress: { progressPct: 54, confirmations: 1, expectedConfirmations: 4 },
    });
  },
  play: async () => {
    const canvas = within(document.body);
    await userEvent.click(await canvas.findByRole('button', { name: 'Edit ARGN securitization' }));
    await canvas.findByRole('dialog', { name: 'Securitization editor' });
  },
};

export const TransactionInProgressClosed: Story = {
  beforeEach: TransactionInProgress.beforeEach,
};

export const TransactionFailed: Story = {
  beforeEach: () => {
    getMyVault().data.pendingAllocateTxInfo = createScenarioTransactionInfo<IVaultIncreaseAllocationMetadata>({
      extrinsicType: ExtrinsicType.VaultIncreaseAllocation,
      metadata: {
        vaultId: 7,
        securitizationMicrogons: 2_900_000_000n,
        securitizationTargetChangeMicrogons: 500_000_000n,
        securitizationChangeMicrogons: 500_000_000n,
      },
      error: new Error('Not enough ARGN available to add funds.'),
      progress: { progressPct: 54, confirmations: 1, expectedConfirmations: 4 },
    });
  },
  play: TransactionInProgress.play,
};

export const BitcoinFeeEditor: Story = {
  play: async () => {
    await userEvent.click(await within(document.body).findByRole('button', { name: 'Edit Bitcoin locking fee' }));
  },
};

export const PendingWithdrawals: Story = {
  beforeEach: () => {
    const vault = getMyVault().createdVault!;
    vault.securitizationTarget = 2_100_000_000n;
    vault.securitizationReleaseSchedule.set(912_560, {
      lockedCommitments: 0n,
      relockableCommitments: 0n,
      argonWithdrawals: 300_000_000n,
      argonotWithdrawals: 100_000_000n,
    });
  },
};

export const MaxReturnsWithPendingWithdrawal: Story = {
  beforeEach: PendingWithdrawals.beforeEach,
  play: AddArgonotsForMaxReturns.play,
};

export const WithdrawalInProgress: Story = {
  beforeEach: () => {
    getMyVault().data.pendingAllocateTxInfo = createScenarioTransactionInfo<IVaultIncreaseAllocationMetadata>({
      extrinsicType: ExtrinsicType.VaultIncreaseAllocation,
      metadata: {
        vaultId: 7,
        securitizationMicrogons: 2_100_000_000n,
        securitizationTargetChangeMicrogons: -300_000_000n,
        securitizationChangeMicrogons: -300_000_000n,
      },
      progress: { progressPct: 54, confirmations: 1, expectedConfirmations: 4 },
    });
  },
  play: TransactionInProgress.play,
};

export const ArgonotTransactionInProgress: Story = {
  beforeEach: () => {
    getMyVault().data.pendingAllocateTxInfo = createScenarioTransactionInfo<IVaultIncreaseAllocationMetadata>({
      extrinsicType: ExtrinsicType.VaultIncreaseAllocation,
      metadata: { vaultId: 7, committedMicronots: 2_400_000_000n, argonotChangeMicronots: 1_650_000_000n },
      progress: { progressPct: 54, confirmations: 1, expectedConfirmations: 4 },
    });
  },
  play: async () => {
    const canvas = within(document.body);
    await userEvent.click(await canvas.findByRole('button', { name: 'Edit ARGNOT securitization' }));
    await canvas.findByRole('dialog', { name: 'Securitization editor' });
  },
};

export const LoadingSettings: Story = {
  beforeEach: () => {
    getMyVault().data.createdVault = null;
  },
};

export const GuidanceUnavailable: Story = {
  beforeEach: () => {
    getArgonBonds().data.averageMicrogonsPerArgonot = undefined;
  },
};

export const InsufficientWalletFunds: Story = {
  beforeEach: () => {
    Object.assign(useWallets(), { defaultArgonSpendableMicrogons: 100_000_000n });
  },
  play: AddArgons.play,
};

export const FeeEstimateFailed: Story = {
  beforeEach: () => {
    getMyVault().buildSecuritizationTx = fn(async () => {
      throw new Error('Unable to estimate the transaction fee. Please retry.');
    });
  },
  play: AddArgons.play,
};

export const BitcoinFeeSaveFailed: Story = {
  play: async () => {
    const canvas = within(document.body);
    await userEvent.click(await canvas.findByRole('button', { name: 'Edit Bitcoin locking fee' }));
    await userEvent.click(canvas.getByRole('button', { name: /^Save$/ }));
    await canvas.findByText('Saving is disabled in this fixed preview.');
  },
};

export const BitcoinFeePersistenceFailed: Story = {
  beforeEach: () => {
    getMyVault().updateSettings = fn(async () =>
      createScenarioTransactionInfo({
        extrinsicType: ExtrinsicType.VaultIncreaseAllocation,
        metadata: { vaultId: 7 },
        status: TransactionStatus.Finalized,
      }),
    );
    getConfig().saveVaultingRules = fn(async () => {
      throw new Error('Unable to save Bitcoin locking fees. Please retry.');
    });
  },
  play: async () => {
    const canvas = within(document.body);
    await userEvent.click(await canvas.findByRole('button', { name: 'Edit Bitcoin locking fee' }));
    await userEvent.click(canvas.getByRole('button', { name: /^Save$/ }));
    await canvas.findByText('Unable to save Bitcoin locking fees. Please retry.');
  },
};
