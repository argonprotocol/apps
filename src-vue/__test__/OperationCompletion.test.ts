import { expect, it, vi } from 'vitest';
import { encodeAddress } from '@argonprotocol/mainchain';
import { Operation, runOperation } from '../../e2e/flows/operations/index.ts';
import miningConnectServer from '../../e2e/flows/operations/Mining.op.connectServer.ts';
import miningFinalizeSetup from '../../e2e/flows/operations/Mining.op.finalizeSetup.ts';
import miningFundWallet from '../../e2e/flows/operations/Mining.op.fundWallet.ts';
import { createMiningFlowContext } from '../../e2e/flows/contexts/miningContext.ts';
import { sudoFundWallet } from '../../e2e/flows/helpers/sudoFundWallet.ts';
import type { IE2EFlowRuntime, IE2EQueryAppOptions } from '../../e2e/flows/types.ts';
import type { IAppQueryFn, IAppQueryRefs } from '../interfaces/IAppQueryRefs.ts';
import { MiningSetupStatus } from '../interfaces/IConfig.ts';
import { getMiningFundingState } from '../screens/mining-screen/miningFunding.ts';
import { FinancialPositionBook, reduceFinancialPositions } from '../lib/financials/index.ts';
import { financialGroups } from '../interfaces/IFinancialPosition.ts';

vi.mock('../../e2e/flows/helpers/sudoFundWallet.ts', () => ({ sudoFundWallet: vi.fn() }));

it('waits at post-run validation for a stale financial snapshot to recover', async () => {
  const book = new FinancialPositionBook();
  book.setScope({ ownedAccounts: ['synthetic-account'] });
  const observation = { observedAt: new Date('2026-10-09T12:00:00Z'), blockNumber: 10, blockHash: '0x10' };
  for (const group of financialGroups) book.publish(book.beginRefresh(group), [], observation);

  let uiValidated = false;
  const implementation = {
    postRunTimeoutMs: 1_000,
    async inspect() {
      const financials = reduceFinancialPositions(book.snapshots);
      const complete = uiValidated && financials.readiness === 'ready';
      return {
        state: complete ? 'complete' : 'runnable',
        blockers: complete ? [] : ['financial positions are partial'],
      };
    },
    async run() {
      uiValidated = true;
      book.fail(book.beginRefresh('vaulting'), 'Vault revenue changed during the financial snapshot');
    },
  };
  const operation = new Operation(import.meta, implementation);
  let settled = false;
  const completion = runOperation({}, operation, { throwIfNotReady: true }).then(
    () => {
      settled = true;
    },
    error => {
      settled = true;
      throw error;
    },
  );
  void completion.catch(() => undefined);

  await vi.waitFor(() => expect(reduceFinancialPositions(book.snapshots).readiness).toBe('partial'));
  await new Promise(resolve => setTimeout(resolve, 150));
  expect(settled).toBe(false);
  book.publish(book.beginRefresh('vaulting'), [], observation);
  await completion;
  expect((await operation.inspect({})).state).toBe('complete');
});

it('fails within the post-run budget when financial state remains incomplete', async () => {
  let uiValidated = false;
  const implementation = {
    postRunTimeoutMs: 100,
    async inspect() {
      return {
        state: 'runnable',
        blockers: uiValidated ? ['financial positions are partial'] : ['UI validation pending'],
      };
    },
    async run() {
      uiValidated = true;
    },
  };
  const operation = new Operation(import.meta, implementation);
  const completion = runOperation({}, operation, { throwIfNotReady: true });
  await expect(completion).rejects.toThrow('timed out');
  await expect(completion).rejects.toThrow('financial positions are partial');
  expect((await operation.inspect({})).blockers).toEqual(['financial positions are partial']);
});

it('reports the latest inspected state when an operation without a post-run wait fails', async () => {
  let uiValidated = false;
  const operation = new Operation(import.meta, {
    async inspect() {
      return {
        state: 'runnable',
        blockers: uiValidated ? ['financial positions are partial'] : ['UI validation pending'],
      };
    },
    async run() {
      uiValidated = true;
    },
  });

  const completion = runOperation({}, operation, { throwIfNotReady: true });
  await expect(completion).rejects.toThrow('did not complete after run');
  await expect(completion).rejects.toThrow(
    'inspect={"state":"runnable","blockers":["financial positions are partial"]}',
  );
});

