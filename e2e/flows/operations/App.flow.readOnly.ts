import { OperationalFlow } from './index.ts';
import type { IE2EFlowRuntime, IE2EOperationInspectState } from '../types.ts';

interface IReadOnlyFlowContext {
  flow: IE2EFlowRuntime;
}

type IReadOnlyFlowState = IE2EOperationInspectState<
  { archivedBitcoinLiquidId?: number; bitcoinLiquidIds: number[] },
  {
    canSign: boolean;
    defaultArgonAddress?: string;
    expectedDefaultArgonAddress?: string;
    defaultEthereumAddress?: string;
    expectedEthereumAddress?: string;
    expectsOperations?: boolean;
    badgeVisible: boolean;
    hasOperationsAccess: boolean;
    configuredServerLoaded: boolean;
    serverUnavailableVisible: boolean;
    recoveryInProgress: boolean;
    upstreamName?: string;
    upstreamVisible: boolean;
    vaultId?: number;
    bitcoinLiquidIds: number[];
    expectedBitcoinLiquidIds: number[];
    archivedBitcoinLiquidVisible: boolean;
  }
>;

export default new OperationalFlow<IReadOnlyFlowContext, IReadOnlyFlowState>(import.meta, {
  description: 'Verify that an operational account loads its available state without signing or server access.',
  defaultTimeoutMs: 60_000,
  createContext: flow => ({ flow }),
  async inspect({ flow }) {
    const expectsBitcoinLiquid = flow.input.expectsBitcoinLiquid === true;
    const expectedBitcoinLiquidIds = (flow.input.expectedBitcoinLiquidIds ?? []) as number[];
    const appState = await flow.queryApp(
      (refs, args: { expectsBitcoinLiquid: boolean }) => ({
        canSign: refs.canSign,
        defaultArgonAddress: refs.defaultArgonAddress,
        defaultEthereumAddress: refs.defaultEthereumAddress,
        hasOperationsAccess: refs.config.hasExtensionOperations,
        configuredServerLoaded: refs.config.isServerAdded,
        recoveryInProgress: refs.config.isBootingUpPreviousWalletHistory,
        upstreamName: refs.config.upstreamOperator?.name,
        vaultId: refs.myVault.vaultId,
        bitcoinLiquidIds: refs
          .getBitcoinFissions()
          .getLiquids()
          .map(liquid => liquid.liquidId),
        archivedBitcoinLiquidId: args.expectsBitcoinLiquid
          ? refs
              .getBitcoinFissions()
              .getLiquids()
              .find(liquid => liquid.isClosed)?.liquidId
          : undefined,
      }),
      { args: { expectsBitcoinLiquid } },
    );
    const badgeVisible = (await flow.isVisible({ selector: '[data-read-only]' })).visible;
    const serverUnavailableVisible = (await flow.isVisible({ selector: '[data-server-unavailable]' })).visible;
    const upstreamVisible = (await flow.isVisible({ selector: '[data-upstream-operator]' })).visible;
    const archivedBitcoinLiquidVisible =
      expectsBitcoinLiquid && appState?.archivedBitcoinLiquidId !== undefined
        ? (
            await flow.isVisible({
              testId: `BitcoinLiquid.archived-${appState.archivedBitcoinLiquidId}`,
            })
          ).visible
        : !expectsBitcoinLiquid;
    const expectedDefaultArgonAddress = String(flow.input.expectedDefaultArgonAddress ?? '');
    const expectedEthereumAddress = String(flow.input.expectedEthereumAddress ?? '');
    const expectsConfiguredServer = flow.input.expectsConfiguredServer !== false;
    const expectsUpstream = flow.input.expectsUpstream !== false;
    const expectsVault = flow.input.expectsVault !== false;
    const expectsOperations = flow.input.expectsOperations !== false;
    const hasRecoveredBitcoinLiquid = !expectsBitcoinLiquid || appState?.archivedBitcoinLiquidId !== undefined;
    const hasExpectedBitcoinLiquidIds = expectedBitcoinLiquidIds.every(id => appState?.bitcoinLiquidIds.includes(id));
    const hasExpectedIdentity = expectedDefaultArgonAddress
      ? appState?.defaultArgonAddress === expectedDefaultArgonAddress
      : !!expectedEthereumAddress &&
        appState?.defaultEthereumAddress.toLowerCase() === expectedEthereumAddress.toLowerCase();
    const hasExpectedServerState = expectsConfiguredServer
      ? appState?.configuredServerLoaded && serverUnavailableVisible
      : !appState?.configuredServerLoaded && !serverUnavailableVisible;
    const hasExpectedUpstreamState = expectsUpstream
      ? !!appState?.upstreamName && upstreamVisible
      : !appState?.upstreamName && !upstreamVisible;
    const isComplete =
      appState?.canSign === false &&
      badgeVisible &&
      !appState?.recoveryInProgress &&
      appState?.hasOperationsAccess === expectsOperations &&
      hasExpectedIdentity &&
      hasExpectedServerState &&
      hasExpectedUpstreamState &&
      (!expectsVault || appState?.vaultId != null) &&
      hasRecoveredBitcoinLiquid &&
      hasExpectedBitcoinLiquidIds &&
      archivedBitcoinLiquidVisible;

    return {
      chainState: {
        archivedBitcoinLiquidId: appState?.archivedBitcoinLiquidId,
        bitcoinLiquidIds: appState?.bitcoinLiquidIds ?? [],
      },
      uiState: {
        canSign: appState?.canSign ?? true,
        defaultArgonAddress: appState?.defaultArgonAddress,
        expectedDefaultArgonAddress,
        defaultEthereumAddress: appState?.defaultEthereumAddress,
        expectedEthereumAddress,
        badgeVisible,
        hasOperationsAccess: appState?.hasOperationsAccess ?? false,
        configuredServerLoaded: appState?.configuredServerLoaded ?? false,
        serverUnavailableVisible,
        recoveryInProgress: appState?.recoveryInProgress ?? false,
        upstreamName: appState?.upstreamName,
        upstreamVisible,
        vaultId: appState?.vaultId,
        bitcoinLiquidIds: appState?.bitcoinLiquidIds ?? [],
        expectedBitcoinLiquidIds,
        archivedBitcoinLiquidVisible,
      },
      state: isComplete ? 'complete' : 'runnable',
      blockers: [
        ...(appState?.canSign === false ? [] : ['app still reports signing access']),
        ...(badgeVisible ? [] : ['readonly badge is not visible']),
        ...(!appState?.recoveryInProgress ? [] : ['blockchain history recovery is still in progress']),
        ...(appState?.hasOperationsAccess === expectsOperations
          ? []
          : [`operations access should be ${expectsOperations ? 'enabled' : 'disabled'}`]),
        ...(hasExpectedIdentity ? [] : ['wallet metadata identity was not loaded']),
        ...(hasExpectedServerState ? [] : ['configured server state does not match the account package']),
        ...(hasExpectedUpstreamState ? [] : ['upstream operator state does not match the account package']),
        ...(!expectsVault || appState?.vaultId != null ? [] : ['on-chain vault state was not loaded']),
        ...(hasRecoveredBitcoinLiquid ? [] : ['archived Bitcoin Liquid was not recovered']),
        ...(hasExpectedBitcoinLiquidIds ? [] : ['expected Bitcoin Liquid history was not loaded']),
        ...(archivedBitcoinLiquidVisible ? [] : ['archived Bitcoin Liquid row is not visible']),
      ],
    };
  },
  async run({ flow }) {
    if (flow.input.historyThroughBlock !== undefined) {
      const historyThroughBlock = Number(flow.input.historyThroughBlock);
      if (!Number.isSafeInteger(historyThroughBlock) || historyThroughBlock < 1) {
        throw new Error(
          `historyThroughBlock must be a positive safe integer, got ${String(flow.input.historyThroughBlock)}`,
        );
      }
      const historyRecovery = await flow.queryApp(
        (refs, args: { throughBlock: number }) => refs.accountHistoryRecovery.recoverThrough(args.throughBlock),
        {
          args: { throughBlock: historyThroughBlock },
          timeoutMs: 300_000,
        },
      );
      if (!historyRecovery) {
        throw new Error(
          `Account history did not finish recovery through block ${historyThroughBlock.toLocaleString()}`,
        );
      }
      flow.setData('historyRecovery', historyRecovery);
    }

    if (flow.input.expectsBitcoinLiquid === true || ((flow.input.expectedBitcoinLiquidIds ?? []) as number[]).length) {
      await flow.poll<IReadOnlyFlowState>(latest => !latest.uiState.recoveryInProgress, {
        pollMs: 1_000,
        timeoutMs: 60_000,
        timeoutMessage: 'Account did not finish loading its readonly state before Bitcoin navigation.',
      });
      const bitcoinScreen = await flow.isVisible('BitcoinScreen');
      if (!bitcoinScreen.visible) {
        await flow.click('LeftBar.goto(TopTab.BitcoinLocks)', { timeoutMs: 10_000 });
        await flow.waitFor('BitcoinScreen', { timeoutMs: 10_000 });
      }
    }
    await flow.poll<IReadOnlyFlowState>(latest => latest.state === 'complete', {
      pollMs: 1_000,
      timeoutMs: 60_000,
      timeoutMessage: 'Account did not finish loading its readonly state.',
    });
  },
});
