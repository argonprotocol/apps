import type { Meta, StoryObj } from '@storybook/vue3-vite';
import { MICRONOTS_PER_ARGONOT, MoveToken, UnitOfMeasurement } from '@argonprotocol/apps-core';
import * as Vue from 'vue';
import { expect, fn, mocked, waitFor, within } from 'storybook/test';
import AppScreen from '../../components/AppScreen.vue';
import { setupAppScenario } from '../../scenarios/setupAppScenario.ts';
import { TopTab } from '../../../src-vue/interfaces/IConfig.ts';
import { CrosschainHistory, type ICrosschainHistoryRecord } from '../../../src-vue/lib/CrosschainHistory.ts';
import { createKnownCrosschainSourceIdentities } from '../../../src-vue/lib/CrosschainTransferView.ts';
import type { IMintingAuthorityAuthorization } from '../../../src-vue/lib/MintingAuthorities.ts';
import type { IVaultCollectNotice } from '../../../src-vue/lib/VaultCollectBuilder.ts';
import VaultAlert from '../../../src-vue/alerts/VaultAlert.vue';
import VaultCollectOverlay from '../../../src-vue/overlays/VaultCollectOverlay.vue';
import CrosschainTransfers from '../../../src-vue/screens/CrosschainTransfers.vue';
import { getCurrency } from '../../../src-vue/stores/currency.ts';
import {
  getCrosschainHistory,
  getKnownCrosschainSourceIdentities,
  getMyVault,
  getVaults,
} from '../../../src-vue/stores/vaults.ts';
import { getWalletKeys } from '../../../src-vue/stores/wallets.ts';
import { createScenarioVault } from '../../scenarios/createScenarioVault.ts';

const meta = {
  title: 'Crosschain/Overview',
  component: CrosschainTransfers,
  render: () => ({
    components: { AppScreen, CrosschainTransfers },
    template: '<AppScreen><CrosschainTransfers /></AppScreen>',
  }),
} satisfies Meta<typeof CrosschainTransfers>;

export default meta;
type Story = StoryObj<typeof meta>;

export const NavigationRefreshesRecoveredTips: Story = {
  render: () => ({
    components: { AppScreen },
    template: '<AppScreen><div data-testid="AccountOverview" /></AppScreen>',
  }),
  beforeEach: () => {
    setupAppScenario({
      selectedTab: TopTab.Home,
      config: { hasActivatedCrosschain: true },
    });
    setupCurrency();

    const history = createHistory();
    history.refresh = fn(async () => {
      history.data.records = [recoveredAuthorization];
    });
    mocked(getCrosschainHistory).mockReturnValue(history);
  },
  play: async ({ canvasElement }) => {
    const crosschainNavigation = within(canvasElement).getByTestId('LeftBar.goto(TopTab.CrosschainTransfers)');

    await waitFor(() => expect(within(crosschainNavigation).getByText('₳2.00')).toBeVisible());
  },
};

export const RecoveredTransferTips: Story = {
  beforeEach: () => {
    setupAppScenario({
      selectedTab: TopTab.CrosschainTransfers,
      config: { hasActivatedCrosschain: true },
    });

    selectUsdCurrency();

    getMyVault().globalCouncil.data.transferOutMicrogonsPerArgonot = 10_000_000n;

    const vault = createScenarioVault({ operatorAccountId: recoveredSourceAccount });
    const vaults = getVaults();
    vaults.vaultsById[vault.vaultId] = vault;
    mocked(vaults.load).mockImplementation(async () => {
      vaults.operatorNamesByVaultId[vault.vaultId] = 'Atlas';
    });
    mocked(getKnownCrosschainSourceIdentities).mockImplementation(() =>
      createKnownCrosschainSourceIdentities({
        networkName: 'localnet',
        vaultsById: vaults.vaultsById,
        operatorNamesByVaultId: vaults.operatorNamesByVaultId,
        localAccountIds: [getWalletKeys().defaultArgonAddress],
      }),
    );

    const history = createHistory();
    history.data.records = [recoveredAuthorization];

    mocked(getCrosschainHistory).mockReturnValue(history);
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const dashboard = canvas.getByTestId('CrosschainTransfersDashboard');
    const crosschainNavigation = canvas.getByTestId('LeftBar.goto(TopTab.CrosschainTransfers)');

    await expect(dashboard).toBeVisible();
    await expect(within(dashboard).getByText('Transfer Tips')).toBeVisible();
    await expect(within(dashboard).getByText('Tips Available')).toBeVisible();
    await expect(within(dashboard).getByText('0.5 ARGNOT tip')).toBeVisible();
    await expect(within(dashboard).getAllByText('Atlas')).not.toHaveLength(0);
    await expect(
      within(within(dashboard).getByText('Remaining Minting Authority').parentElement!).getByText('$0.00'),
    ).toBeVisible();
    await expect(
      within(within(dashboard).getByText('Transfer Value Sponsored').parentElement!).getByText('$50.00'),
    ).toBeVisible();
    await expect(within(within(dashboard).getByText('Transfer Tips').parentElement!).getByText('$2.00')).toBeVisible();
    await expect(within(within(dashboard).getByText('Tips Available').parentElement!).getByText('$0.00')).toBeVisible();
    await expect(within(crosschainNavigation).getByText('$2.00')).toBeVisible();
  },
};

