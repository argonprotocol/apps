import type { Meta, StoryObj } from '@storybook/vue3-vite';
import type { ICertificationProgress } from '@argonprotocol/apps-core';
import type { IBitcoinLockCouponStatus, IMemberInvite } from '@argonprotocol/apps-router';
import { MiningFrames, NetworkConfig } from '@argonprotocol/apps-core';
import { Keyring } from '@polkadot/keyring';
import { TypeRegistry } from '@polkadot/types';
import * as Vue from 'vue';
import { expect, fn, mocked, userEvent, within } from 'storybook/test';
import { setupAppScenario } from '../../scenarios/setupAppScenario.ts';
import { expectEventuallyVisible } from '../../support/expectEventuallyVisible.ts';
import basicEmitter from '../../../src-vue/emitters/basicEmitter.ts';
import { TopTab } from '../../../src-vue/interfaces/IConfig.ts';
import MemberDetailsOverlay from '../../../src-vue/overlays/MemberDetailsOverlay.vue';
import { getMainchainClient } from '../../../src-vue/stores/mainchain.ts';
import { getServerApiClient } from '../../../src-vue/stores/server.ts';
import { getWalletKeys } from '../../../src-vue/stores/wallets.ts';

let selectedInvite: IMemberInvite;

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
    selectedInvite = createInvite(1, 'Pending member');
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
    selectedInvite = createInvite(2, 'Treasury member', {
      defaultAccountId: '5SyntheticTreasuryMember',
      firstClickedAt: new Date('2026-08-16T16:00:00.000Z'),
      bitcoinLockCoupon: createFeeWaiver(),
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

export const OperationsRequested: Story = {
  beforeEach: () => {
    const { controller } = setupAppScenario({ selectedTab: TopTab.Onboarding });
    controller.chainProgress.availableAccessCodes = 1;
    selectedInvite = createInvite(3, 'Operations requested', {
      defaultAccountId: '5SyntheticOperationsMember',
      operationalAccountId: '5SyntheticOperationalAccount',
      firstClickedAt: new Date('2026-08-15T16:00:00.000Z'),
      operationsUpgradeRequestedAt: new Date('2026-08-16T16:00:00.000Z'),
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
    selectedInvite = createInvite(4, 'Operations granted', {
      defaultAccountId: '5SyntheticGrantedMember',
      operationalAccountId: '5SyntheticOperationalAccount',
      firstClickedAt: new Date('2026-08-14T16:00:00.000Z'),
      operationsUpgradedAt: new Date('2026-08-16T16:00:00.000Z'),
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
    selectedInvite = createInvite(5, 'Opened member', {
      lastClickedAt: new Date('2026-08-16T16:00:00.000Z'),
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
    selectedInvite = createInvite(6, 'Loading member', {
      defaultAccountId: '5SyntheticLoadingMember',
      firstClickedAt: new Date('2026-08-16T16:00:00.000Z'),
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
    selectedInvite = createInvite(7, 'Unavailable balances', {
      defaultAccountId: '5SyntheticUnavailableMember',
      firstClickedAt: new Date('2026-08-16T16:00:00.000Z'),
    });
    controller.setOperationalInvites([selectedInvite]);
    mocked(getMainchainClient).mockResolvedValue(createMemberClient(0n, new Error('Member balances are unavailable.')));
  },
  play: async () => {
    await expectEventuallyVisible(within(document.body).findByText('Balances unavailable'));
  },
};

export const PreviousRuntimeFeeWaiver: Story = {
  beforeEach: () => {
    const { controller } = setupAppScenario({ selectedTab: TopTab.Onboarding });
    selectedInvite = createInvite(8, 'Previous runtime waiver', {
      lastClickedAt: new Date('2026-08-16T16:00:00.000Z'),
      bitcoinLockCoupon: createFeeWaiver(
        {
          originalFeeCreditMicrogons: undefined,
          usedFeeCreditMicrogons: undefined,
          pendingFeeCreditMicrogons: undefined,
          remainingFeeCreditMicrogons: undefined,
        },
        { expirationTick: undefined },
      ),
    });
    controller.setOperationalInvites([selectedInvite]);
  },
  play: async () => {
    await expectEventuallyVisible(within(document.body).findByText('This waiver covers one eligible Bitcoin lock.'));
  },
};

export const FeeWaiverPending: Story = {
  beforeEach: () => {
    const { controller } = setupAppScenario({ selectedTab: TopTab.Onboarding });
    selectedInvite = createInvite(9, 'Pending waiver', {
      lastClickedAt: new Date('2026-08-16T16:00:00.000Z'),
      bitcoinLockCoupon: createFeeWaiver({
        status: 'InBlock',
        usedFeeCreditMicrogons: 20_400_000n,
        pendingFeeCreditMicrogons: 20_400_000n,
        remainingFeeCreditMicrogons: 27_200_000n,
      }),
    });
    controller.setOperationalInvites([selectedInvite]);
  },
  play: async () => {
    await expectEventuallyVisible(within(document.body).findByText(/₳20\.40 pending/));
  },
};

export const FeeWaiverUsed: Story = {
  beforeEach: () => {
    const { controller } = setupAppScenario({ selectedTab: TopTab.Onboarding });
    selectedInvite = createInvite(10, 'Completed waiver', {
      lastClickedAt: new Date('2026-08-16T16:00:00.000Z'),
      bitcoinLockCoupon: createFeeWaiver(
        {
          status: 'Used',
          usedFeeCreditMicrogons: 68_000_000n,
          remainingFeeCreditMicrogons: 0n,
        },
        { usedAt: new Date('2026-08-16T16:00:00.000Z') },
      ),
    });
    controller.setOperationalInvites([selectedInvite]);
  },
  play: async () => {
    await expectEventuallyVisible(within(document.body).findByText(/Used/));
  },
};

export const FeeWaiverExpired: Story = {
  beforeEach: () => {
    const { controller } = setupAppScenario({ selectedTab: TopTab.Onboarding });
    const currentTick = MiningFrames.calculateCurrentTickFromSystemTime();
    selectedInvite = createInvite(11, 'Expired waiver', {
      lastClickedAt: new Date('2026-08-16T16:00:00.000Z'),
      bitcoinLockCoupon: createFeeWaiver(
        { status: 'Expired' },
        { expirationTick: currentTick - 2 * NetworkConfig.rewardTicksPerFrame },
      ),
    });
    controller.setOperationalInvites([selectedInvite]);
  },
  play: async () => {
    await expectEventuallyVisible(within(document.body).findByRole('button', { name: '2 days ago' }));
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

function createInvite(id: number, name: string, overrides: Partial<IMemberInvite> = {}): IMemberInvite {
  return {
    id,
    name,
    fromName: 'Atlas Operator',
    inviteCode: `synthetic-member-details-${id}`,
    createdAt: new Date('2026-08-14T16:00:00.000Z'),
    ...overrides,
  };
}

function createFeeWaiver(
  overrides: Partial<IBitcoinLockCouponStatus> = {},
  couponOverrides: Partial<IBitcoinLockCouponStatus['coupon']> = {},
): IBitcoinLockCouponStatus {
  const currentTick = MiningFrames.calculateCurrentTickFromSystemTime();
  return {
    status: 'Open',
    originalFeeCreditMicrogons: 68_000_000n,
    usedFeeCreditMicrogons: 40_800_000n,
    pendingFeeCreditMicrogons: 0n,
    remainingFeeCreditMicrogons: 27_200_000n,
    coupon: {
      id: 1,
      userId: 2,
      sequence: 1,
      offerCode: 'synthetic-member-fee-waiver',
      vaultId: 7,
      maxSatoshis: 100_000_000n,
      estimatedGiftUsd: 68,
      btcPctFee: 3.4,
      feeCreditMicrogons: 68_000_000n,
      expiresAfterTicks: 7 * NetworkConfig.rewardTicksPerFrame,
      expirationTick: currentTick + 7 * NetworkConfig.rewardTicksPerFrame,
      createdAt: new Date('2026-08-14T16:00:00.000Z'),
      updatedAt: new Date('2026-08-16T16:00:00.000Z'),
      ...couponOverrides,
    },
    ...overrides,
  };
}

function setupOperationsUpgradeAction(state: 'progress' | 'error') {
  const { controller } = setupAppScenario({ selectedTab: TopTab.Onboarding });
  const keyring = new Keyring({ type: 'sr25519' });
  const operationalKeypair = keyring.addFromUri('//StorybookOperator');
  const memberOperationalAccountId = keyring.addFromUri('//StorybookMember').address;
  controller.chainProgress.availableAccessCodes = 1;
  selectedInvite = createInvite(12, 'Operations action', {
    defaultAccountId: '5SyntheticOperationsActionMember',
    operationalAccountId: memberOperationalAccountId,
    firstClickedAt: new Date('2026-08-15T16:00:00.000Z'),
    operationsUpgradeRequestedAt: new Date('2026-08-16T16:00:00.000Z'),
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
    getOperationalKeypair: fn(async () => operationalKeypair),
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
  selectedInvite = createInvite(13, 'Expiration action', {
    lastClickedAt: new Date('2026-08-16T16:00:00.000Z'),
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
            return [{ data: { free: amount(availableMicrogons), reserved: amount(0n) } }];
          }),
        },
      },
      ownership: {
        account: {
          multi: fn(async () => [{ free: amount(0n), reserved: amount(0n) }]),
        },
      },
      bitcoinLocks: {
        utxoIdsByOwnerAccount: { keys: fn(() => Promise.reject(new Error('Use invite progress fixture.'))) },
      },
      crosschainTransfer: {
        transferTotalsByAccount: fn(async () => ({ microgonsIn: amount(0n) })),
      },
      operationalAccounts: {
        operationalAccounts: fn(() => Promise.reject(new Error('Use invite progress fixture.'))),
      },
    },
  } as unknown as Awaited<ReturnType<typeof getMainchainClient>>;
}
