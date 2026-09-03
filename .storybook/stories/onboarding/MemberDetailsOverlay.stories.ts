import type { Meta, StoryObj } from '@storybook/vue3-vite';
import type {
  BitcoinLockCouponUseStatus,
  IBitcoinLockCouponUseRecord,
  ICertificationProgress,
} from '@argonprotocol/apps-core';
import type { IBitcoinLockCouponStatus, IMemberInvite } from '@argonprotocol/apps-router';
import { MiningFrames, NetworkConfig } from '@argonprotocol/apps-core';
import { Keyring } from '@polkadot/keyring';
import { TypeRegistry } from '@polkadot/types';
import * as Vue from 'vue';
import { expect, fn, mocked, userEvent, within } from 'storybook/test';
import { setupAppScenario } from '../../scenarios/setupAppScenario.ts';
import { expectEventuallyVisible } from '../../support/expectEventuallyVisible.ts';
import { dateDaysAgo } from '../../support/storyDates.ts';
import basicEmitter from '../../../src-vue/emitters/basicEmitter.ts';
import { TopTab } from '../../../src-vue/interfaces/IConfig.ts';
import MemberDetailsOverlay from '../../../src-vue/overlays/MemberDetailsOverlay.vue';
import { getMainchainClient } from '../../../src-vue/stores/mainchain.ts';
import { getServerApiClient } from '../../../src-vue/stores/server.ts';
import { getWalletKeys } from '../../../src-vue/stores/wallets.ts';

let selectedInvite: IMemberInvite;
const scenarioKeyring = new Keyring({ type: 'sr25519' });
const memberAccountId = scenarioKeyring.addFromUri('//StorybookMember').address;
const operationalAccountId = scenarioKeyring.addFromUri('//StorybookOperationalMember').address;
const operatorKeypair = scenarioKeyring.addFromUri('//StorybookOperator');

const meta = {
  title: 'Onboarding/Member details',
  component: MemberDetailsOverlay,
  render: () => ({
    components: { MemberDetailsOverlay },
    setup() {
      Vue.onMounted(() => basicEmitter.emit('openMemberDetailsOverlay', { invite: selectedInvite }));
    },
    template: '<MemberDetailsOverlay />',
  }),
} satisfies Meta<typeof MemberDetailsOverlay>;

export default meta;
type Story = StoryObj<typeof meta>;

export const NotOpened: Story = {
  beforeEach: () => {
    const { controller } = setupAppScenario({ selectedTab: TopTab.Onboarding });
    selectedInvite = createInvite(1);
    controller.setOperationalInvites([selectedInvite]);
  },
  play: async () => {
    await expectEventuallyVisible(within(document.body).findByText('Not opened'));
    await expectEventuallyVisible(within(document.body).findByText('Click to copy'));
  },
};

export const TreasuryMember: Story = {
  beforeEach: () => {
    const { controller } = setupAppScenario({ selectedTab: TopTab.Onboarding });
    selectedInvite = createInvite(2, {
      defaultAccountId: memberAccountId,
      firstClickedAt: dateDaysAgo(1),
      bitcoinLockCoupon: createFeeWaiver('partiallyUsed'),
      certificationProgress: createCertificationProgress({
        hasTreasuryBitcoin: true,
        treasuryBitcoinAmount: 600_000_000n,
        hasTreasuryBonds: true,
        treasuryBondAmount: 200_000_000n,
      }),
      vaultContribution: { bitcoinAmount: 600_000_000n, pendingBitcoinAmount: 0n, bondAmount: 200_000_000n },
    });
    controller.setOperationalInvites([selectedInvite]);
    mocked(getMainchainClient).mockResolvedValue(createMemberClient(3_487_660_000n));
  },
  play: async () => {
    await expectEventuallyVisible(within(document.body).findByText('Bitcoin Fee Waiver'));
    await expectEventuallyVisible(within(document.body).findByText('2 of 3 complete'));
  },
};

