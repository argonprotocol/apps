import { OperationalFlow } from './index.ts';
import type { IE2EFlowRuntime, IE2EOperationInspectState } from '../types.ts';
import { calculatePositionReturn, type IFinancialAggregate } from '../types/srcVue.ts';

interface IAccountReviewFlowContext {
  flow: IE2EFlowRuntime;
}

type IAccountReviewFlowState = IE2EOperationInspectState<
  {
    archivedBitcoinLiquidIds: number[];
    bitcoinLiquidIds: number[];
    bondLotIds: number[];
    flexibleBondLotIds: number[];
    stakeLotIds: number[];
    historicalBondLotIds: number[];
    historicalStakeLotIds: number[];
    vaultBitcoinMapItemCount: number;
    vaultBondMapItemCount: number;
    financialSnapshot?: IFinancialAggregate;
  },
  {
    canSign: boolean;
    defaultArgonAddress?: string;
    expectedDefaultArgonAddress?: string;
    defaultEthereumAddress?: string;
    expectedEthereumAddress?: string;
    badgeVisible: boolean;
    hasTreasuryAccess: boolean;
    hasOperationsAccess: boolean;
    configuredServerLoaded: boolean;
    serverUnavailableVisible: boolean;
    recoveryInProgress: boolean;
    upstreamName?: string;
    upstreamVisible: boolean;
    vaultId?: number;
    expectedBitcoinLiquidIds: number[];
    expectedArchivedBitcoinLiquidIds: number[];
    expectedBondLotIds: number[];
    expectedFlexibleBondLotIds: number[];
    expectedStakeLotIds: number[];
    expectedHistoricalBondLotIds: number[];
    expectedHistoricalStakeLotIds: number[];
    expectedReleasedBondLotIds: number[];
    expectedVaultBitcoinMapItemCount?: number;
    expectedVaultBondMapItemCount?: number;
    dataReady: boolean;
    incompleteBitcoinLiquids: Array<{ liquidId: number; issues: string[] }>;
    incompleteBondLots: Array<{ bondLotId: number; issues: string[] }>;
    invalidFinancialReturns: string[];
  }
>;

