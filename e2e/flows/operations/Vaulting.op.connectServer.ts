import { clickIfVisible } from '../helpers/utils.ts';
import { Operation } from './index.ts';
import type { IVaultingFlowContext } from '../contexts/vaultingContext.ts';
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
}

const DEFAULT_CONNECT_READY_TIMEOUT_MS = 120_000;

export default new Operation<IVaultingFlowContext, IConnectServerState>(import.meta, {
  async inspect({ flow }) {
    const [connectEntry, connectOverlay, dashboard] = await Promise.all([
      flow.isVisible('SetupChecklist.openServerConnectPanel()'),
      flow.isVisible({ selector: '.ConnectOverlay' }),
      flow.isVisible('VaultingDashboard'),
    ]);
    const connectText = await flow
      .getText('SetupChecklist.openServerConnectPanel()', { timeoutMs: 2_000 })
      .catch(() => null);
    const serverConnected = /used to run your mining software|api key is ready to go|connected and verified/i.test(
      connectText ?? '',
    );
    const isComplete = serverConnected || dashboard.visible;
    const canRun = connectOverlay.visible || (connectEntry.visible && !serverConnected && !dashboard.visible);
    let operationState: 'complete' | 'runnable' | 'processing' = 'processing';
    if (isComplete) {
      operationState = 'complete';
    } else if (canRun) {
      operationState = 'runnable';
    }

    const blockers: string[] = [];
    if (!isComplete && !connectOverlay.visible && !connectEntry.visible) {
      blockers.push('Vaulting server connect step is not visible.');
    }
    return {
      chainState: {},
      uiState: {
        connectEntryVisible: connectEntry.visible,
        connectOverlayVisible: connectOverlay.visible,
        serverConnected,
        dashboardVisible: dashboard.visible,
      },
      state: operationState,
      connectEntryVisible: connectEntry.visible,
      connectOverlayVisible: connectOverlay.visible,
      serverConnected,
      dashboardVisible: dashboard.visible,
      blockers: canRun ? [] : blockers,
    };
  },
  async run({ flow, flowName, input, state: flowState }, state) {
    const connectReadyTimeoutMs = getConnectReadyTimeoutMs();

    if (!state.connectOverlayVisible && (state.serverConnected || state.dashboardVisible)) {
      return;
    }

    await flow.click('SetupChecklist.openServerConnectPanel()', { timeoutMs: 20_000 });
    await flow.click(`ServerConnectPanel.selectedTab='${input.serverTab}'`);
    flowState.connectedServerTab = input.serverTab;

    if (input.serverTab === 'local') {
      await flow.waitFor('ServerConnectOverlay.local.warning', { timeoutMs: 15_000 });
      const warningText = await flow
        .getText('ServerConnectOverlay.local.warning', { timeoutMs: 1_000 })
        .catch(() => null);
      if (warningText?.toUpperCase().includes('INELIGIBLE')) {
        throw new Error(`${flowName}: local server not eligible: ${warningText.replace(/\s+/g, ' ').trim()}`);
      }
    }

    await flow
      .waitFor('ServerConnectPanel.connect()', { state: 'enabled', timeoutMs: connectReadyTimeoutMs })
      .catch(async error => {
        const connectState = await flow.isVisible('ServerConnectPanel.connect()');
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
          `connectReadyTimeoutMs=${connectReadyTimeoutMs}`,
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

    await flow.click('ServerConnectPanel.connect()', { timeoutMs: 8_000 });
    await flow.waitFor({ selector: '.ConnectOverlay' }, { state: 'missing', timeoutMs: 30_000 });
    await clickIfVisible(flow, 'ServerOverlay.closeOverlay()', { timeoutMs: 5_000 });
  },
});

function getConnectReadyTimeoutMs(): number {
  const raw = process.env.E2E_SERVER_CONNECT_READY_TIMEOUT_MS;
  if (!raw) return DEFAULT_CONNECT_READY_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_CONNECT_READY_TIMEOUT_MS;
  return Math.round(parsed);
}