export const PendingTipAlert: Story = {
  render: () => ({
    components: { VaultAlert },
    setup: () => ({ notice: pendingTipNotice }),
    template: '<div class="w-screen"><VaultAlert :notice="notice" variant="bar" /></div>',
  }),
  beforeEach: () => {
    setupAppScenario({ selectedTab: TopTab.CrosschainTransfers, config: { hasActivatedCrosschain: true } });
    selectUsdCurrency();
  },
  play: async ({ canvasElement }) => {
    const alert = within(canvasElement).getByTestId('VaultAlert.bar');

    await expect(alert).toBeVisible();
    await expect(within(alert).getByText('$2.00 in crosschain authorization tips is processing')).toBeVisible();
  },
};

export const PendingAuthorizationOverlay: Story = {
  render: () => ({
    components: { VaultCollectOverlay },
    template: '<VaultCollectOverlay />',
  }),
  beforeEach: () => {
    setupAppScenario({ selectedTab: TopTab.CrosschainTransfers, config: { hasActivatedCrosschain: true } });
    selectUsdCurrency();

    const myVault = getMyVault();
    myVault.mintingAuthorities.data.authorities = [
      {
        signer: '0xauthority',
        isPendingActivation: false,
        isDeactivating: false,
        isActive: true,
        gatewayRemainingMicrogonCollateral: 0n,
        pendingReservedMicrogonCollateral: 0n,
        gatewayRemainingMicronotCollateral: 2_000_000n,
        pendingReservedMicronotCollateral: 0n,
        activePendingTransferIds: [],
      },
    ];
    myVault.mintingAuthorities.data.pendingMintingAuthorizations = [pendingAuthorization];
    myVault.mintingAuthorities.data.sourceTotalsByAccount.set(pendingAuthorization.sourceAccount, {
      microgonsOut: 0n,
      micronotsOut: 5n * BigInt(MICRONOTS_PER_ARGONOT),
      transferOutCount: 1,
    });
    Object.assign(myVault, {
      collectBuilder: {
        getNotice: () => pendingAuthorizationNotice,
      },
    });
  },
  play: async ({ canvasElement }) => {
    const overlay = within(canvasElement.ownerDocument.body);

    await waitFor(() => expect(overlay.getByRole('button', { name: '1 crosschain authorization' })).toBeVisible());
    overlay.getByRole('button', { name: '1 crosschain authorization' }).click();

    await waitFor(() => expect(overlay.getByText('5 ARGNOT')).toBeVisible());
    await expect(overlay.getByText('Click a transfer for details.')).toBeVisible();
    await expect(overlay.getByText('0.5 ARGNOT tip')).toBeVisible();

    overlay.getByText('Authorize ARGNOT to Ethereum').click();
    await expect(overlay.getByText('Lifetime sent to Ethereum')).toBeVisible();
    await expect(overlay.getByText('Waiting for your minting-authority signature', { selector: 'dd' })).toBeVisible();
  },
};

const recoveredSourceAccount = '5source';