export const FeeWaiverExpirationOpen: Story = {
  ...TreasuryMember,
  play: async () => {
    const canvas = within(document.body);
    await userEvent.click(await canvas.findByRole('button', { name: '7 days' }));
    await expectEventuallyVisible(canvas.findByText('Fee Waiver Expiration'));
    await expect(canvas.findByTestId('input-number')).resolves.toHaveTextContent('7');
  },
};

export const OperationsRequested: Story = {
  beforeEach: () => {
    const { controller } = setupAppScenario({ selectedTab: TopTab.Onboarding });
    controller.chainProgress.availableAccessCodes = 1;
    selectedInvite = createInvite(3, {
      defaultAccountId: memberAccountId,
      operationalAccountId,
      firstClickedAt: dateDaysAgo(2),
      operationsUpgradeRequestedAt: dateDaysAgo(1),
      certificationProgress: createCertificationProgress({
        hasTreasuryBitcoin: true,
        hasTreasuryBonds: true,
        hasTreasuryUniswapTransfer: true,
        isTreasuryCertified: true,
      }),
    });
    controller.setOperationalInvites([selectedInvite]);
    mocked(getMainchainClient).mockResolvedValue(createMemberClient(3_487_660_000n));
  },
  play: async () => {
    await expectEventuallyVisible(within(document.body).findByText(/Requested Operations/));
    await expectEventuallyVisible(within(document.body).findByRole('button', { name: 'Upgrade to Operations' }));
  },
};

export const OperationsGranted: Story = {
  beforeEach: () => {
    const { controller } = setupAppScenario({ selectedTab: TopTab.Onboarding });
    selectedInvite = createInvite(4, {
      defaultAccountId: memberAccountId,
      operationalAccountId,
      firstClickedAt: dateDaysAgo(3),
      operationsUpgradedAt: dateDaysAgo(1),
      certificationProgress: createCertificationProgress({
        hasOperationalAccount: true,
        hasTreasuryBitcoin: true,
        treasuryBitcoinAmount: 1_200_000_000n,
        hasTreasuryBonds: true,
        treasuryBondAmount: 200_000_000n,
        hasTreasuryUniswapTransfer: true,
        isTreasuryCertified: true,
        isUpgradedToOperations: true,
        hasOperationalVault: true,
      }),
    });
    controller.setOperationalInvites([selectedInvite]);
    mocked(getMainchainClient).mockResolvedValue(createMemberClient(4_028_990_000n));
  },
  play: async () => {
    await expectEventuallyVisible(within(document.body).findByText(/Operations access granted/));
    await expectEventuallyVisible(within(document.body).findByText('4 of 6 complete'));
  },
};

export const OpenedNotRegistered: Story = {
  beforeEach: () => {
    const { controller } = setupAppScenario({ selectedTab: TopTab.Onboarding });
    selectedInvite = createInvite(5, {
      lastClickedAt: dateDaysAgo(1),
    });
    controller.setOperationalInvites([selectedInvite]);
  },
  play: async () => {
    await expectEventuallyVisible(within(document.body).findByText(/^Opened .* ago$/));
  },
};

export const BalancesLoading: Story = {
  beforeEach: () => {
    const { controller } = setupAppScenario({ selectedTab: TopTab.Onboarding });
    selectedInvite = createInvite(6, {
      defaultAccountId: memberAccountId,
      firstClickedAt: dateDaysAgo(1),
    });
    controller.setOperationalInvites([selectedInvite]);
  },
  play: async () => {
    await expectEventuallyVisible(within(document.body).findByText('Loading balances…'));
  },
};

export const BalancesUnavailable: Story = {
  beforeEach: () => {
    const { controller } = setupAppScenario({ selectedTab: TopTab.Onboarding });
    selectedInvite = createInvite(7, {
      defaultAccountId: memberAccountId,
      firstClickedAt: dateDaysAgo(1),
    });
    controller.setOperationalInvites([selectedInvite]);
    mocked(getMainchainClient).mockResolvedValue(createMemberClient(0n, new Error('Member balances are unavailable.')));
  },
  play: async () => {
    await expectEventuallyVisible(within(document.body).findByText('Balances unavailable'));
  },
};

