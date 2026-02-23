import { Operation } from './index.ts';
import type { IMiningFlowContext } from '../contexts/miningContext.ts';
import type { IE2EOperationInspectState } from '../types.ts';

type IConnectServerUiState = {
  connectEntryVisible: boolean;
  connectOverlayVisible: boolean;
  serverConnected: boolean;
  dashboardVisible: boolean;
};

interface IConnectServerState extends IE2EOperationInspectState<Record<string, never>, IConnectServerUiState> {
  connectEntryVisible: boolean;
  connectOverlayVisible: boolean;
  serverConnected: boolean;
  dashboardVisible: boolean;
  runnable: boolean;
  blockers: string[];
}

export default new Operation<IMiningFlowContext, IConnectServerState>(import.meta, {
  async inspect({ flow }) {
    const [connectEntry, connectOverlay, dashboard] = await Promise.all([
      flow.isVisible('FinalSetupChecklist.openServerConnectOverlay()'),
      flow.isVisible({ selector: '.ConnectOverlay' }),
      flow.isVisible('MiningDashboard'),
    ]);
    const connectText = await flow
      .getText('FinalSetupChecklist.openServerConnectOverlay()', { timeoutMs: 2_000 })
      .catch(() => null);
    const serverConnected = /used to run your mining software|api key is ready to go|connected and verified/i.test(
      connectText ?? '',
    );
    const runnable = connectOverlay.visible || (connectEntry.visible && !serverConnected && !dashboard.visible);
    const isComplete = serverConnected || dashboard.visible;
    const isRunnable = !isComplete && runnable;
    const blockers: string[] = [];
    if (isComplete) blockers.push('ALREADY_COMPLETE');
    if (!isComplete && !connectOverlay.visible && !connectEntry.visible) {
      blockers.push('Mining server connect step is not visible.');
    }
    return {
      chainState: {},
      uiState: {
        connectEntryVisible: connectEntry.visible,
        connectOverlayVisible: connectOverlay.visible,
        serverConnected,
        dashboardVisible: dashboard.visible,
      },
      isRunnable,
      isComplete,
      connectEntryVisible: connectEntry.visible,
      connectOverlayVisible: connectOverlay.visible,
      serverConnected,
      dashboardVisible: dashboard.visible,
      runnable,
      blockers: isRunnable ? [] : blockers,
    };
  },
  async run({ flow, flowName, input, state: flowState }, state) {
    if (!state.connectOverlayVisible && (state.serverConnected || state.dashboardVisible)) {
      return;
    }

    await flow.click('FinalSetupChecklist.openServerConnectOverlay()', { timeoutMs: 20_000 });
    await flow.click(`ServerConnectOverlay.selectedTab='${input.serverTab}'`);
    flowState.connectedServerTab = input.serverTab;

    if (input.serverTab === 'local') {
      const warningText = await flow
        .getText('ServerConnectOverlay.local.warning', { timeoutMs: 1_000 })
        .catch(() => null);
      if (warningText?.toUpperCase().includes('INELIGIBLE')) {
        throw new Error(`${flowName}: local server not eligible: ${warningText.replace(/\s+/g, ' ').trim()}`);
      }
    }

    await flow.waitFor('ServerConnectOverlay.connect()', { state: 'enabled', timeoutMs: 20_000 }).catch(async error => {
      const connectState = await flow.isVisible('ServerConnectOverlay.connect()');
      const warningText = await flow
        .getText('ServerConnectOverlay.local.warning', { timeoutMs: 1_000 })
        .catch(() => null);
      const blockedPorts = await flow
        .getText('ServerConnectOverlay.local.blockedPorts', { timeoutMs: 1_000 })
        .catch(() => null);
      const diskStatus = await flow
        .getText('ServerConnectOverlay.local.diskStatus', { timeoutMs: 1_000 })
        .catch(() => null);
      const diskSummary = await flow
        .getText('ServerConnectOverlay.local.diskSummary', { timeoutMs: 1_000 })
        .catch(() => null);
      const dockerStatus = await flow
        .getText('ServerConnectOverlay.local.dockerStatus', { timeoutMs: 1_000 })
        .catch(() => null);
      const dockerSummary = await flow
        .getText('ServerConnectOverlay.local.dockerSummary', { timeoutMs: 1_000 })
        .catch(() => null);

      const details = [
        `connectButton(visible=${connectState.visible}, enabled=${connectState.enabled}, exists=${connectState.exists})`,
        warningText ? `warning="${warningText.replace(/\s+/g, ' ').trim()}"` : null,
        blockedPorts ? `blockedPorts="${blockedPorts.replace(/\s+/g, ' ').trim()}"` : null,
        diskStatus ? `diskStatus="${diskStatus.replace(/\s+/g, ' ').trim()}"` : null,
        diskSummary ? `diskSummary="${diskSummary.replace(/\s+/g, ' ').trim()}"` : null,
        dockerStatus ? `dockerStatus="${dockerStatus.replace(/\s+/g, ' ').trim()}"` : null,
        dockerSummary ? `dockerSummary="${dockerSummary.replace(/\s+/g, ' ').trim()}"` : null,
      ]
        .filter(Boolean)
        .join(', ');

      throw new Error(
        `${flowName}: server connect button did not become enabled. ${details}. Root error: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });

    await flow.click('ServerConnectOverlay.connect()', { timeoutMs: 8_000 });
    await flow.waitFor({ selector: '.ConnectOverlay' }, { state: 'missing', timeoutMs: 30_000 });
  },
});