function setupCurrency() {
  const currency = getCurrency();
  currency._key = UnitOfMeasurement.ARGN;
  currency.record = currency.recordsByKey[UnitOfMeasurement.ARGN];
  currency.symbol = currency.record.symbol;
  currency.isLoaded = true;
}

function createHistory() {
  const history = new CrosschainHistory(
    { vaultingAddress: '5SyntheticVaultingWallet' },
    {
      start: fn(async () => undefined),
      finalizedBlockHeader: { blockNumber: 10 },
    } as any,
    undefined,
    fn(async () => ({
      blocks: [],
      asOfBlock: 10,
      definitionVersion: 1,
      coverage: { fromBlock: 0, toBlock: 10, gaps: [] },
    })),
  );
  history.data = Vue.reactive(history.data) as typeof history.data;
  return history;
}

const recoveredAuthorization: ICrosschainHistoryRecord = {
  accountId: '5SyntheticVaultingWallet',
  id: '0xblock:2',
  blockNumber: 10,
  blockTime: new Date('2026-08-15T12:00:00.000Z'),
  extrinsicIndex: 1,
  eventIndex: 2,
  details: {
    kind: 'transferAuthorization',
    transferId: '0xtransfer',
    authoritySigningKey: '0xauthority',
    authorityOwnerAccount: '5SyntheticVaultingWallet',
    sourceAccount: recoveredSourceAccount,
    destinationAccount: '0xrecipient',
    moveToken: MoveToken.ARGNOT,
    amount: 5n * BigInt(MICRONOTS_PER_ARGONOT),
    microgonsPerArgonot: 4_000_000n,
    tip: 500_000n,
    tipValueMicrogons: 2_000_000n,
    microgonCollateral: 0n,
    micronotCollateral: 2_000_000n,
  },
};

const pendingTipNotice: IVaultCollectNotice = {
  isProcessing: true,
  collectRevenue: 0n,
  expiringCollectAmount: 0n,
  nextCollectDueDate: 0,
  signatureCount: 0,
  orphanSignatureCount: 0,
  nextCosignDueDate: 0,
  councilApprovalCount: 0,
  authorizedTransferCount: 0,
  authorizedTransferRewardAmount: 0n,
  pendingAuthorizedTransferCount: 1,
  pendingAuthorizedTransferRewardAmount: 2_000_000n,
  signaturePenalty: 0n,
  earningsAmountMicrogons: 0n,
  amountAtRiskMicrogons: 0n,
  transactionCount: 1,
  processing: undefined,
};

const pendingAuthorization: IMintingAuthorityAuthorization = {
  transferId: `0x${'01'.repeat(32)}`,
  authorityIndex: 0,
  moveToken: MoveToken.ARGNOT,
  sourceAccount: '5SyntheticSourceWallet',
  destinationSigningKey: '0xauthority',
  finalizeRequest: {
    argonAccountId: `0x${'02'.repeat(32)}`,
    argonTransferNonce: 1n,
    chainId: 1n,
    recipient: `0x${'03'.repeat(20)}`,
    validUntilBlock: 1_000n,
    token: `0x${'04'.repeat(20)}`,
    amount: 5n * BigInt(MICRONOTS_PER_ARGONOT),
    mintingAuthorityTip: 1_000_000n,
    microgonsPerArgonot: 4_000_000n,
  },
  authorizationHash: `0x${'05'.repeat(32)}`,
  mintingAuthorityTip: 1_000_000n,
  mintingAuthorityTipShare: 500_000n,
  mintingAuthorityTipValueMicrogons: 2_000_000n,
  microgonCollateral: 0n,
  micronotCollateral: 2_000_000n,
  securityAmountMicrogons: 8_000_000n,
};

const pendingAuthorizationNotice: IVaultCollectNotice = {
  ...pendingTipNotice,
  isProcessing: false,
  authorizedTransferCount: 1,
  authorizedTransferRewardAmount: 2_000_000n,
  pendingAuthorizedTransferCount: 0,
  pendingAuthorizedTransferRewardAmount: 0n,
};

function selectUsdCurrency() {
  const currency = getCurrency();
  currency._key = UnitOfMeasurement.USD;
  currency.record = currency.recordsByKey[UnitOfMeasurement.USD];
  currency.symbol = currency.record.symbol;
  currency.isLoaded = true;
}