it('resumes an open mining connection and repairs funding invalidated before launch', async () => {
  vi.useFakeTimers();
  const config = {
    hasSavedBiddingRules: true,
    isServerAdded: false,
    miningSetupStatus: MiningSetupStatus.Checklist,
    biddingRules: { initialMicrogonRequirement: 1_000_000n, initialMicronotRequirement: 0n },
  };
  let microgons = 500_000_000n;
  let micronots = 0n;
  let walletOpen = false;
  let serverPanelOpen = true;
  let launched = false;
  const refs = {
    config,
    defaultArgonAddress: encodeAddress(new Uint8Array(32).fill(0x66)),
    wallets: {
      get totalMiningMicrogons() {
        return microgons;
      },
      defaultArgonWallet: {
        get availableMicronots() {
          return micronots;
        },
        reservedMicronots: 0n,
      },
      miningBotWallet: { availableMicronots: 0n, reservedMicronots: 0n },
    },
  };
  const fundingState = () =>
    getMiningFundingState({
      hasSavedBiddingRules: config.hasSavedBiddingRules,
      miningSetupStatus: config.miningSetupStatus,
      miningMicrogonsOnHand: microgons,
      miningMicronotsOnHand: micronots,
      ...config.biddingRules,
    });

  vi.mocked(sudoFundWallet).mockImplementation(async funding => {
    microgons = funding.microgons;
    micronots = funding.micronots;
    return {
      address: funding.address,
      requestedMicrogons: funding.microgons,
      requestedMicronots: funding.micronots,
      fundedMicrogons: microgons,
      fundedMicronots: micronots,
    };
  });
  const flow = {
    input: { serverTab: 'remote', fundingArgons: '500' },
    queryApp: async (read: IAppQueryFn<unknown, Record<string, unknown>>, options?: IE2EQueryAppOptions) => {
      return await read(refs as unknown as IAppQueryRefs, options?.args ?? {});
    },
    isVisible: async (target: string | { selector?: string }) => {
      const id = typeof target === 'string' ? target : (target.selector ?? '');
      const visibility: Record<string, boolean> = {
        MiningDashboard: launched,
        WalletOverlay: walletOpen,
        '.ConnectOverlay': serverPanelOpen,
        'SetupChecklist.openServerConnectPanel()': !serverPanelOpen,
        'ServerOverlay.closeOverlay()': serverPanelOpen,
        'SetupChecklist.openFundMiningAccountOverlay()': true,
        'SetupChecklist.launchMiningBot()': !launched,
      };
      const visible = visibility[id] ?? false;
      return {
        ok: true,
        visible,
        exists: visible,
        enabled: visible,
        clickable: visible && (id !== 'SetupChecklist.launchMiningBot()' || fundingState().isFullyFunded),
      };
    },
    click: async (id: string) => {
      if (id === 'SetupChecklist.openServerConnectPanel()') {
        if (serverPanelOpen) throw new Error('The connection opener is hidden while its panel is open.');
        serverPanelOpen = true;
      } else if (id === 'ServerConnectPanel.connect()') {
        config.isServerAdded = true;
      } else if (id === 'ServerOverlay.closeOverlay()') {
        serverPanelOpen = false;
      } else if (id === 'SetupChecklist.openFundMiningAccountOverlay()') {
        walletOpen = true;
      } else if (id === 'WalletOverlay.closeRight()') {
        walletOpen = false;
      } else if (id === 'SetupChecklist.launchMiningBot()') {
        if (!config.isServerAdded || !fundingState().isFullyFunded) throw new Error('Mining is not ready to launch.');
        launched = true;
      } else if (id !== "ServerConnectPanel.selectedTab='remote'") {
        throw new Error(`Unexpected UI action: ${id}`);
      }
    },
    getAttribute: async (id: string) => {
      if (id === 'WalletOverlay.microgonsNeeded') return fundingState().requiredMicrogons.toString();
      if (id === 'WalletOverlay.micronotsNeeded') return fundingState().additionalMicronotsNeeded.toString();
      if (id === 'TotalBlocksMined' && launched) return '1';
      return null;
    },
    waitFor: async () => undefined,
    count: async () => 0,
    getText: async () => '',
  };
  const context = createMiningFlowContext(flow as unknown as IE2EFlowRuntime, 'synthetic-mining');

  try {
    await runOperation(context, miningFundWallet, { throwIfNotReady: true });
    await runOperation(context, miningConnectServer, { throwIfNotReady: true });
    expect(config.isServerAdded).toBe(true);
    expect(fundingState().isFullyFunded).toBe(true);

    config.biddingRules.initialMicronotRequirement = 10_000n;
    expect(fundingState().isFullyFunded).toBe(false);

    const completed = runOperation(context, miningFinalizeSetup, { throwIfNotReady: true });
    void completed.catch(() => undefined);
    await vi.runAllTimersAsync();
    await expect(completed).resolves.toBeUndefined();

    expect(micronots).toBeGreaterThanOrEqual(config.biddingRules.initialMicronotRequirement);
    expect(microgons).toBeGreaterThanOrEqual(fundingState().requiredMicrogons);
    expect(fundingState().isFullyFunded).toBe(true);
    expect((await miningFinalizeSetup.inspect(context)).state).toBe('complete');
  } finally {
    vi.useRealTimers();
    vi.mocked(sudoFundWallet).mockReset();
  }
});