export const FeeWaiverPending: Story = {
  beforeEach: () => {
    const { controller } = setupAppScenario({ selectedTab: TopTab.Onboarding });
    selectedInvite = createInvite(9, {
      defaultAccountId: memberAccountId,
      firstClickedAt: dateDaysAgo(2),
      bitcoinLockCoupon: createFeeWaiver('pending'),
    });
    controller.setOperationalInvites([selectedInvite]);
  },
  play: async () => {
    await expectEventuallyVisible(within(document.body).findByText(/₳20 pending/));
  },
};

export const FeeWaiverUsed: Story = {
  beforeEach: () => {
    const { controller } = setupAppScenario({ selectedTab: TopTab.Onboarding });
    selectedInvite = createInvite(10, {
      defaultAccountId: memberAccountId,
      firstClickedAt: dateDaysAgo(2),
      bitcoinLockCoupon: createFeeWaiver('used'),
    });
    controller.setOperationalInvites([selectedInvite]);
  },
  play: async () => {
    const canvas = within(document.body);
    const heading = await canvas.findByText('Bitcoin Fee Waiver');

    await expect(heading.nextElementSibling).toHaveTextContent(/₳68\s*fee waiver\s*· Used\s*.* ago/);
  },
};

export const FeeWaiverExpired: Story = {
  beforeEach: () => {
    const { controller } = setupAppScenario({ selectedTab: TopTab.Onboarding });
    const currentTick = MiningFrames.calculateCurrentTickFromSystemTime();
    selectedInvite = createInvite(11, {
      lastClickedAt: dateDaysAgo(1),
      bitcoinLockCoupon: createFeeWaiver('expired', currentTick),
    });
    controller.setOperationalInvites([selectedInvite]);
  },
  play: async () => {
    const canvas = within(document.body);
    const heading = await canvas.findByText('Bitcoin Fee Waiver');

    await expect(heading.nextElementSibling).toHaveTextContent(/₳68\s*fee waiver\s*· Unused\s*· expired\s*2 days ago/);
    await expectEventuallyVisible(canvas.findByRole('button', { name: '2 days ago' }));
  },
};

export const FeeWaiverExpiredExtensionOpen: Story = {
  ...FeeWaiverExpired,
  play: async () => {
    const canvas = within(document.body);
    await userEvent.click(await canvas.findByRole('button', { name: '2 days ago' }));
    await expectEventuallyVisible(canvas.findByText('Fee Waiver Expiration'));
    await expect(canvas.findByTestId('input-number')).resolves.toHaveTextContent('0');
  },
};

export const OperationsUpgradeInProgress: Story = {
  beforeEach: () => setupOperationsUpgradeAction('progress'),
  play: async () => {
    const canvas = within(document.body);
    await userEvent.click(await canvas.findByRole('button', { name: 'Upgrade to Operations' }));
    await expectEventuallyVisible(canvas.findByRole('button', { name: 'Upgrading…' }));
  },
};

export const OperationsUpgradeFailed: Story = {
  beforeEach: () => setupOperationsUpgradeAction('error'),
  play: async () => {
    const canvas = within(document.body);
    await userEvent.click(await canvas.findByRole('button', { name: 'Upgrade to Operations' }));
    await expectEventuallyVisible(canvas.findByText('Operations approval failed.'));
  },
};

export const ExpirationUpdateInProgress: Story = {
  beforeEach: () => setupExpirationUpdate('progress'),
  play: async () => {
    const canvas = within(document.body);
    await saveExpiration(canvas);
    await expect(canvas.findByRole('button', { name: 'Done' })).resolves.toBeDisabled();
  },
};

export const ExpirationUpdateFailed: Story = {
  beforeEach: () => setupExpirationUpdate('error'),
  play: async () => {
    const canvas = within(document.body);
    await saveExpiration(canvas);
    await expectEventuallyVisible(canvas.findByText('Expiration update failed.'));
  },
};

function createInvite(id: number, overrides: Partial<IMemberInvite> = {}): IMemberInvite {
  return {
    id,
    name: 'Morgan',
    fromName: 'Atlas Operator',
    inviteCode: `synthetic-member-details-${id}`,
    createdAt: dateDaysAgo(3),
    ...overrides,
  };
}

