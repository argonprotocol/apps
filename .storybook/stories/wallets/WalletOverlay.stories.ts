import type { Meta, StoryObj } from '@storybook/vue3-vite';
import * as Vue from 'vue';
import { BitcoinFission, MoveToken } from '@argonprotocol/apps-core';
import { encodeAddress } from '@polkadot/util-crypto';
import { BitcoinLockStatus } from '../../../src-vue/lib/db/BitcoinLocksTable.ts';
import { fn, mocked, spyOn, userEvent, within } from 'storybook/test';
import {
  setupWalletScenario,
  setupWalletTransferScenario,
  type WalletScenario,
} from '../../scenarios/setupWalletScenario.ts';
import basicEmitter, { type IWalletOverlayOptions } from '../../../src-vue/emitters/basicEmitter.ts';
import { WalletType } from '../../../src-vue/lib/Wallet.ts';
import WalletOverlay from '../../../src-vue/wallets/WalletOverlay.vue';
import UpgradeToTreasuryOverlay from '../../../src-vue/overlays/UpgradeToTreasuryOverlay.vue';
import ConnectorDisconnectOverlay from '../../../src-vue/wallets/components/ConnectorDisconnectOverlay.vue';
import { WalletForEthereum } from '../../../src-vue/lib/WalletForEthereum.ts';
import { useVaultingStats } from '../../../src-vue/stores/vaultingStats.ts';
import { getWalletKeys, useWallets } from '../../../src-vue/stores/wallets.ts';
import {
  getBitcoinFissions,
  getBitcoinLocks,
  getBitcoinTransactionOperations,
} from '../../../src-vue/stores/bitcoin.ts';
import { createScenarioVault } from '../../scenarios/createScenarioVault.ts';
import { getMyVault, getVaults } from '../../../src-vue/stores/vaults.ts';
import { getEthereumMoveTracker } from '../../../src-vue/stores/moveFromEthereum.ts';
import { loadEthereumChainConfig } from '../../../src-vue/lib/EthereumClient.ts';
import { getConfig } from '../../../src-vue/stores/config.ts';
import { getCurrency } from '../../../src-vue/stores/currency.ts';
import { OperationalStepId, useCertificationController } from '../../../src-vue/stores/certificationController.ts';
import { BitcoinReleaseKind, BitcoinReleaseStatus } from '../../../src-vue/interfaces/IBitcoinReleaseRecord.ts';
import { createBitcoinRelease } from '../../scenarios/setupBitcoinOverlayScenario.ts';
import { BitcoinUtxoStatus } from '../../../src-vue/interfaces/IBitcoinUtxoRecord.ts';

let request: IWalletOverlayOptions;
let showTreasuryUpgrade = false;
const isInteractive = Vue.ref(false);