export default new OperationalFlow<IAccountReviewFlowContext, IAccountReviewFlowState>(import.meta, {
  description: 'Verify that an operational account loads its available state without signing or server access.',
  defaultTimeoutMs: 60_000,
  createContext: flow => ({ flow }),
  async inspect({ flow }) {
    const expectsBitcoinLiquid = flow.input.expectsBitcoinLiquid === true;
    const expectedBitcoinLiquidIds = (flow.input.expectedBitcoinLiquidIds ?? []) as number[];
    const expectedArchivedBitcoinLiquidIds = (flow.input.expectedArchivedBitcoinLiquidIds ?? []) as number[];
    const expectedBondLotIds = (flow.input.expectedBondLotIds ?? []) as number[];
    const expectedFlexibleBondLotIds = (flow.input.expectedFlexibleBondLotIds ?? []) as number[];
    const expectedStakeLotIds = (flow.input.expectedStakeLotIds ?? []) as number[];
    const expectedHistoricalBondLotIds = (flow.input.expectedHistoricalBondLotIds ?? []) as number[];
    const expectedHistoricalStakeLotIds = (flow.input.expectedHistoricalStakeLotIds ?? []) as number[];
    const expectedReleasedBondLotIds = (flow.input.expectedReleasedBondLotIds ?? []) as number[];
    const expectedVaultBitcoinMapItemCount = flow.input.expectedVaultBitcoinMapItemCount as number | undefined;
    const expectedVaultBondMapItemCount = flow.input.expectedVaultBondMapItemCount as number | undefined;
    const appState = await flow.queryApp(refs => {
      const financials = refs.getFinancials().financialPositionAggregate;
      const allBondPositions = financials.groupSummaries.bonds.positions.filter(position => {
        return position.kind === 'bond';
      });
      const incompleteBitcoinLiquids = financials.groupSummaries.bitcoin.positions.flatMap(position => {
        if (position.kind !== 'bitcoin-liquid') return [];
        const issues: string[] = [];
        if (position.insuranceCost === undefined) issues.push('securitization fees');
        if (position.transactionFees === undefined) issues.push('transaction fees');
        if (position.totalFees === undefined) issues.push('total fees');
        if (position.investedCost === undefined) issues.push('investment basis');
        if (position.performanceEndingCapital === undefined) issues.push('performance capital');
        if (position.totalReturn === undefined || !Number.isFinite(position.totalReturn)) issues.push('return');
        if (position.startedAt === undefined) issues.push('opening date');
        if (position.lifecycle === 'completed') {
          if (position.endedAt === undefined) issues.push('closing date');
          if (position.liquid.closeHistoryEntry?.transactionFee === undefined) issues.push('close transaction fee');
          if (position.liquid.closeHistoryEntry?.totalCloseCost === undefined) issues.push('total close cost');
        }
        if (position.liquid.history.some(entry => entry.blockTime === undefined)) issues.push('history dates');
        return issues.length ? [{ liquidId: position.liquidId, issues }] : [];
      });
      const incompleteBondLots = allBondPositions.flatMap(position => {
        const issues: string[] = [];
        if (position.investedCost === undefined) issues.push('principal basis');
        if (position.currentValue === undefined) issues.push('current value');
        if (position.startedAt === undefined) issues.push('opening date');
        if (position.returnIsComplete === false) issues.push('return history');
        const bondLotId = position.bondLot?.id ?? position.history?.bondLotId;
        return issues.length && bondLotId !== undefined ? [{ bondLotId, issues }] : [];
      });
      const invalidFinancialReturns: string[] = financials.groups.flatMap(group => {
        const percent = group.returnSummary.percent;
        return percent !== undefined && !Number.isFinite(percent) ? [group.group] : [];
      });
      if (financials.accountReturn.percent !== undefined && !Number.isFinite(financials.accountReturn.percent)) {
        invalidFinancialReturns.push('account');
      }
      for (const position of allBondPositions) {
        if (position.paidIncome < 0n) invalidFinancialReturns.push(`${position.id}: negative bond income`);
        if (position.nativeAsset !== 'ARGN') continue;
        if (
          position.currentValue !== undefined &&
          position.investedCost !== undefined &&
          position.settledPrincipalValue !== undefined &&
          position.currentValue + position.settledPrincipalValue !== position.investedCost
        ) {
          invalidFinancialReturns.push(`${position.id}: bond principal is not conserved`);
        }
      }
      const ordinaryBondPositions = allBondPositions.filter(position => position.returnAttribution !== 'vault');
      if (ordinaryBondPositions.length) {
        const bondProfit = financials.groupSummaries.bonds.returnSummary.returnAmount;
        const distributedIncome = ordinaryBondPositions.reduce((total, position) => total + position.paidIncome, 0n);
        if (bondProfit !== distributedIncome) {
          invalidFinancialReturns.push('bond profit does not equal distributed income');
        }
      }
      const vaultId = refs.myVault.vaultId;
      const vaultBitcoinMapItemCount = refs.myVault.createdVault
        ? refs.bitcoinLocks
            .getAllLocks({ includeHistoryRecoveryPending: true })
            .filter(
              lock =>
                lock.vaultId === refs.myVault.createdVault!.vaultId &&
                !refs.bitcoinLocks.isInactiveForVaultDisplay(lock) &&
                (refs.bitcoinLocks.isLockFunded(lock) || refs.bitcoinLocks.isReleaseStatus(lock)),
            ).length + Object.values(refs.myVault.data.externalLocks).filter(lock => !lock.isPending).length
        : 0;
      const vaultBondMapItemCount =
        vaultId == null
          ? 0
          : (refs.getArgonBonds().data.vaultsById[vaultId]?.bondLots ?? []).filter(bondLot => bondLot.activeBonds > 0)
              .length;
      return {
        canSign: refs.canSign,
        defaultArgonAddress: refs.defaultArgonAddress,
        defaultEthereumAddress: refs.defaultEthereumAddress,
        hasTreasuryAccess: refs.config.hasExtensionTreasury,
        hasOperationsAccess: refs.config.hasExtensionOperations,
        configuredServerLoaded: refs.config.isServerAdded,
        recoveryInProgress: refs.config.isBootingUpPreviousWalletHistory,
        upstreamName: refs.config.upstreamOperator?.name,
        vaultId,
        vaultBitcoinMapItemCount,
        vaultBondMapItemCount,
        financialSnapshot: financials,
        incompleteBitcoinLiquids,
        incompleteBondLots,
        invalidFinancialReturns,
      };
    });
    const financialSnapshot = appState?.financialSnapshot;
    const bitcoinLiquidPositions =
      financialSnapshot?.groupSummaries.bitcoin.positions.filter(position => position.kind === 'bitcoin-liquid') ?? [];
    const allBondPositions =
      financialSnapshot?.groupSummaries.bonds.positions.filter(position => position.kind === 'bond') ?? [];
    const bondPositions = allBondPositions.filter(position => {
      return position.bondLot !== undefined && position.lifecycle !== 'completed';
    });
    const bitcoinLiquidIds = bitcoinLiquidPositions.map(position => position.liquidId);
    const archivedBitcoinLiquidIds = bitcoinLiquidPositions
      .filter(position => position.lifecycle === 'completed')
      .map(position => position.liquidId);
    const bondLotIds = bondPositions
      .filter(position => position.bondLot?.programType === 'Vault')
      .map(position => position.bondLot!.id);
    const flexibleBondLotIds = bondPositions
      .filter(position => position.bondLot?.programType === 'Vault' && position.bondLot.isFlexible)
      .map(position => position.bondLot!.id);
    const stakeLotIds = bondPositions
      .filter(position => position.bondLot?.programType === 'Argonot')
      .map(position => position.bondLot!.id);
    const historicalBondLotIds = allBondPositions.flatMap(position =>
      position.lifecycle === 'completed' &&
      position.history?.programType === 'Vault' &&
      position.history.releaseBlockNumber !== undefined
        ? [position.history.bondLotId]
        : [],
    );
    const historicalStakeLotIds = allBondPositions.flatMap(position =>
      position.lifecycle === 'completed' &&
      position.history?.programType === 'Argonot' &&
      position.history.releaseBlockNumber !== undefined
        ? [position.history.bondLotId]
        : [],
    );
    const [badgeVisible, serverUnavailableVisible, upstreamVisible] = await Promise.all([
      flow.isVisible({ selector: '[data-read-only]' }).then(result => result.visible),
      flow.isVisible({ selector: '[data-server-unavailable]' }).then(result => result.visible),
      flow.isVisible({ selector: '[data-upstream-operator]' }).then(result => result.visible),
    ]);
    const expectedDefaultArgonAddress = String(flow.input.expectedDefaultArgonAddress ?? '');
    const expectedEthereumAddress = String(flow.input.expectedEthereumAddress ?? '');
    const expectsConfiguredServer = flow.input.expectsConfiguredServer !== false;
    const expectsUpstream = flow.input.expectsUpstream !== false;
    const expectsVault = flow.input.expectsVault !== false;
    const expectsOperations = flow.input.expectsOperations !== false;
    const expectsTreasury = flow.input.expectsTreasury !== false;
    const hasRecoveredBitcoinLiquid =
      (!expectsBitcoinLiquid || bitcoinLiquidIds.length > 0) &&
      expectedArchivedBitcoinLiquidIds.every(id => archivedBitcoinLiquidIds.includes(id));
    const hasExpectedBitcoinLiquidIds = expectedBitcoinLiquidIds.every(id => bitcoinLiquidIds.includes(id));
    const hasExpectedBondLotIds =
      expectedBondLotIds.length === bondLotIds.length && expectedBondLotIds.every(id => bondLotIds.includes(id));
    const hasExpectedFlexibleBondLotIds =
      expectedFlexibleBondLotIds.length === flexibleBondLotIds.length &&
      expectedFlexibleBondLotIds.every(id => flexibleBondLotIds.includes(id));
    const hasExpectedStakeLotIds =
      expectedStakeLotIds.length === stakeLotIds.length && expectedStakeLotIds.every(id => stakeLotIds.includes(id));
    const hasExpectedHistoricalBondLotIds = expectedHistoricalBondLotIds.every(id => historicalBondLotIds.includes(id));
    const hasExpectedHistoricalStakeLotIds = expectedHistoricalStakeLotIds.every(id =>
      historicalStakeLotIds.includes(id),
    );
    const hasExpectedReleasedBondLotIds = expectedReleasedBondLotIds.every(
      id => historicalBondLotIds.includes(id) || historicalStakeLotIds.includes(id),
    );
    const expectsBondFinancials = flow.input.expectsBondFinancials === true;
    const hasExpectedBondFinancials = !expectsBondFinancials || bondLotIds.length + stakeLotIds.length > 0;
    const hasExpectedVaultBitcoinMap =
      expectedVaultBitcoinMapItemCount === undefined ||
      (appState?.vaultBitcoinMapItemCount ?? 0) >= expectedVaultBitcoinMapItemCount;
    const hasExpectedVaultBondMap =
      expectedVaultBondMapItemCount === undefined ||
      (appState?.vaultBondMapItemCount ?? 0) >= expectedVaultBondMapItemCount;
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
    const hasLoadedFinancialPositions =
      financialSnapshot?.readiness === 'ready' &&
      financialSnapshot.groups.every(group => group.state === 'ready' || group.state === 'stale');
    const hasCompleteBitcoinLiquids = appState?.incompleteBitcoinLiquids.length === 0;
    const hasCompleteBondLots = appState?.incompleteBondLots.length === 0;
    const hasValidFinancialReturns = appState?.invalidFinancialReturns.length === 0;
    const financialPositionBlockers: string[] = [];
    if (!hasLoadedFinancialPositions) {
      for (const { group, state, message } of financialSnapshot?.groups.filter(
        group => group.state !== 'ready' && group.state !== 'stale',
      ) ?? []) {
        financialPositionBlockers.push(`${group} financials are ${state}${message ? `: ${message}` : ''}`);
      }
      if (!financialPositionBlockers.length) {
        financialPositionBlockers.push(`financial positions are ${financialSnapshot?.readiness ?? 'loading'}`);
      }
    }
    const isDataReady =
      appState?.canSign === false &&
      badgeVisible &&
      !appState?.recoveryInProgress &&
      appState?.hasOperationsAccess === expectsOperations &&
      appState?.hasTreasuryAccess === expectsTreasury &&
      hasExpectedIdentity &&
      hasExpectedServerState &&
      hasExpectedUpstreamState &&
      hasLoadedFinancialPositions &&
      hasCompleteBitcoinLiquids &&
      hasCompleteBondLots &&
      hasValidFinancialReturns &&
      (!expectsVault || appState?.vaultId != null) &&
      hasRecoveredBitcoinLiquid &&
      hasExpectedBitcoinLiquidIds &&
      hasExpectedBondLotIds &&
      hasExpectedFlexibleBondLotIds &&
      hasExpectedStakeLotIds &&
      hasExpectedHistoricalBondLotIds &&
      hasExpectedHistoricalStakeLotIds &&
      hasExpectedReleasedBondLotIds &&
      hasExpectedBondFinancials &&
      hasExpectedVaultBitcoinMap &&
      hasExpectedVaultBondMap;

    return {
      chainState: {
        archivedBitcoinLiquidIds,
        bitcoinLiquidIds,
        bondLotIds,
        flexibleBondLotIds,
        stakeLotIds,
        historicalBondLotIds,
        historicalStakeLotIds,
        vaultBitcoinMapItemCount: appState?.vaultBitcoinMapItemCount ?? 0,
        vaultBondMapItemCount: appState?.vaultBondMapItemCount ?? 0,
        financialSnapshot: appState?.financialSnapshot,
      },
      uiState: {
        canSign: appState?.canSign ?? true,
        defaultArgonAddress: appState?.defaultArgonAddress,
        expectedDefaultArgonAddress,
        defaultEthereumAddress: appState?.defaultEthereumAddress,
        expectedEthereumAddress,
        badgeVisible,
        hasTreasuryAccess: appState?.hasTreasuryAccess ?? false,
        hasOperationsAccess: appState?.hasOperationsAccess ?? false,
        configuredServerLoaded: appState?.configuredServerLoaded ?? false,
        serverUnavailableVisible,
        recoveryInProgress: appState?.recoveryInProgress ?? false,
        upstreamName: appState?.upstreamName,
        upstreamVisible,
        vaultId: appState?.vaultId,
        expectedBitcoinLiquidIds,
        expectedArchivedBitcoinLiquidIds,
        expectedBondLotIds,
        expectedFlexibleBondLotIds,
        expectedStakeLotIds,
        expectedHistoricalBondLotIds,
        expectedHistoricalStakeLotIds,
        expectedReleasedBondLotIds,
        expectedVaultBitcoinMapItemCount,
        expectedVaultBondMapItemCount,
        dataReady: Boolean(isDataReady),
        incompleteBitcoinLiquids: appState?.incompleteBitcoinLiquids ?? [],
        incompleteBondLots: appState?.incompleteBondLots ?? [],
        invalidFinancialReturns: appState?.invalidFinancialReturns ?? [],
      },
      state:
        isDataReady && flow.getData<boolean>('App.flow.accountReview.uiValidated') === true ? 'complete' : 'runnable',
      blockers: [
        ...(appState?.canSign === false ? [] : ['app still reports signing access']),
        ...(badgeVisible ? [] : ['readonly badge is not visible']),
        ...(!appState?.recoveryInProgress ? [] : ['blockchain history recovery is still in progress']),
        ...(appState?.hasOperationsAccess === expectsOperations
          ? []
          : [`operations access should be ${expectsOperations ? 'enabled' : 'disabled'}`]),
        ...(appState?.hasTreasuryAccess === expectsTreasury
          ? []
          : [`treasury access should be ${expectsTreasury ? 'enabled' : 'disabled'}`]),
        ...(hasExpectedIdentity ? [] : ['wallet metadata identity was not loaded']),
        ...(hasExpectedServerState ? [] : ['configured server state does not match the account package']),
        ...(hasExpectedUpstreamState ? [] : ['upstream operator state does not match the account package']),
        ...financialPositionBlockers,
        ...(hasCompleteBitcoinLiquids
          ? []
          : (appState?.incompleteBitcoinLiquids ?? []).map(({ liquidId, issues }) => {
              return `Bitcoin Liquid ${liquidId} is incomplete: ${issues.join(', ')}`;
            })),
        ...(hasCompleteBondLots
          ? []
          : (appState?.incompleteBondLots ?? []).map(({ bondLotId, issues }) => {
              return `Bond lot ${bondLotId} is incomplete: ${issues.join(', ')}`;
            })),
        ...(hasValidFinancialReturns
          ? []
          : [`financial returns are invalid: ${appState?.invalidFinancialReturns.join(', ') ?? ''}`]),
        ...(!expectsVault || appState?.vaultId != null ? [] : ['on-chain vault state was not loaded']),
        ...(hasRecoveredBitcoinLiquid ? [] : ['expected archived Bitcoin Liquid history was not recovered']),
        ...(hasExpectedBitcoinLiquidIds ? [] : ['expected Bitcoin Liquid history was not loaded']),
        ...(hasExpectedBondLotIds ? [] : ['expected bond positions were not loaded']),
        ...(hasExpectedFlexibleBondLotIds ? [] : ['expected flexible bond positions were not loaded']),
        ...(hasExpectedStakeLotIds ? [] : ['expected stake positions were not loaded']),
        ...(hasExpectedHistoricalBondLotIds ? [] : ['expected historical bond positions were not loaded']),
        ...(hasExpectedHistoricalStakeLotIds ? [] : ['expected historical stake positions were not loaded']),
        ...(hasExpectedReleasedBondLotIds ? [] : ['chain-released bond lots were not loaded as history']),
        ...(hasExpectedBondFinancials ? [] : ['no bond or stake financial positions were loaded']),
        ...(hasExpectedVaultBitcoinMap ? [] : ['vault Bitcoin treemap omitted expected positions']),
        ...(hasExpectedVaultBondMap ? [] : ['vault bond treemap omitted expected positions']),
        ...(flow.getData<boolean>('App.flow.accountReview.uiValidated') === true
          ? []
          : ['account UI validation pending']),
      ],
    };
  },
  async run({ flow }) {
    const ready = await flow.poll<IAccountReviewFlowState>(latest => latest.uiState.dataReady, {
      pollMs: 1_000,
      timeoutMs: 60_000,
      timeoutMessage: 'Account did not finish loading its readonly state.',
    });
    const financialSnapshot = ready.chainState.financialSnapshot;
    if (!financialSnapshot) throw new Error('Account review did not produce financial state');
    const bitcoinLiquidPositions = financialSnapshot.groupSummaries.bitcoin.positions.filter(
      position => position.kind === 'bitcoin-liquid',
    );
    const allBondPositions = financialSnapshot.groupSummaries.bonds.positions.filter(
      position => position.kind === 'bond',
    );
    const bondPositions = allBondPositions.filter(position => {
      return position.bondLot !== undefined && position.lifecycle !== 'completed';
    });

    if (ready.chainState.bitcoinLiquidIds.length) {
      const bitcoinScreen = await flow.isVisible('BitcoinScreen');
      if (!bitcoinScreen.visible) {
        await flow.click('LeftBar.goto(TopTab.BitcoinLocks)', { timeoutMs: 10_000 });
        await flow.waitFor('BitcoinScreen', { timeoutMs: 10_000 });
      }
    }

    const expectedHistoryReturns = flow.input.expectedBitcoinReturnPercentByLiquidId as
      | Record<number, number>
      | undefined;
    if (expectedHistoryReturns) {
      const oracleIds = Object.keys(expectedHistoryReturns)
        .map(Number)
        .sort((left, right) => left - right);
      const expectedIds = [...ready.uiState.expectedArchivedBitcoinLiquidIds].sort((left, right) => left - right);
      if (!oracleIds.length || JSON.stringify(oracleIds) !== JSON.stringify(expectedIds)) {
        throw new Error('The independent Bitcoin return oracle must cover every expected archived Liquid');
      }
    }

    for (const liquidId of ready.chainState.bitcoinLiquidIds) {
      const isArchived = ready.chainState.archivedBitcoinLiquidIds.includes(liquidId);
      const financialPosition = bitcoinLiquidPositions.find(position => position.liquidId === liquidId);
      if (!financialPosition) {
        throw new Error(`Bitcoin Liquid ${liquidId} has no financial position liquidity`);
      }
      const expectedReceivedCents = (financialPosition.receivedLiquidity + 5_000n) / 10_000n;
      const parseRenderedCents = (text: string): bigint => {
        const amount = text.replace(/[^\d.-]/g, '');
        const [whole = '0', fraction = ''] = amount.split('.');
        return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0').slice(0, 2));
      };
      if (!isArchived) {
        const dashboardLiquidityText = await flow.getText(`BitcoinLiquid.receivedLiquidity-${liquidId}`);
        if (parseRenderedCents(dashboardLiquidityText) !== expectedReceivedCents) {
          throw new Error(
            `Bitcoin Liquid ${liquidId} rendered ${dashboardLiquidityText.trim()} received on the dashboard instead of its financial position value`,
          );
        }
      }
      await flow.click({ testId: `BitcoinLiquid.${isArchived ? 'archived' : 'active'}-${liquidId}` });
      try {
        await flow.waitFor('BitcoinLiquidDetailOverlay', { timeoutMs: 10_000 });
      } catch (error) {
        const [details, openDialogs] = await Promise.all([
          flow.isVisible('BitcoinLiquidDetailOverlay'),
          flow.count({ selector: '[role="dialog"][data-state="open"]' }),
        ]);
        throw new Error(
          `Bitcoin Liquid ${liquidId} detail did not open (exists=${details.exists}, visible=${details.visible}, openDialogs=${openDialogs}): ${String(error)}`,
        );
      }
      const [receivedLiquidityText, returnText, totalFeesText, detailsText] = await Promise.all([
        flow.getText('BitcoinLiquid.details.receivedLiquidity'),
        flow.getText('BitcoinLiquid.details.return'),
        flow.getText('BitcoinLiquid.details.totalFees'),
        flow.getText('BitcoinLiquidDetailOverlay'),
      ]);
      if (parseRenderedCents(receivedLiquidityText) !== expectedReceivedCents) {
        throw new Error(
          `Bitcoin Liquid ${liquidId} rendered ${receivedLiquidityText.trim()} received instead of its financial position value`,
        );
      }
      if (!/^-?[\d,.]+%$/.test(returnText.trim())) {
        throw new Error(`Bitcoin Liquid ${liquidId} rendered an invalid return: ${returnText.trim()}`);
      }
      const expectedReturn = financialPosition.totalReturn;
      const displayedReturn = Number(returnText.replaceAll(',', '').replaceAll('%', ''));
      if (expectedReturn === undefined || Math.abs(displayedReturn - expectedReturn) > 0.011) {
        throw new Error(
          `Bitcoin Liquid ${liquidId} return ${returnText.trim()} does not match its capital and profit (${expectedReturn}%)`,
        );
      }
      const expectedFromHistory = expectedHistoryReturns?.[liquidId];
      if (expectedHistoryReturns && isArchived && expectedFromHistory === undefined) {
        throw new Error(`Archived Bitcoin Liquid ${liquidId} has no independent return expectation`);
      }
      if (expectedFromHistory !== undefined && Math.abs(displayedReturn - expectedFromHistory) > 0.011) {
        throw new Error(
          `Bitcoin Liquid ${liquidId} return ${returnText.trim()} does not match the independent history expectation (${expectedFromHistory}%)`,
        );
      }
      if (totalFeesText.trim() === '—') {
        throw new Error(`Bitcoin Liquid ${liquidId} rendered unavailable total fees`);
      }
      if (isArchived && detailsText.toLowerCase().includes('unavailable')) {
        throw new Error(`Archived Bitcoin Liquid ${liquidId} rendered incomplete close history`);
      }
      await flow.click('BgOverlay.close()', { waitForDisappearMs: 10_000 });
    }

    if (ready.uiState.hasTreasuryAccess) {
      for (const section of [
        {
          ids: ready.chainState.bondLotIds,
          flexibleIds: ready.chainState.flexibleBondLotIds,
          rowKind: 'bond',
          screen: 'ArgonBondsScreen',
          tab: 'LeftBar.goto(TopTab.ArgonBonds)',
        },
        {
          ids: ready.chainState.stakeLotIds,
          flexibleIds: [] as number[],
          rowKind: 'stake',
          screen: 'ArgonotStakesScreen',
          tab: 'LeftBar.goto(TopTab.ArgonotStaking)',
        },
      ] as const) {
        await flow.click(section.tab, { timeoutMs: 10_000 });
        await flow.waitFor(section.screen, { timeoutMs: 10_000 });
        for (const bondLotId of section.ids) {
          try {
            await flow.click({ testId: `Bond.${section.rowKind}-${bondLotId}` }, { timeoutMs: 10_000 });
          } catch (error) {
            const [screenText, renderedRows, bondsState] = await Promise.all([
              flow.getText(section.screen, { timeoutMs: 2_000 }).catch(() => ''),
              flow.count({ selector: `[data-testid^="Bond.${section.rowKind}-"]` }),
              flow.queryApp(refs => ({
                isLoaded: refs.getArgonBonds().data.isLoaded,
                lots: refs.getArgonBonds().data.bondLots.map(lot => `${lot.programType}:${lot.id}`),
                renderedTestIds: [...document.querySelectorAll('.BondRecord')].map(row =>
                  row.getAttribute('data-testid'),
                ),
                screenText: document
                  .querySelector('[data-testid="ArgonBondsScreen"], [data-testid="ArgonotStakesScreen"]')
                  ?.textContent?.slice(0, 200),
              })),
            ]);
            let screenState = 'populated';
            if (screenText.includes('Unable to load')) screenState = 'error';
            else if (screenText.includes('Loading…')) screenState = 'loading';
            else if (screenText.includes('No ') && screenText.includes('Bonds')) screenState = 'empty';
            throw new Error(
              `${section.rowKind} lot ${bondLotId} has no clickable row (screen=${screenState}, renderedRows=${renderedRows}, bondsLoaded=${bondsState?.isLoaded}, loadedLots=${bondsState?.lots.join(',') ?? ''}, renderedTestIds=${bondsState?.renderedTestIds.join(',') ?? ''}, screenText=${bondsState?.screenText ?? ''}): ${String(error)}`,
            );
          }
          await flow.waitFor('BondDetailOverlay', { timeoutMs: 10_000 });
          const costBasisText = await flow.getText('Bond.details.costBasis');
          if (costBasisText.trim() === '—') {
            throw new Error(`${section.rowKind} lot ${bondLotId} rendered an unavailable principal basis`);
          }
          const isFlexible = section.flexibleIds.includes(bondLotId);
          if (isFlexible) {
            const displacementText = await flow.getText('Bond.details.flexibleDisplacement');
            const displacementPercent = Number.parseFloat(displacementText);
            if (
              !/^[\d,.]+% displaced$/.test(displacementText.trim()) ||
              displacementPercent < 0 ||
              displacementPercent > 100
            ) {
              throw new Error(
                `Flexible bond lot ${bondLotId} rendered invalid displacement: ${displacementText.trim()}`,
              );
            }
            if (!(await flow.isVisible('Bond.details.flexible')).visible) {
              throw new Error(`Flexible bond lot ${bondLotId} did not render its bond type`);
            }
          } else {
            const returnText = await flow.getText('Bond.details.return');
            if (!/^-?[\d,.]+%$/.test(returnText.trim())) {
              throw new Error(`${section.rowKind} lot ${bondLotId} rendered an invalid return: ${returnText.trim()}`);
            }
            const programType = section.rowKind === 'bond' ? 'Vault' : 'Argonot';
            const financialPosition = bondPositions.find(
              position => position.bondLot?.id === bondLotId && position.bondLot.programType === programType,
            );
            const expectedReturn = financialPosition ? calculatePositionReturn([financialPosition]).percent : undefined;
            const displayedReturn = Number(returnText.replaceAll(',', '').replaceAll('%', ''));
            if (expectedReturn === undefined || Math.abs(displayedReturn - expectedReturn) > 0.011) {
              throw new Error(
                `${section.rowKind} lot ${bondLotId} return ${returnText.trim()} does not match distributed income and cost basis (${expectedReturn}%)`,
              );
            }
          }
          if ((await flow.getText('BondDetailOverlay')).includes('NaN')) {
            throw new Error(`${section.rowKind} lot ${bondLotId} rendered NaN`);
          }
          await flow.click('BgOverlay.close()', { waitForDisappearMs: 10_000 });
        }
      }
    }

    if (ready.uiState.hasOperationsAccess && ready.uiState.vaultId !== undefined) {
      await flow.click('LeftBar.goto(TopTab.Vaulting)', { timeoutMs: 10_000 });
      await flow.waitFor('VaultingDashboard', { timeoutMs: 10_000 });

      for (const map of [
        {
          name: 'Bitcoin',
          selector: '[BitcoinMap] [data-treemap-kind="item"]',
          expectedCount: ready.uiState.expectedVaultBitcoinMapItemCount,
        },
        {
          name: 'bond',
          selector: '[BondMap] [data-treemap-kind="item"]',
          expectedCount: ready.uiState.expectedVaultBondMapItemCount,
        },
      ]) {
        if (map.expectedCount === undefined) continue;
        const visibleCount = await flow.count({ selector: map.selector });
        if (visibleCount < map.expectedCount) {
          throw new Error(
            `Vault ${map.name} treemap rendered ${visibleCount} position(s); expected at least ${map.expectedCount}`,
          );
        }
        for (let index = 0; index < visibleCount; index += 1) {
          const style = await flow.getAttribute({ selector: map.selector, index }, 'style');
          const width = Number(style?.match(/width:\s*([\d.]+)px/)?.[1] ?? 0);
          const height = Number(style?.match(/height:\s*([\d.]+)px/)?.[1] ?? 0);
          if (width <= 0 || height <= 0) {
            throw new Error(`Vault ${map.name} treemap position ${index + 1} has no visible area`);
          }
        }
      }
    }
    flow.setData('App.flow.accountReview.snapshot', financialSnapshot);
    flow.setData('App.flow.accountReview.uiValidated', true);
  },
});