function createFeeWaiver(
  state: 'available' | 'partiallyUsed' | 'pending' | 'used' | 'expired' = 'available',
  currentTick = MiningFrames.calculateCurrentTickFromSystemTime(),
): IBitcoinLockCouponStatus {
  const originalFeeCreditMicrogons = 68_400_000n;
  let uses: IBitcoinLockCouponUseRecord[] = [];
  if (state === 'partiallyUsed') {
    uses = [createFeeWaiverUse(1, 'Finalized', 40_800_000n)];
  } else if (state === 'pending') {
    uses = [createFeeWaiverUse(1, 'Finalized', 20_400_000n), createFeeWaiverUse(2, 'InBlock', 20_400_000n)];
  } else if (state === 'used') {
    uses = [createFeeWaiverUse(1, 'Finalized', originalFeeCreditMicrogons)];
  }

  const expirationTick =
    state === 'expired'
      ? currentTick - 2 * NetworkConfig.rewardTicksPerFrame
      : currentTick + 7 * NetworkConfig.rewardTicksPerFrame;

  const coupon: IBitcoinLockCouponStatus['coupon'] = {
    id: 1,
    userId: 2,
    sequence: 1,
    offerCode: 'synthetic-member-fee-waiver',
    vaultId: 7,
    maxSatoshis: 100_000_000n,
    estimatedGiftUsd: 68,
    btcPctFee: 3.4,
    expiresAfterTicks: 7 * NetworkConfig.rewardTicksPerFrame,
    createdAt: dateDaysAgo(3),
    updatedAt: dateDaysAgo(1),
    feeCreditMicrogons: originalFeeCreditMicrogons,
    expirationTick,
    ...(uses.length ? { accountId: memberAccountId } : {}),
  };

  // Derive the visible state from the durable use history consumed by BitcoinLockCouponService.getStatus.
  const usedFeeCreditMicrogons = uses
    .filter(use => use.status === 'Finalized')
    .reduce((total, use) => total + use.feeCreditMicrogons, 0n);
  const activeUse = uses.find(
    use => use.status === 'Prepared' || use.status === 'Submitted' || use.status === 'InBlock',
  );
  const pendingFeeCreditMicrogons = uses
    .filter(use => use.status === 'Prepared' || use.status === 'Submitted' || use.status === 'InBlock')
    .reduce((total, use) => total + use.feeCreditMicrogons, 0n);
  const remainingFeeCreditMicrogons = originalFeeCreditMicrogons - usedFeeCreditMicrogons - pendingFeeCreditMicrogons;

  let status: IBitcoinLockCouponStatus['status'] = 'Open';
  if (activeUse) {
    status = activeUse.status;
  } else if (usedFeeCreditMicrogons >= originalFeeCreditMicrogons) {
    status = 'Used';
  } else if (expirationTick != null && currentTick >= expirationTick) {
    status = 'Expired';
  }

  return {
    status,
    coupon,
    ...(uses.length ? { uses } : {}),
    originalFeeCreditMicrogons,
    usedFeeCreditMicrogons,
    pendingFeeCreditMicrogons,
    remainingFeeCreditMicrogons,
  };
}

function createFeeWaiverUse(
  id: number,
  status: BitcoinLockCouponUseStatus,
  feeCreditMicrogons: bigint,
): IBitcoinLockCouponUseRecord {
  return {
    id,
    couponId: 1,
    requestId: `storybook-fee-waiver-use-${id}`,
    status,
    feeCreditMicrogons,
    requestedSatoshis: 10_000_000n,
    ownerAccountId: memberAccountId,
    ownerBitcoinPubkey: `02${'44'.repeat(32)}`,
    microgonsAtTargetPerBtc: 6_800_000_000n,
    feeCoupon: {
      feeDiscount: feeCreditMicrogons,
      expiresAtFrame: 1_000n,
      nonce: BigInt(id),
      securitizationSpaceToUnreserve: 0n,
      signature: `0x${'34'.repeat(64)}`,
    },
    createdAt: dateDaysAgo(3 - id),
    updatedAt: dateDaysAgo(2 - id),
  };
}