const meta = {
  title: 'Wallets/Overview',
  render: () => ({
    components: { WalletOverlay, UpgradeToTreasuryOverlay, ConnectorDisconnectOverlay },
    setup() {
      Vue.onMounted(() => {
        document.addEventListener('keydown', preventFixedPreviewKeyboard, true);
        basicEmitter.emit('openWalletOverlay', request);
      });
      Vue.onUnmounted(() => document.removeEventListener('keydown', preventFixedPreviewKeyboard, true));
      return { isInteractive, showTreasuryUpgrade };

      function preventFixedPreviewKeyboard(event: KeyboardEvent) {
        if (isInteractive.value) return;
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    },
    template: `
      <div class="relative h-screen w-screen overflow-hidden">
        <WalletOverlay />
        <ConnectorDisconnectOverlay />
        <UpgradeToTreasuryOverlay v-if="showTreasuryUpgrade" />
        <div
          v-if="!isInteractive"
          data-testid="WalletOverlay.fixedPreviewGuard"
          class="pointer-events-auto fixed inset-0 z-[9999] cursor-not-allowed"
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
  scenario: WalletScenario = 'defaultArgon',
  interactive = false,
) {
  setupWalletScenario(scenario);
  showTreasuryUpgrade = false;
  const wallets = useWallets();
  request = {
    wallet: walletType === WalletType.argon ? wallets.argonWallets.defaultArgonWallet : wallets.bitcoinWallet,
    view,
  };
  isInteractive.value = interactive;
}

async function openTokenMenu({
  moveToken,
  rightClick = false,
  rowFraction = 0.5,
}: {
  moveToken: MoveToken;
  rightClick?: boolean;
  rowFraction?: number;
}) {
  const row = await within(document.body).findByRole('button', { name: `${moveToken} actions` });
  const bounds = row.getBoundingClientRect();
  await userEvent.pointer({
    target: row,
    keys: rightClick ? '[MouseRight]' : '[MouseLeft]',
    coords: { clientX: bounds.left + bounds.width * rowFraction, clientY: bounds.top + bounds.height / 2 },
  });
}

function useTokenMenuScenario() {
  useScenario(WalletType.argon, undefined, 'bitcoinSend', true);
  mocked(loadEthereumChainConfig).mockResolvedValue({
    chainId: 1,
    gatewayAddress: '0x5555555555555555555555555555555555555555',
    argonTokenAddress: '0x6666666666666666666666666666666666666666',
    argonotTokenAddress: '0x7777777777777777777777777777777777777777',
  });
}

function useEthereumMenuScenario() {
  setupWalletTransferScenario('inboundArgonOnly');
  showTreasuryUpgrade = false;
  isInteractive.value = true;
  request = { wallet: useWallets().ethereumWallets.persistedWallets[0] };
}

function useDefaultEthereumMenuScenario() {
  useEthereumMenuScenario();
  const wallets = useWallets();
  const importedWallet = wallets.ethereumWallets.persistedWallets[0];
  const coreRecord = {
    ...importedWallet.record!,
    address: getWalletKeys().coreEthereumAddress,
    name: 'Default Ethereum',
    secretKind: 'coreMnemonic' as const,
  };
  delete coreRecord.encryptedSecret;
  const coreWallet = new WalletForEthereum(coreRecord.address, undefined, coreRecord, true);
  coreWallet.data = Vue.reactive({ ...importedWallet.data, address: coreRecord.address });
  coreWallet.refresh = fn(async () => undefined);
  Object.assign(wallets.ethereumWallets, {
    coreWallet,
    persistedWallets: [coreWallet],
    length: 1,
    find: fn((recordId: number) => (recordId === coreWallet.id ? coreWallet : undefined)),
    findByAddress: fn((address: string) =>
      address.toLowerCase() === coreWallet.address.toLowerCase() ? coreWallet : undefined,
    ),
  });
  request = { wallet: coreWallet };
}

function useBitcoinSendScenario() {
  useScenario(WalletType.argon, 'send', 'bitcoinSend', true);
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

function useBitcoinReleaseWaitingScenario() {
  useScenario(WalletType.argon, undefined, 'bitcoinWalletReleaseWaiting', true);
}

function useBitcoinReleaseErrorScenario() {
  useScenario(WalletType.argon, undefined, 'bitcoinWalletReleaseError', true);
}

function useBitcoinReleaseFailedScenario() {
  useScenario(WalletType.argon, undefined, 'bitcoinWalletReleaseFailed', true);
}

function useBitcoinUnattachedDepositScenario() {
  useScenario(WalletType.argon, undefined, 'bitcoinUnattachedDeposit', true);
}

async function waitForWalletOverlay() {
  await within(document.body).findByTestId('WalletOverlay');
}

export const MainWallet: Story = {
  beforeEach: () => useScenario(WalletType.argon),
  play: waitForWalletOverlay,
};

export const BitcoinWalletDetails: Story = {
  beforeEach: useBitcoinWalletDetailsScenario,
  play: async () => {
    const canvas = within(document.body);
    await userEvent.click(await canvas.findByRole('button', { name: 'Show Bitcoin details' }));
  },
};

export const FundedBitcoinConnector: Story = {
  name: 'Funded Bitcoin connector receive',
  beforeEach: useBitcoinConnectorReceiveScenario,
  play: async () => {
    const connector = document.querySelector<HTMLElement>('[data-wallet-connector-id="bitcoin"]');
    if (!connector) throw new Error('Bitcoin connector was not rendered');

    await userEvent.click(within(connector).getByText('Bitcoin', { exact: true }));
    isInteractive.value = false;
  },
};

export const BitcoinReceiveMinimumLoading: Story = {
  ...FundedBitcoinConnector,
  name: 'Bitcoin receive minimum loading',
  beforeEach: () => {
    useBitcoinConnectorReceiveScenario();
    getBitcoinLocks().minimumSatoshiPerLock = fn(
      () =>
        new Promise<bigint>(() => {
          // Keep this fixed preview at the external query's loading boundary.
        }),
    );
  },
};

export const BitcoinReceiveMinimumUnavailable: Story = {
  ...FundedBitcoinConnector,
  name: 'Bitcoin receive minimum unavailable',
  beforeEach: () => {
    useBitcoinConnectorReceiveScenario();
    getBitcoinLocks().minimumSatoshiPerLock = fn(async () => {
      throw new Error('Synthetic minimum query unavailable');
    });
  },
};

export const BitcoinReceiveProposedMinimum: Story = {
  name: 'Bitcoin receive with proposed 1,000-sat minimum',
  beforeEach: () => {
    useBitcoinConnectorReceiveScenario();
    const reservationExpiresAt = Date.now() + 25 * 60 * 60_000;
    getBitcoinLocks().getSecuritizationHoldExpirationTime = fn(() => reservationExpiresAt);
    getBitcoinLocks().minimumSatoshiPerLock = fn(async () => 1_000n);
  },
  play: async () => {
    const connector = document.querySelector<HTMLElement>('[data-wallet-connector-id="bitcoin"]');
    if (!connector) throw new Error('Bitcoin connector was not rendered');
    await userEvent.click(within(connector).getByText('Bitcoin', { exact: true }));
    isInteractive.value = false;
  },
};

function useBitcoinConnectorReceiveScenario() {
  useBitcoinWalletDetailsScenario();
  getConfig().upstreamOperator = { name: 'Testing', vaultId: 101 };
  const reservationExpiresAt = Date.now() + (12 * 60 + 27) * 60_000;
  getBitcoinLocks().getSecuritizationHoldExpirationTime = fn(() => reservationExpiresAt);
  useWallets().bitcoinWallet.getChannelFundingAddress = lock =>
    getBitcoinLocks().formatP2wshAddress(lock.scriptDetails!.p2wshScriptHashHex);
}

export const BitcoinReceiveQrCode: Story = {
  ...FundedBitcoinConnector,
  name: 'Bitcoin receive QR code',
  play: async () => {
    const canvas = within(document.body);
    const connector = document.querySelector<HTMLElement>('[data-wallet-connector-id="bitcoin"]');
    if (!connector) throw new Error('Bitcoin connector was not rendered');

    await userEvent.click(within(connector).getByText('Bitcoin', { exact: true }));
    await userEvent.hover(await canvas.findByRole('button', { name: 'Show Bitcoin address QR code' }));
    await canvas.findByRole('img', { name: 'Bitcoin receive address QR code' });
    isInteractive.value = false;
  },
};

export const UpdateInsurancePending: Story = {
  beforeEach: useBitcoinWalletInsurancePendingScenario,
  play: async () => {
    const canvas = within(document.body);

    await userEvent.click(await canvas.findByRole('button', { name: 'Show Bitcoin details' }));
    const channelRow = canvas.getAllByRole('button', { name: /Channel/ })[0];
    await userEvent.click(channelRow);
  },
};

export const UpdateInsuranceWithoutCosignerCapacity: Story = {
  beforeEach: useBitcoinWalletInsuranceUnavailableScenario,
  play: async () => {
    const canvas = within(document.body);

    await userEvent.click(await canvas.findByRole('button', { name: 'Show Bitcoin details' }));
    await userEvent.click(canvas.getAllByRole('button', { name: /Channel/ })[0]);
  },
};

export const UpdateInsuranceAfterBitcoinPriceIncrease: Story = {
  beforeEach: useBitcoinWalletInsurancePriceIncreaseScenario,
  play: async () => {
    const canvas = within(document.body);

    await userEvent.click(await canvas.findByRole('button', { name: 'Show Bitcoin details' }));
    await userEvent.click(canvas.getAllByRole('button', { name: /Channel/ })[0]);
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
    await new Promise(resolve => setTimeout(resolve, 350));
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
    await within(insuranceOverlay).findByText('Unable to update Bitcoin insurance.');
  },
};

export const TreasuryAddEthereumWalletGuide: Story = {
  beforeEach: () => {
    useScenario(WalletType.argon);
    const wallets = useWallets();
    wallets.ethereumWallets.persistedWallets.splice(0);
    getConfig().hasExtensionTreasury = true;
    const controller = useCertificationController();
    controller.chainProgress.hasOperationalAccount = true;
    controller.chainProgress.hasTreasuryUniswapTransfer = false;
    controller.activeGuideId = OperationalStepId.TreasuryTransfer;
  },
};

export const TreasurySelectEthereumWalletGuide: Story = {
  beforeEach: () => {
    useScenario(WalletType.argon);
    getConfig().hasExtensionTreasury = true;
    const controller = useCertificationController();
    controller.chainProgress.hasOperationalAccount = true;
    controller.chainProgress.hasTreasuryUniswapTransfer = false;
    controller.activeGuideId = OperationalStepId.TreasuryTransfer;
  },
};

export const TreasuryTransferGuideComplete: Story = {
  beforeEach: () => {
    useScenario(WalletType.argon);
    getConfig().hasExtensionTreasury = true;
    const controller = useCertificationController();
    controller.chainProgress.hasOperationalAccount = true;
    controller.chainProgress.hasTreasuryUniswapTransfer = true;
    controller.activeGuideId = OperationalStepId.TreasuryTransfer;
  },
};

export const TreasuryEthereumMenuGuide: Story = {
  beforeEach: () => {
    useEthereumMenuScenario();
    getConfig().hasExtensionTreasury = true;
    const controller = useCertificationController();
    controller.chainProgress.hasOperationalAccount = true;
    controller.chainProgress.hasTreasuryUniswapTransfer = false;
    controller.activeGuideId = OperationalStepId.TreasuryTransfer;
  },
  play: async () => {
    const canvas = within(document.body);
    await userEvent.click(await canvas.findByRole('button', { name: 'Ethereum Treasury options' }));
    await canvas.findByRole('menuitem', { name: 'Uniswap Market for ARGNOT' });
    await userEvent.click(await canvas.findByRole('button', { name: 'Task guidance' }));
    isInteractive.value = false;
  },
};

export const TreasuryEthereumMenuButtonGuide: Story = {
  beforeEach: () => {
    useEthereumMenuScenario();
    isInteractive.value = false;
    getConfig().hasExtensionTreasury = true;
    const controller = useCertificationController();
    controller.chainProgress.hasOperationalAccount = true;
    controller.chainProgress.hasTreasuryUniswapTransfer = false;
    controller.activeGuideId = OperationalStepId.TreasuryTransfer;
  },
};

export const EthereumMenu: Story = {
  beforeEach: useEthereumMenuScenario,
  play: async () => {
    const canvas = within(document.body);
    await userEvent.click(await canvas.findByRole('button', { name: 'Ethereum Treasury options' }));
    await canvas.findByRole('menuitem', { name: 'Uniswap Market for ARGNOT' });
    isInteractive.value = false;
  },
};

export const EthereumMenuOnSepolia: Story = {
  beforeEach: () => {
    useEthereumMenuScenario();
    mocked(loadEthereumChainConfig).mockResolvedValue({
      chainId: 11155111,
      gatewayAddress: '0x5555555555555555555555555555555555555555',
      argonTokenAddress: '0x6666666666666666666666666666666666666666',
      argonotTokenAddress: '0x7777777777777777777777777777777777777777',
    });
  },
  play: EthereumMenu.play,
};

export const EthereumMenuLinksLoading: Story = {
  beforeEach: () => {
    useEthereumMenuScenario();
    mocked(loadEthereumChainConfig).mockImplementation(() => new Promise(() => undefined));
  },
  play: EthereumMenu.play,
};

export const DefaultEthereumMenu: Story = {
  beforeEach: useDefaultEthereumMenuScenario,
  play: async () => {
    const canvas = within(document.body);
    await userEvent.click(await canvas.findByRole('button', { name: 'Default Ethereum options' }));
    isInteractive.value = false;
  },
};

export const DefaultEthereumPrivateKey: Story = {
  beforeEach: useDefaultEthereumMenuScenario,
  play: async () => {
    const canvas = within(document.body);
    await userEvent.click(await canvas.findByRole('button', { name: 'Default Ethereum options' }));
    await userEvent.click(canvas.getByRole('menuitem', { name: 'Export Private Key' }));
    isInteractive.value = false;
  },
};

export const DefaultEthereumPrivateKeyLoading: Story = {
  beforeEach: () => {
    useDefaultEthereumMenuScenario();
    mocked(getWalletKeys().exportEthereumPrivateKey).mockImplementation(() => new Promise(() => undefined));
  },
  play: DefaultEthereumPrivateKey.play,
};

export const DefaultEthereumPrivateKeyShown: Story = {
  beforeEach: useDefaultEthereumMenuScenario,
  play: async () => {
    const canvas = within(document.body);
    await userEvent.click(await canvas.findByRole('button', { name: 'Default Ethereum options' }));
    await userEvent.click(canvas.getByRole('menuitem', { name: 'Export Private Key' }));
    await userEvent.click(await canvas.findByRole('button', { name: 'Show' }));
    isInteractive.value = false;
  },
};

export const DefaultEthereumPrivateKeyError: Story = {
  beforeEach: () => {
    useDefaultEthereumMenuScenario();
    mocked(getWalletKeys().exportEthereumPrivateKey).mockRejectedValue(
      new Error('Synthetic private-key export failure.'),
    );
  },
  play: DefaultEthereumPrivateKey.play,
};

export const RenameEthereumWallet: Story = {
  beforeEach: useEthereumMenuScenario,
  play: async () => {
    const canvas = within(document.body);
    await userEvent.click(await canvas.findByRole('button', { name: 'Ethereum Treasury options' }));
    await userEvent.click(canvas.getByRole('menuitem', { name: 'Rename' }));
    isInteractive.value = false;
  },
};

export const RenameEthereumWalletSaving: Story = {
  beforeEach: () => {
    useEthereumMenuScenario();
    mocked(useWallets().ethereumWallets.rename).mockImplementation(() => new Promise(() => undefined));
  },
  play: async () => {
    const canvas = within(document.body);
    await userEvent.click(await canvas.findByRole('button', { name: 'Ethereum Treasury options' }));
    await userEvent.click(canvas.getByRole('menuitem', { name: 'Rename' }));
    await userEvent.click(await canvas.findByRole('button', { name: 'Save' }));
    isInteractive.value = false;
  },
};

export const RenameEthereumWalletFailed: Story = {
  beforeEach: () => {
    useEthereumMenuScenario();
    mocked(useWallets().ethereumWallets.rename).mockRejectedValue(new Error('Unable to save the wallet name.'));
  },
  play: RenameEthereumWalletSaving.play,
};

export const EthereumWalletRenamed: Story = {
  beforeEach: useEthereumMenuScenario,
  play: async () => {
    const canvas = within(document.body);
    await userEvent.click(await canvas.findByRole('button', { name: 'Ethereum Treasury options' }));
    await userEvent.click(canvas.getByRole('menuitem', { name: 'Rename' }));
    const name = await canvas.findByRole('textbox', { name: 'Wallet Name' });
    await userEvent.clear(name);
    await userEvent.type(name, 'Trading Wallet');
    await userEvent.click(canvas.getByRole('button', { name: 'Save' }));
    isInteractive.value = false;
  },
};

export const RemoveEthereumWallet: Story = {
  beforeEach: useEthereumMenuScenario,
  play: async () => {
    const canvas = within(document.body);
    await userEvent.click(await canvas.findByRole('button', { name: 'Ethereum Treasury options' }));
    await userEvent.click(canvas.getByRole('menuitem', { name: 'Remove' }));
    isInteractive.value = false;
  },
};

export const TreasuryTransferNeedsEth: Story = {
  beforeEach: () => {
    useScenario(WalletType.argon);
    const wallets = useWallets();
    request.wallet = wallets.ethereumWallets.persistedWallets[0];
    getConfig().hasExtensionTreasury = true;
    const controller = useCertificationController();
    controller.chainProgress.hasOperationalAccount = true;
    controller.chainProgress.hasTreasuryUniswapTransfer = false;
    controller.activeGuideId = OperationalStepId.TreasuryTransfer;
  },
};

export const TreasuryTransferNeedsArgn: Story = {
  beforeEach: () => {
    setupWalletTransferScenario('inboundEmpty');
    showTreasuryUpgrade = false;
    isInteractive.value = false;
    const wallets = useWallets();
    wallets.ethereumWallets.persistedWallets.splice(1);
    request = { wallet: wallets.ethereumWallets.persistedWallets[0] };
    getConfig().hasExtensionTreasury = true;
    const controller = useCertificationController();
    controller.chainProgress.hasOperationalAccount = true;
    controller.chainProgress.hasTreasuryUniswapTransfer = false;
    controller.activeGuideId = OperationalStepId.TreasuryTransfer;
  },
};

export const TreasuryFundingHelpOpenedGuide: Story = {
  beforeEach: TreasuryTransferNeedsArgn.beforeEach,
  play: async () => {
    isInteractive.value = true;
    const canvas = within(document.body);
    const fundingHelp = await canvas.findByRole('link', { name: 'How to add funds to Uniswap ↗' });
    fundingHelp.addEventListener('click', event => event.preventDefault(), { once: true });
    await userEvent.click(fundingHelp);
    isInteractive.value = false;
  },
};

export const TreasuryMarketLinksAfterFundingGuide: Story = {
  beforeEach: TreasuryTransferNeedsArgn.beforeEach,
  play: async () => {
    isInteractive.value = true;
    const canvas = within(document.body);
    const fundingHelp = await canvas.findByRole('link', { name: 'How to add funds to Uniswap ↗' });
    fundingHelp.addEventListener('click', event => event.preventDefault(), { once: true });
    await userEvent.click(fundingHelp);
    await userEvent.click(await canvas.findByRole('button', { name: 'Ethereum Treasury options' }));
    isInteractive.value = false;
  },
};

export const TreasuryInitiateTransferGuide: Story = {
  beforeEach: () => {
    setupWalletTransferScenario('inboundArgonOnly');
    showTreasuryUpgrade = false;
    isInteractive.value = true;
    request = { wallet: useWallets().ethereumWallets.persistedWallets[0] };
    getConfig().hasExtensionTreasury = true;
    const controller = useCertificationController();
    controller.chainProgress.hasOperationalAccount = true;
    controller.chainProgress.hasTreasuryUniswapTransfer = false;
    controller.activeGuideId = OperationalStepId.TreasuryTransfer;
  },
  play: async () => {
    const canvas = within(document.body);
    await userEvent.click(await canvas.findByRole('button', { name: 'Ethereum Treasury options' }));
    await userEvent.keyboard('{Escape}');
    isInteractive.value = false;
  },
};

export const TreasuryTransferStartedGuide: Story = {
  beforeEach: () => {
    const scenario = setupWalletTransferScenario('inboundRelay');
    showTreasuryUpgrade = false;
    isInteractive.value = true;
    request = { wallet: useWallets().ethereumWallets.persistedWallets[0] };
    getConfig().hasExtensionTreasury = true;
    const controller = useCertificationController();
    controller.chainProgress.hasOperationalAccount = true;
    controller.chainProgress.hasTreasuryUniswapTransfer = false;
    controller.activeGuideId = OperationalStepId.TreasuryTransfer;
    return scenario.cleanup;
  },
  play: async () => {
    const canvas = within(document.body);
    await userEvent.click(await canvas.findByRole('button', { name: /Initiate Transfer/ }));
    await canvas.findByRole('button', { name: 'Create Another Transaction' });
    isInteractive.value = false;
  },
};

export const TreasuryTransferPendingGuide: Story = {
  beforeEach: () => {
    const scenario = setupWalletTransferScenario('existingInbound');
    showTreasuryUpgrade = false;
    isInteractive.value = false;
    request = { wallet: useWallets().argonWallets.defaultArgonWallet };
    getConfig().hasExtensionTreasury = true;
    const controller = useCertificationController();
    controller.chainProgress.hasOperationalAccount = true;
    controller.chainProgress.hasTreasuryUniswapTransfer = false;
    controller.activeGuideId = OperationalStepId.TreasuryTransfer;
    return scenario.cleanup;
  },
};

export const TreasuryWatchTransferProgress: Story = {
  beforeEach: () => {
    const scenario = setupWalletTransferScenario('inboundArgon');
    showTreasuryUpgrade = false;
    isInteractive.value = true;
    request = { wallet: useWallets().ethereumWallets.persistedWallets[0] };
    getConfig().hasExtensionTreasury = true;
    const controller = useCertificationController();
    controller.chainProgress.hasOperationalAccount = true;
    controller.chainProgress.hasTreasuryUniswapTransfer = false;
    controller.activeGuideId = OperationalStepId.TreasuryTransfer;
    return scenario.cleanup;
  },
  play: async () => {
    const canvas = within(document.body);
    await userEvent.click(await canvas.findByRole('button', { name: /Initiate Transfer/ }));
    await canvas.findByRole('button', { name: 'Create Another Transaction' });
    await userEvent.click(canvas.getByTestId('ConnectorTransfer.close()'));
    await userEvent.click(await canvas.findByRole('button', { name: '1 Transfer Pending' }));
    isInteractive.value = false;
  },
};

function useBitcoinReceiveGuideScenario(scenario: WalletScenario = 'defaultArgon') {
  useScenario(WalletType.argon, undefined, scenario, true);
  const config = getConfig();
  config.hasExtensionTreasury = true;
  config.upstreamOperator = { name: 'Testing', vaultId: 7 };
  const vaults = getVaults();
  vaults.vaultsById[7] = createScenarioVault({ vaultId: 7 });
  vaults.refreshVault = fn(async (vaultId: number) => vaults.vaultsById[vaultId]);
  Object.assign(getBitcoinLocks(), {
    getLockableBitcoinCapacity: fn(async () => ({
      availableSatoshis: 1_000_000n,
      availableLiquidityMicrogons: 600_000_000n,
      vaultCapacitySatoshis: 1_000_000n,
      vaultCapacityLiquidityMicrogons: 600_000_000n,
    })),
  });
  Object.assign(getBitcoinTransactionOperations(), {
    bitcoinLockCreate: {
      preview: fn(async () => ({
        canAfford: true,
        requiredWalletBalanceMicrogons: 125_000n,
        securityFee: 0n,
        txFeePlusTip: 125_000n,
      })),
    },
  });
  const controller = useCertificationController();
  controller.chainProgress.hasOperationalAccount = true;
  controller.chainProgress.hasBitcoinLock = false;
  controller.activeGuideId = OperationalStepId.LiquidLock;
}

async function openBitcoinReceiveConnector(vaultId?: number, openGuide = true) {
  await waitForWalletOverlay();
  const connector = document.querySelector<HTMLElement>('[data-wallet-connector-id="bitcoin"]');
  if (!connector) throw new Error('Bitcoin connector was not rendered');
  await userEvent.click(within(connector).getByText('Bitcoin', { exact: true }));
  await within(document.body).findByTestId('ConnectorChannel');
  if (vaultId !== undefined) {
    await userEvent.click(within(document.body).getByTestId(`ConnectorChannel.selectVault-${vaultId}`));
  }
  if (openGuide) await showBitcoinGuide();
  else isInteractive.value = false;
}

async function showBitcoinGuide() {
  await userEvent.click(await within(document.body).findByRole('button', { name: 'Task guidance' }));
  isInteractive.value = false;
}

export const BitcoinReceiveGuide: Story = {
  beforeEach: () => useBitcoinReceiveGuideScenario(),
  play: async () => {
    await waitForWalletOverlay();
    await showBitcoinGuide();
  },
};

export const BitcoinReceiveConnectorGuide: Story = {
  name: 'Bitcoin Receive Insurance Guide',
  beforeEach: () => useBitcoinReceiveGuideScenario(),
  play: () => openBitcoinReceiveConnector(undefined, false),
};

export const BitcoinReceiveAddressSetupGuide: Story = {
  beforeEach: () => {
    useBitcoinReceiveGuideScenario('pendingBitcoinFunding');
    const bitcoinLocks = getBitcoinLocks();
    const locks = bitcoinLocks.getAllLocks();
    locks.splice(1);
    locks[0].status = BitcoinLockStatus.Released;
    locks[0].removalBlockTime = new Date('2026-08-31T15:30:00.000Z');
    bitcoinLocks.utxoTracking.load([]);
  },
  play: () => openBitcoinReceiveConnector(undefined, false),
};

export const BitcoinReceiveCreateAddressGuide: Story = {
  beforeEach: () => useBitcoinReceiveGuideScenario(),
  play: async () => {
    await openBitcoinReceiveConnector(undefined, false);
    isInteractive.value = true;
    await userEvent.click(await within(document.body).findByRole('button', { name: 'Next' }));
    isInteractive.value = false;
  },
};

export const BitcoinReceiveAddressPreparingGuide: Story = {
  beforeEach: () => {
    useBitcoinReceiveGuideScenario();
    useWallets().bitcoinWallet.isCreatingChannel = fn(() => true);
  },
  play: () => openBitcoinReceiveConnector(undefined, false),
};

export const BitcoinReceiveAddressConfirmingGuide: Story = {
  beforeEach: () => {
    useBitcoinReceiveGuideScenario('pendingBitcoinFunding');
    getBitcoinLocks().getAllLocks()[0].status = BitcoinLockStatus.LockIsProcessingOnArgon;
    getBitcoinLocks().utxoTracking.load([]);
  },
  play: () => openBitcoinReceiveConnector(undefined, false),
};

export const BitcoinReceiveVaultChoicesGuide: Story = {
  beforeEach: () => {
    useBitcoinReceiveGuideScenario();
    getMyVault().data.createdVault = createScenarioVault({ vaultId: 8 });
  },
  play: () => openBitcoinReceiveConnector(),
};

export const BitcoinReceivePersonalAddressGuide: Story = {
  beforeEach: () => {
    useBitcoinReceiveGuideScenario();
    getMyVault().data.createdVault = createScenarioVault({ vaultId: 8 });
  },
  play: () => openBitcoinReceiveConnector(8),
};

export const BitcoinReceiveAddressGuide: Story = {
  beforeEach: () => {
    useBitcoinReceiveGuideScenario('pendingBitcoinFunding');
    getBitcoinLocks().utxoTracking.load([]);
  },
  play: () => openBitcoinReceiveConnector(undefined, false),
};

export const BitcoinReceiveAddressPricingUnavailableGuide: Story = {
  beforeEach: () => {
    useBitcoinReceiveGuideScenario('pendingBitcoinFunding');
    getBitcoinLocks().utxoTracking.load([]);
    getCurrency().priceIndex.btcUsdPrice = undefined;
  },
  play: () => openBitcoinReceiveConnector(undefined, false),
};

export const BitcoinReceiveAddressTargetCoveredGuide: Story = {
  beforeEach: () => {
    useBitcoinReceiveGuideScenario('bitcoinSend');
    const bitcoinLocks = getBitcoinLocks();
    const locks = bitcoinLocks.getAllLocks();
    locks.splice(1);
    const lock = locks[0];
    lock.vaultId = 7;
    lock.ownerAccount = '5SyntheticInternalWallet';
    lock.microgonsAtTargetPerBtc = 68_000_000_000n;
    lock.fissionedSatoshis = lock.fundedSatoshis;
    const fission = new BitcoinFission({
      ownerAccount: lock.ownerAccount,
      fissionId: 1,
      liquidId: 1,
      lockId: lock.lockId!,
      satoshis: lock.fundedSatoshis,
      microgonsAtTargetPerBtc: lock.microgonsAtTargetPerBtc,
      liquidityPromised: 680_000_000n,
      createdAtArgonBlock: 18_500,
      ratchetNumber: 0,
      lastRatchetTick: 10_000,
      lastUpdatedArgonBlock: 18_500,
    });
    const bitcoinFissions = getBitcoinFissions();
    bitcoinFissions.data.fissionsById = { [fission.fissionId]: fission };
    bitcoinFissions.data.activeFissionIds.add(fission.fissionId);
    getCurrency().priceIndex.btcUsdPrice = undefined;
  },
  play: () => openBitcoinReceiveConnector(),
};

export const BitcoinReceiveFundingGuide: Story = {
  beforeEach: () => useBitcoinReceiveGuideScenario('pendingBitcoinFunding'),
  play: () => openBitcoinReceiveConnector(undefined, false),
};

export const BitcoinReceiveProgressGuide: Story = {
  beforeEach: () => useBitcoinReceiveGuideScenario('pendingBitcoinFunding'),
  play: async () => {
    await waitForWalletOverlay();
    isInteractive.value = false;
  },
};

export const BitcoinReceiveLoadErrorGuide: Story = {
  beforeEach: () => {
    useBitcoinReceiveGuideScenario();
    useWallets().bitcoinWallet.loadChannels = fn(async () => {
      throw new Error('Unable to load Bitcoin receive options.');
    });
  },
  play: () => openBitcoinReceiveConnector(),
};

export const BitcoinFundingConfirmedGuide: Story = {
  beforeEach: () => {
    useScenario(WalletType.argon, undefined, 'bitcoinSend');
    getConfig().hasExtensionTreasury = true;
    const controller = useCertificationController();
    controller.chainProgress.hasOperationalAccount = true;
    controller.chainProgress.hasBitcoinLock = false;
    controller.activeGuideId = OperationalStepId.LiquidLock;
  },
};

export const BitcoinFundingConfirmedConnectorGuide: Story = {
  beforeEach: () => {
    useBitcoinReceiveGuideScenario('bitcoinSend');
    getBitcoinLocks().getAllLocks()[0].vaultId = 7;
  },
  play: () => openBitcoinReceiveConnector(),
};

export const BitcoinConnector: Story = {
  beforeEach: () => useScenario(WalletType.argon, undefined, 'defaultArgon', true),
  play: async () => {
    await waitForWalletOverlay();
    await userEvent.click(await within(document.body).findByText('Create Channel', { exact: true }));
    isInteractive.value = false;
  },
};

export const BitcoinChannelFundingPending: Story = {
  beforeEach: usePendingBitcoinFundingScenario,
  play: async () => {
    const canvas = within(document.body);

    await userEvent.click(await canvas.findByRole('button', { name: '1 Transfer Pending' }));
  },
};

export const BitcoinDepositBelowMinimum: Story = {
  beforeEach: () => {
    usePendingBitcoinFundingScenario();
    const tracking = getBitcoinLocks().utxoTracking;
    const record = tracking.getUtxosForLock(101)[0];
    record.satoshis = 500n;
    record.fundingRejectionReason = 'BelowMinimum';
    record.firstSeenBitcoinHeight = 0;
    if (record.mempoolObservation) {
      record.mempoolObservation.isConfirmed = false;
      record.mempoolObservation.confirmations = 0;
      record.mempoolObservation.transactionBlockHeight = 0;
    }
  },
  play: async () => {
    await userEvent.click(await within(document.body).findByRole('button', { name: '1 Transfer Needs Attention' }));
    await within(document.body).findByText('100,000 sats.', { exact: true });
    isInteractive.value = false;
  },
};

export const BitcoinDepositMinimumUnavailable: Story = {
  beforeEach: () => {
    usePendingBitcoinFundingScenario();
    const record = getBitcoinLocks().utxoTracking.getUtxosForLock(101)[0];
    record.satoshis = 500n;
    record.fundingRejectionReason = 'BelowMinimum';
    spyOn(getBitcoinLocks(), 'minimumSatoshiPerLock').mockRejectedValue(new Error('Synthetic minimum query failure'));
  },
  play: async () => {
    await userEvent.click(await within(document.body).findByRole('button', { name: '1 Transfer Needs Attention' }));
    isInteractive.value = false;
  },
};

export const BitcoinDepositErrorAcknowledged: Story = {
  beforeEach: () => {
    usePendingBitcoinFundingScenario();
    const record = getBitcoinLocks().utxoTracking.getUtxosForLock(101)[0];
    record.satoshis = 500n;
    record.fundingRejectionReason = 'BelowMinimum';
    record.isFailureAcknowledged = true;
    isInteractive.value = false;
  },
};

export const BitcoinChannelReleasePending: Story = {
  beforeEach: usePendingBitcoinReleaseScenario,
  play: async () => {
    const canvas = within(document.body);

    await userEvent.click(await canvas.findByRole('button', { name: '1 Transfer Pending' }));
  },
};

export const BitcoinPendingOutbound: Story = {
  beforeEach: useBitcoinReleaseWaitingScenario,
  play: async () => {
    const canvas = within(document.body);

    await userEvent.click(await canvas.findByRole('button', { name: 'Show Bitcoin details' }));
  },
};

export const BitcoinPendingOutboundProgress: Story = {
  beforeEach: useBitcoinReleaseWaitingScenario,
  play: async () => {
    const canvas = within(document.body);

    await userEvent.click(await canvas.findByRole('button', { name: 'Show Bitcoin details' }));
    await userEvent.click(canvas.getByTestId('WalletViewMain.bitcoinSend'));
    await canvas.findByText(/due in 10 days/);
  },
};

export const BitcoinPendingOutboundError: Story = {
  beforeEach: useBitcoinReleaseErrorScenario,
  play: async () => {
    const canvas = within(document.body);

    await userEvent.click(await canvas.findByRole('button', { name: 'Show Bitcoin details' }));
    await userEvent.click(canvas.getByTestId('WalletViewMain.bitcoinSend'));
    await canvas.findByText('Unable to broadcast this Bitcoin transaction.');
  },
};

export const BitcoinFailedOutbound: Story = {
  beforeEach: useBitcoinReleaseFailedScenario,
  play: async () => {
    const canvas = within(document.body);

    await userEvent.click(await canvas.findByRole('button', { name: 'Show Bitcoin details' }));
    await userEvent.click(canvas.getByTestId('WalletViewMain.bitcoinSend'));
  },
};

export const BitcoinFailedOutboundInTransfers: Story = {
  beforeEach: useBitcoinReleaseFailedScenario,
  play: async () => {
    const canvas = within(document.body);

    await userEvent.click(await canvas.findByRole('button', { name: '1 Transfer Needs Attention' }));
  },
};

export const BitcoinUnattachedDeposit: Story = {
  beforeEach: useBitcoinUnattachedDepositScenario,
  play: waitForWalletOverlay,
};

export const BitcoinUnattachedDepositReturn: Story = {
  beforeEach: useBitcoinUnattachedDepositScenario,
  play: async () => {
    const canvas = within(document.body);

    await userEvent.click(await canvas.findByTestId('WalletViewMain.unattachedBitcoinDeposit'));
  },
};

export const BitcoinUnattachedReturnHistoryUnavailable: Story = {
  beforeEach: () => {
    useBitcoinUnattachedDepositScenario();
    const locks = getBitcoinLocks();
    const record = locks.utxoTracking
      .getUtxosForLock(101)
      .find(record => record.status === BitcoinUtxoStatus.Orphaned)!;
    record.isOnArgonChain = false;
    record.activeReleaseId = 'synthetic-unattached-return';
    const release = createBitcoinRelease({
      id: record.activeReleaseId,
      kind: BitcoinReleaseKind.Orphan,
      lockId: record.lockId,
      inputUtxoIds: [record.id],
      status: BitcoinReleaseStatus.WaitingForVaultCosign,
      statusError: 'The activity index is not ready to restore this Bitcoin return. Please retry shortly.',
      requestedReleaseAtTick: 10_001,
    });
    locks.releases.data.releasesById[release.id] = release;
  },
  play: async () => {
    await userEvent.click(await within(document.body).findByTestId('WalletViewMain.unattachedBitcoinDeposit'));
    isInteractive.value = false;
  },
};

export const PendingTransferLoadFailureKeepsAvailableRows: Story = {
  beforeEach: usePendingTransferLoadErrorScenario,
  play: async () => {
    const canvas = within(document.body);

    await userEvent.click(await canvas.findByRole('button', { name: '1 Transfer Pending' }));
  },
};

export const SendTokens: Story = {
  beforeEach: () => useScenario(WalletType.argon, 'send'),
  play: waitForWalletOverlay,
};

export const ArgonTokenMenu: Story = {
  beforeEach: useTokenMenuScenario,
  play: async () => {
    await openTokenMenu({ moveToken: MoveToken.ARGN });
    isInteractive.value = false;
  },
};

export const ArgonTokenMenuNearRowEnd: Story = {
  beforeEach: useTokenMenuScenario,
  play: async () => {
    await openTokenMenu({ moveToken: MoveToken.ARGN, rowFraction: 0.9 });
    isInteractive.value = false;
  },
};

export const ArgonotTokenMenu: Story = {
  beforeEach: useTokenMenuScenario,
  play: async () => {
    await openTokenMenu({ moveToken: MoveToken.ARGNOT });
    isInteractive.value = false;
  },
};

export const BitcoinTokenMenu: Story = {
  beforeEach: useTokenMenuScenario,
  play: async () => {
    await openTokenMenu({ moveToken: MoveToken.BTC });
    isInteractive.value = false;
  },
};

export const ArgonTokenMenuByRightClick: Story = {
  beforeEach: useTokenMenuScenario,
  play: async () => {
    await openTokenMenu({ moveToken: MoveToken.ARGN, rightClick: true, rowFraction: 0.1 });
    isInteractive.value = false;
  },
};

export const BitcoinTokenMenuByRightClick: Story = {
  beforeEach: useTokenMenuScenario,
  play: async () => {
    await openTokenMenu({ moveToken: MoveToken.BTC, rightClick: true, rowFraction: 0.9 });
    isInteractive.value = false;
  },
};

export const ArgonotTokenMenuByKeyboard: Story = {
  beforeEach: useTokenMenuScenario,
  play: async () => {
    const row = await within(document.body).findByRole('button', { name: 'ARGNOT actions' });
    row.focus();
    await userEvent.keyboard('{Enter}');
    isInteractive.value = false;
  },
};

export const ArgonTokenMenuAtZeroBalance: Story = {
  beforeEach: () => {
    useTokenMenuScenario();
    useWallets().defaultArgonWallet.availableMicrogons = 0n;
  },
  play: ArgonTokenMenu.play,
};

export const BitcoinTokenMenuAtZeroBalance: Story = {
  beforeEach: () => useScenario(WalletType.argon, undefined, 'defaultArgon', true),
  play: BitcoinTokenMenu.play,
};

export const ArgonotTokenMenuAtZeroBalance: Story = {
  beforeEach: () => {
    useTokenMenuScenario();
    useWallets().defaultArgonWallet.availableMicronots = 0n;
  },
  play: ArgonotTokenMenu.play,
};

export const TokenMenuLinksLoading: Story = {
  beforeEach: () => {
    useTokenMenuScenario();
    mocked(loadEthereumChainConfig).mockImplementation(() => new Promise(() => undefined));
  },
  play: ArgonTokenMenu.play,
};

export const TokenMenuLinksUnavailable: Story = {
  beforeEach: () => {
    useTokenMenuScenario();
    mocked(loadEthereumChainConfig).mockRejectedValue(new Error('Synthetic chain configuration failure'));
  },
  play: ArgonTokenMenu.play,
};

export const TokenMenuOnLocalEthereum: Story = {
  beforeEach: () => {
    useTokenMenuScenario();
    mocked(loadEthereumChainConfig).mockResolvedValue({
      chainId: 31337,
      gatewayAddress: '0x5555555555555555555555555555555555555555',
      argonTokenAddress: '0x6666666666666666666666666666666666666666',
      argonotTokenAddress: '0x7777777777777777777777777777777777777777',
    });
  },
  play: ArgonTokenMenu.play,
};

export const TokenMenuOnSepolia: Story = {
  beforeEach: () => {
    useTokenMenuScenario();
    mocked(loadEthereumChainConfig).mockResolvedValue({
      chainId: 11155111,
      gatewayAddress: '0x5555555555555555555555555555555555555555',
      argonTokenAddress: '0x6666666666666666666666666666666666666666',
      argonotTokenAddress: '0x7777777777777777777777777777777777777777',
    });
  },
  play: ArgonTokenMenu.play,
};

export const TokenMenuLinksRecovered: Story = {
  beforeEach: () => {
    useTokenMenuScenario();
    mocked(loadEthereumChainConfig).mockRejectedValueOnce(new Error('Synthetic chain configuration failure'));
  },
  play: async () => {
    const canvas = within(document.body);
    await openTokenMenu({ moveToken: MoveToken.ARGN });
    await canvas.findByText('Token links unavailable. Reopen this menu to retry.');
    await userEvent.keyboard('{Escape}');
    await openTokenMenu({ moveToken: MoveToken.ARGN });
    isInteractive.value = false;
  },
};

export const SendArgonFromTokenMenu: Story = {
  beforeEach: useTokenMenuScenario,
  play: async () => {
    const canvas = within(document.body);
    await openTokenMenu({ moveToken: MoveToken.ARGN });
    await userEvent.click(canvas.getByRole('menuitem', { name: 'Send ARGN' }));
    isInteractive.value = false;
  },
};

export const SendArgonotFromTokenMenu: Story = {
  beforeEach: useTokenMenuScenario,
  play: async () => {
    const canvas = within(document.body);
    await openTokenMenu({ moveToken: MoveToken.ARGNOT });
    await userEvent.click(canvas.getByRole('menuitem', { name: 'Send ARGNOT' }));
    isInteractive.value = false;
  },
};

export const SendBitcoinFromTokenMenu: Story = {
  beforeEach: useTokenMenuScenario,
  play: async () => {
    const canvas = within(document.body);
    await openTokenMenu({ moveToken: MoveToken.BTC });
    await userEvent.click(canvas.getByRole('menuitem', { name: 'Send BTC' }));
    isInteractive.value = false;
  },
};

export const ReceiveArgonFromTokenMenu: Story = {
  beforeEach: useTokenMenuScenario,
  play: async () => {
    const canvas = within(document.body);
    await openTokenMenu({ moveToken: MoveToken.ARGN });
    await userEvent.click(canvas.getByRole('menuitem', { name: 'Receive ARGN' }));
    isInteractive.value = false;
  },
};

export const ReceiveBitcoinFromTokenMenu: Story = {
  beforeEach: useTokenMenuScenario,
  play: async () => {
    const canvas = within(document.body);
    await openTokenMenu({ moveToken: MoveToken.BTC });
    await userEvent.click(canvas.getByRole('menuitem', { name: 'Receive BTC' }));
    isInteractive.value = false;
  },
};

export const RequestTreasuryAccessFromBitcoinChannels: Story = {
  beforeEach: () => {
    useTokenMenuScenario();
    showTreasuryUpgrade = true;
    Object.assign(useVaultingStats(), { argonBondsAPR: 7.2, argonotStakingAPR: 4.6 });
  },
  play: async () => {
    const canvas = within(document.body);
    await openTokenMenu({ moveToken: MoveToken.BTC });
    await userEvent.click(canvas.getByRole('menuitem', { name: 'Receive BTC' }));
    await userEvent.click(await canvas.findByRole('button', { name: 'Click to request access.' }));
    await canvas.findByText('Put Your Assets to Work');
    isInteractive.value = false;
  },
};

export const ReceiveArgonotFromTokenMenu: Story = {
  beforeEach: useTokenMenuScenario,
  play: async () => {
    const canvas = within(document.body);
    await openTokenMenu({ moveToken: MoveToken.ARGNOT });
    await userEvent.click(canvas.getByRole('menuitem', { name: 'Receive ARGNOT' }));
    isInteractive.value = false;
  },
};

export const SendEmptyWallet: Story = {
  beforeEach: () => {
    useScenario(WalletType.argon, 'send');
    Object.assign(useWallets().defaultArgonWallet, {
      availableMicrogons: 0n,
      reservedMicrogons: 0n,
      totalMicrogons: 0n,
      availableMicronots: 0n,
      totalMicronots: 0n,
    });
  },
  play: waitForWalletOverlay,
};

export const SendBitcoinOnlyWallet: Story = {
  beforeEach: () => {
    useBitcoinSendScenario();
    Object.assign(useWallets().defaultArgonWallet, {
      availableMicrogons: 0n,
      reservedMicrogons: 0n,
      totalMicrogons: 0n,
      availableMicronots: 0n,
      totalMicronots: 0n,
    });
  },
  play: async () => {
    const canvas = within(document.body);

    await userEvent.click(canvas.getByTestId('WalletViewSend.token'));
    await userEvent.click(canvas.getByTestId('BTC'));
  },
};

export const SendTokensFromWallet: Story = {
  beforeEach: () => useScenario(WalletType.argon, undefined, 'defaultArgon', true),
  play: async () => {
    const canvas = within(document.body);
    await userEvent.click(canvas.getByTestId('WalletViewMain.openSend()'));
  },
};

export const SendBitcoinFromChannels: Story = {
  beforeEach: useBitcoinSendScenario,
  play: async () => {
    const canvas = within(document.body);

    await userEvent.click(canvas.getByTestId('WalletViewSend.token'));
    await userEvent.click(canvas.getByTestId('BTC'));
    const amount = within(canvas.getByTestId('WalletViewSend.amount')).getByTestId('input-number');
    await userEvent.clear(amount);
    await userEvent.type(amount, '0.025');
    await userEvent.type(
      canvas.getByTestId('WalletTransferForm.destinationAddress'),
      'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh',
    );
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
  },
};

export const SendBitcoinReactsToLiquidAllocation: Story = {
  beforeEach: useBitcoinSendScenario,
  play: async () => {
    const canvas = within(document.body);

    await userEvent.click(canvas.getByTestId('WalletViewSend.token'));
    await userEvent.click(canvas.getByTestId('BTC'));

    const newlyAllocatedChannel = getBitcoinLocks()
      .getAllLocks()
      .find(channel => channel.lockId === 101)!;
    newlyAllocatedChannel.fissionedSatoshis = newlyAllocatedChannel.fundedSatoshis;
    await Vue.nextTick();
  },
};

export const SendBitcoinAtZeroBalance: Story = {
  beforeEach: () => useScenario(WalletType.argon, 'send', 'defaultArgon', true),
  play: async () => {
    const canvas = within(document.body);

    await userEvent.click(canvas.getByTestId('WalletViewSend.token'));
  },
};

export const ReceiveTokens: Story = {
  beforeEach: () => {
    useScenario(WalletType.argon, 'receive');
    useWallets().defaultArgonWallet.address = encodeAddress(new Uint8Array(32).fill(1));
  },
  play: waitForWalletOverlay,
};

export const ReceiveTokensQrCode: Story = {
  name: 'Receive tokens QR code',
  beforeEach: ReceiveTokens.beforeEach,
  play: async () => {
    isInteractive.value = true;
    await waitForWalletOverlay();
    const canvas = within(document.body);
    await userEvent.hover(await canvas.findByRole('button', { name: 'Show Argon address QR code' }));
    await canvas.findByRole('img', { name: 'Argon receive address QR code' });
    isInteractive.value = false;
  },
};

export const PrivateKey: Story = {
  beforeEach: () => useScenario(WalletType.argon, 'privateKey', 'defaultArgon', true),
  play: async () => {
    const canvas = within(document.body);

    await userEvent.click(await canvas.findByRole('button', { name: 'Show' }));
  },
};

export const PrivateKeyExportError: Story = {
  beforeEach: () => useScenario(WalletType.argon, 'privateKey', 'privateKeyError'),
  play: waitForWalletOverlay,
};
