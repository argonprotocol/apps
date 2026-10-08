import type { Meta, StoryObj } from '@storybook/vue3-vite';
import { mocked, userEvent, within } from 'storybook/test';
import { getArgonBonds } from '../../../src-vue/stores/argonBonds.ts';
import { getMyVault } from '../../../src-vue/stores/vaults.ts';
import { BondLot } from '@argonprotocol/apps-core';
import { setupBondPortfolioScenario, setupBondArchiveScenario } from '../../scenarios/setupBondPortfolioScenario.ts';
import BondDetailOverlay from '../../../src-vue/overlays/BondDetailOverlay.vue';
import { ArgonBondsFinancials } from '../../../src-vue/lib/financials/ArgonBonds.ts';

let bondLot: ReturnType<typeof setupBondPortfolioScenario>['lots'][number] | undefined;
let position: ReturnType<typeof setupBondPortfolioScenario>['positions'][number];

const meta = {
  title: 'Bonds/Details',
  render: () => ({
    components: { BondDetailOverlay },
    setup: () => ({ bondLot, position }),
    template: `
      <div class="fixed top-2 right-3 z-[10000] rounded-full border border-slate-400/40 bg-white/90 px-2.5 py-1 text-xs font-semibold text-slate-600 shadow-sm">Fixed state preview</div>
      <BondDetailOverlay
        :bondLot="bondLot"
        :position="position"
        inert
      />
    `,
  }),
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

export const ActiveBond: Story = {
  beforeEach: () => {
    const { lots, positions } = setupBondPortfolioScenario('Vault');
    bondLot = lots[0];
    position = positions[0];
  },
};

export const FlexibleBond: Story = {
  beforeEach: () => {
    const { lots, positions } = setupBondPortfolioScenario('Vault');
    bondLot = lots.find(lot => lot.isFlexible)!;
    position = positions.find(candidate => candidate.bondLot?.id === bondLot?.id)!;
  },
};

export const DisplacedFlexibleBond: Story = {
  beforeEach: () => {
    const { lots, positions } = setupBondPortfolioScenario('Vault', 26.32);
    bondLot = lots.find(lot => lot.isFlexible)!;
    position = positions.find(candidate => candidate.bondLot?.id === bondLot?.id)!;
  },
};

export const ReleasingBond: Story = {
  beforeEach: () => {
    const { lots, positions } = setupBondPortfolioScenario('Vault');
    bondLot = lots.find(lot => lot.isReleasing)!;
    position = positions[2];
  },
};

export const IncompleteBondHistory: Story = {
  beforeEach: () => {
    const { lots, positions } = setupBondPortfolioScenario('Vault');
    bondLot = new BondLot(lots[0].id, lots[0], lots[0].owner);
    position = { ...positions[0], returnIsComplete: false };
  },
};

export const IncompleteFlexibleHistory: Story = {
  beforeEach: () => {
    const { lots, positions } = setupBondPortfolioScenario('Vault', 0, false);
    bondLot = lots.find(lot => lot.isFlexible)!;
    position = positions.find(candidate => candidate.bondLot?.id === bondLot?.id)!;
  },
};

export const DailyEarnings: Story = {
  beforeEach: () => {
    const { lots, positions } = setupBondPortfolioScenario('Vault');
    bondLot = lots[0];
    position = positions[0];
    mocked(getMyVault, { partial: true }).mockReturnValue({ vaultId: 99 });
    getArgonBonds().data.dailyEarnings[0].earningsMicrogons = 300_000n;
    getArgonBonds().data.dailyEarnings[2].earningsMicrogons = 420_000n;
  },
};

export const SmallEarnings: Story = {
  beforeEach: () => {
    const { lots, positions } = setupBondPortfolioScenario('Vault');
    bondLot = lots[0];
    position = positions[0];
    position.paidIncome = 1_234n;
    Object.assign(bondLot, { cumulativeEarnings: 1_234n });
    const bonds = getArgonBonds();
    bonds.data.bondHistory[0].cumulativeEarningsMicrogons = 1_234n;
    const lastPayment = bonds.data.dailyEarnings.filter(record => record.bondLotId === bondLot!.id).at(-1)!;
    lastPayment.earningsMicrogons = 1_234n;
  },
};

export const ZeroEarnings: Story = {
  beforeEach: () => {
    const { lots, positions } = setupBondPortfolioScenario('Vault');
    bondLot = lots[0];
    position = positions[0];
    position.paidIncome = 0n;
    Object.assign(bondLot, { cumulativeEarnings: 0n });
    const bonds = getArgonBonds();
    bonds.data.bondHistory[0].cumulativeEarningsMicrogons = 0n;
    for (const record of bonds.data.dailyEarnings) {
      if (record.bondLotId === bondLot.id) record.earningsMicrogons = 0n;
    }
  },
};

export const NewlyCreatedFlexibleBond: Story = {
  beforeEach: () => {
    const { lots } = setupBondPortfolioScenario('Vault');
    const bonds = getArgonBonds();
    bondLot = new BondLot(
      lots[0].id,
      {
        ...lots[0],
        createdFrameId: bonds.data.currentFrameId,
        participatedFrames: 0,
        cumulativeEarnings: 0n,
        lastFrameEarningsFrameId: null,
        lastFrameEarnings: null,
        isFlexible: true,
      },
      lots[0].owner,
    );
    bonds.data.bondLots = [bondLot];
    bonds.data.dailyEarnings = [];
    const history = bonds.data.bondHistory[0];
    history.createdFrame = bondLot.createdFrameId;
    history.participatedFrames = 0;
    history.cumulativeEarningsMicrogons = 0n;
    history.purchaseBlockNumber = history.firstObservedBlockNumber;
    history.purchaseBlockHash = history.firstObservedBlockHash;
    history.purchaseBlockTime = new Date('2026-08-17T12:00:00Z');
    history.flexibilityHistory = [
      {
        isFlexible: true,
        cumulativeEarningsMicrogons: 0n,
        source: 'flexibility-change',
        blockNumber: history.purchaseBlockNumber,
        blockHash: history.purchaseBlockHash,
        blockTime: history.purchaseBlockTime,
        extrinsicIndex: 2,
        eventIndex: 1,
      },
    ];
    delete history.earningsHistoryThroughFrame;
    bonds.data.bondHistory = [history];
    position = new ArgonBondsFinancials(bonds).createFinancialPositions({
      bondLots: bonds.data.bondLots,
      historyRecords: bonds.data.bondHistory,
      dailyEarnings: bonds.data.dailyEarnings,
      completedFrame: bonds.data.currentFrameId - 1,
      frameDates: new Map([[bondLot.createdFrameId, history.purchaseBlockTime]]),
    })[0];
  },
};

export const IncompleteDailyEarnings: Story = {
  beforeEach: () => {
    const { lots, positions } = setupBondPortfolioScenario('Vault');
    bondLot = lots[0];
    position = positions[0];
    getArgonBonds().data.dailyEarnings[0].earningsMicrogons = undefined;
    getArgonBonds().data.dailyEarnings[0].displacedMicrogons = undefined;
    getArgonBonds().data.dailyEarnings[0].bonds = undefined;
  },
};

export const NoDailyEarnings: Story = {
  beforeEach: () => {
    const { lots, positions } = setupBondPortfolioScenario('Vault');
    bondLot = lots[0];
    position = positions[0];
    getArgonBonds().data.dailyEarnings = [];
  },
};

export const AwaitingFinalizedEarnings: Story = {
  beforeEach: () => {
    const { lots, positions } = setupBondPortfolioScenario('Vault');
    bondLot = new BondLot(
      lots[0].id,
      { ...lots[0], participatedFrames: 4, cumulativeEarnings: 1_220_000n },
      lots[0].owner,
    );
    position = positions[0];
    position.bondLot = bondLot;
    position.paidIncome = bondLot.cumulativeEarnings;
    const bonds = getArgonBonds();
    bonds.data.bondLots[0] = bondLot;
    bonds.data.currentFrameId += 1;
  },
};

export const LongDailyHistory: Story = {
  beforeEach: () => {
    const { lots, positions } = setupBondPortfolioScenario('Vault');
    bondLot = new BondLot(
      lots[0].id,
      { ...lots[0], participatedFrames: 24, cumulativeEarnings: 12_000_000n },
      lots[0].owner,
    );
    position = positions[0];
    position.bondLot = bondLot;
    position.paidIncome = bondLot.cumulativeEarnings;
    const bonds = getArgonBonds();
    bonds.data.bondLots[0] = bondLot;
    bonds.data.dailyEarnings = Array.from({ length: 24 }, (_, index) => ({
      ...bonds.data.dailyEarnings[0],
      frameId: bondLot!.createdFrameId + index,
      earningsMicrogons: 500_000n,
    }));
    const history = bonds.data.bondHistory[0];
    history.participatedFrames = 24;
    history.cumulativeEarningsMicrogons = bondLot.cumulativeEarnings;
    history.earningsHistoryThroughFrame = bondLot.createdFrameId + 23;
    history.purchaseBlockTime = new Date('2026-08-11T12:03:00Z');
    bonds.data.currentFrameId = bondLot.createdFrameId + 24;
  },
};

export const AllDailyEarnings: Story = {
  ...LongDailyHistory,
  play: async () => {
    const dialog = document.querySelector('[data-testid="BondDetailOverlay"]')!;
    dialog.removeAttribute('inert');
    await userEvent.click(within(dialog as HTMLElement).getByRole('button', { name: 'Show all earnings' }));
    dialog.setAttribute('inert', '');
  },
};

export const Archived: Story = {
  beforeEach: () => {
    position = setupBondArchiveScenario('Vault');
    bondLot = undefined;
  },
};

export const VaultOperatorDailyEarnings: Story = {
  beforeEach: () => {
    const { lots, positions } = setupBondPortfolioScenario('Vault', 26.32);
    bondLot = lots[1];
    position = positions[1];
    mocked(getMyVault, { partial: true }).mockReturnValue({ vaultId: bondLot.vaultId });
  },
};