function setupOperationsUpgradeAction(state: 'progress' | 'error') {
  const { controller } = setupAppScenario({ selectedTab: TopTab.Onboarding });
  controller.chainProgress.availableAccessCodes = 1;
  selectedInvite = createInvite(12, {
    defaultAccountId: memberAccountId,
    operationalAccountId,
    firstClickedAt: dateDaysAgo(2),
    operationsUpgradeRequestedAt: dateDaysAgo(1),
    certificationProgress: createCertificationProgress({
      hasTreasuryBitcoin: true,
      hasTreasuryBonds: true,
      hasTreasuryUniswapTransfer: true,
      isTreasuryCertified: true,
    }),
  });
  controller.setOperationalInvites([selectedInvite]);
  mocked(getMainchainClient).mockResolvedValue(createMemberClient(3_487_660_000n));
  Object.assign(getWalletKeys(), {
    getOperationalKeypair: fn(async () => operatorKeypair),
  });
  mocked(getServerApiClient, { partial: true }).mockReturnValue({
    markOperationsUpgraded: fn(() => {
      if (state === 'error') return Promise.reject(new Error('Operations approval failed.'));
      return new Promise<IMemberInvite>(() => undefined);
    }),
  });
}

function setupExpirationUpdate(state: 'progress' | 'error') {
  const { controller } = setupAppScenario({ selectedTab: TopTab.Onboarding });
  selectedInvite = createInvite(13, {
    lastClickedAt: dateDaysAgo(1),
    bitcoinLockCoupon: createFeeWaiver(),
  });
  controller.setOperationalInvites([selectedInvite]);
  mocked(getServerApiClient, { partial: true }).mockReturnValue({
    updateBitcoinLockCouponExpiration: fn(() => {
      if (state === 'error') return Promise.reject(new Error('Expiration update failed.'));
      return new Promise<IBitcoinLockCouponStatus>(() => undefined);
    }),
  });
}

async function saveExpiration(canvas: ReturnType<typeof within>) {
  await userEvent.click(await canvas.findByRole('button', { name: '7 days' }));
  await userEvent.click(await canvas.findByRole('button', { name: 'Save' }));
}

function createCertificationProgress(overrides: Partial<ICertificationProgress> = {}): ICertificationProgress {
  return {
    hasOperationalAccount: false,
    isTreasuryCertified: false,
    hasTreasuryBitcoin: false,
    hasTreasuryBonds: false,
    hasTreasuryUniswapTransfer: false,
    isUpgradedToOperations: false,
    hasOperationalVault: false,
    hasOperationalMiningSeats: false,
    hasOperationalUniswapTransfer: false,
    isOperationallyCertified: false,
    ...overrides,
  };
}

function createMemberClient(availableMicrogons: bigint, balancesError?: Error) {
  const registry = new TypeRegistry();
  const amount = (value: bigint) => registry.createType('u128', value);
  return {
    consts: {
      operationalAccounts: {
        minimumBitcoin: amount(600_000_000n),
        minimumBonds: amount(200_000_000n),
        minimumUniswapTransfer: amount(1_000_000_000n),
        operationalMinimumUniswapTransfer: amount(1_000_000_000n),
        operationalMinimumVaultSecuritization: amount(2_000_000_000n),
        miningSeatsForOperational: registry.createType('u32', 2),
      },
    },
    query: {
      system: {
        account: {
          multi: fn(async () => {
            if (balancesError) throw balancesError;
            return [{ data: { free: availableMicrogons, reserved: 0n } }];
          }),
        },
      },
      ownership: {
        account: {
          multi: fn(async () => [{ free: 0n, reserved: 0n }]),
        },
      },
      bitcoinLocks: {
        utxoIdsByOwnerAccount: { keys: fn(() => Promise.reject(new Error('Use invite progress fixture.'))) },
      },
      crosschainTransfer: {
        transferTotalsByAccount: fn(async () => ({ microgonsIn: 0n })),
      },
      operationalAccounts: {
        operationalAccounts: fn(() => Promise.reject(new Error('Use invite progress fixture.'))),
      },
    },
  } as unknown as Awaited<ReturnType<typeof getMainchainClient>>;
}
