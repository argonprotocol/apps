import type { IE2EFlowRuntime } from '../types.ts';

const INSPECT_STATE_ERROR_MAX_LENGTH = 20_000;
const APP_DIAGNOSTICS_MAX_LENGTH = 40_000;

export function withStateContext(error: unknown, operationName: string, state: unknown): Error {
  const message = [
    `[E2E] operation '${operationName}' failed.`,
    `inspect=${truncateForError(safeStringify(state))}`,
    `error=${error instanceof Error ? error.message : String(error)}`,
  ].join(' ');

  if (error instanceof Error) {
    error.message = message;
    return error;
  }

  return new Error(message);
}

export async function logDefaultAppFailureDiagnostics(
  context: unknown,
  operationName: string,
  state: unknown,
  error: unknown,
): Promise<void> {
  const flowContext = getFlowContext(context);
  if (!flowContext) {
    return;
  }

  const { flow, flowName = operationName } = flowContext;
  const [
    miningTabContent,
    vaultingTabContent,
    miningDashboard,
    vaultingDashboard,
    miningChecklist,
    vaultingChecklist,
    welcomeOverlay,
    walletFundingOverlay,
    lockOverlay,
    unlockOverlay,
    serverConnectOverlay,
    openDialogsCount,
    openDialog,
    openDialogTestId,
    openDialogClass,
    openDialogText,
    personalHiddenCount,
    personalInertCount,
  ] = await Promise.all([
    flow.isVisible('MiningScreen').catch(() => ({ visible: false, exists: false, enabled: false })),
    flow.isVisible('VaultingScreen').catch(() => ({ visible: false, exists: false, enabled: false })),
    flow.isVisible('MiningDashboard').catch(() => ({ visible: false, exists: false, enabled: false })),
    flow.isVisible('VaultingDashboard').catch(() => ({ visible: false, exists: false, enabled: false })),
    flow
      .isVisible('FinalSetupChecklist.openHowMiningWorksOverlay()')
      .catch(() => ({ visible: false, exists: false, enabled: false })),
    flow
      .isVisible('FinalSetupChecklist.openHowVaultingWorksOverlay()')
      .catch(() => ({ visible: false, exists: false, enabled: false })),
    flow.isVisible('WelcomeOverlay.closeOverlay()').catch(() => ({ visible: false, exists: false, enabled: false })),
    flow
      .isVisible('WalletFundingReceivedOverlay.closeOverlay()')
      .catch(() => ({ visible: false, exists: false, enabled: false })),
    flow.isVisible('BitcoinLockingOverlay').catch(() => ({ visible: false, exists: false, enabled: false })),
    flow.isVisible('BitcoinUnlockingOverlay').catch(() => ({ visible: false, exists: false, enabled: false })),
    flow
      .isVisible('ServerConnectOverlay.connectServer()')
      .catch(() => ({ visible: false, exists: false, enabled: false })),
    flow.count({ selector: '[role="dialog"][data-state="open"]' }).catch(() => -1),
    flow.isVisible({ selector: '[role="dialog"][data-state="open"]' }).catch(() => ({ visible: false, exists: false })),
    flow
      .getAttribute({ selector: '[role="dialog"][data-state="open"]' }, 'data-testid', { timeoutMs: 1_000 })
      .catch(() => null),
    flow
      .getAttribute({ selector: '[role="dialog"][data-state="open"]' }, 'class', { timeoutMs: 1_000 })
      .catch(() => null),
    flow
      .getText({ selector: '[role="dialog"][data-state="open"]' }, { timeoutMs: 1_000 })
      .then(text => text.slice(0, 240))
      .catch(() => null),
    flow.count({ selector: '[aria-hidden="true"] [data-testid="PersonalBitcoin"]' }).catch(() => -1),
    flow.count({ selector: '[inert] [data-testid="PersonalBitcoin"]' }).catch(() => -1),
  ]);

  const appState = {
    inferredScreen:
      miningTabContent.visible || miningDashboard.visible || miningChecklist.visible
        ? 'Mining'
        : vaultingTabContent.visible || vaultingDashboard.visible || vaultingChecklist.visible
          ? 'Vaulting'
          : 'HomeOrOther',
    miningTabContentVisible: miningTabContent.visible,
    vaultingTabContentVisible: vaultingTabContent.visible,
    miningDashboardVisible: miningDashboard.visible,
    vaultingDashboardVisible: vaultingDashboard.visible,
    miningChecklistVisible: miningChecklist.visible,
    vaultingChecklistVisible: vaultingChecklist.visible,
    welcomeOverlayVisible: welcomeOverlay.visible,
    walletFundingOverlayVisible: walletFundingOverlay.visible,
    lockOverlayVisible: lockOverlay.visible,
    unlockOverlayVisible: unlockOverlay.visible,
    serverConnectOverlayVisible: serverConnectOverlay.visible,
    openDialogsCount,
    openDialogVisible: openDialog.visible,
    openDialogTestId,
    openDialogClass,
    openDialogText,
    personalHiddenCount,
    personalInertCount,
  };

  const payload = {
    flowName,
    operationName,
    error: error instanceof Error ? error.message : String(error),
    inspect: state,
    appState,
  };

  const raw = safeStringify(payload);
  console.error(`[E2E] ${flowName}: default diagnostics ${truncateDiagnostics(raw)}`);
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch (_error) {
    return String(value);
  }
}

function truncateForError(raw: string): string {
  if (raw.length <= INSPECT_STATE_ERROR_MAX_LENGTH) {
    return raw;
  }
  const remaining = raw.length - INSPECT_STATE_ERROR_MAX_LENGTH;
  return `${raw.slice(0, INSPECT_STATE_ERROR_MAX_LENGTH)}...(+${remaining} chars)`;
}

function truncateDiagnostics(raw: string): string {
  if (raw.length <= APP_DIAGNOSTICS_MAX_LENGTH) {
    return raw;
  }
  const remaining = raw.length - APP_DIAGNOSTICS_MAX_LENGTH;
  return `${raw.slice(0, APP_DIAGNOSTICS_MAX_LENGTH)}...(+${remaining} chars)`;
}

function getFlowContext(context: unknown): { flow: IE2EFlowRuntime; flowName?: string } | null {
  if (!context || typeof context !== 'object') {
    return null;
  }

  const candidate = context as { flow?: unknown; flowName?: unknown };
  if (!candidate.flow || typeof candidate.flow !== 'object') {
    return null;
  }
  if (typeof (candidate.flow as { isVisible?: unknown }).isVisible !== 'function') {
    return null;
  }
  return {
    flow: candidate.flow as IE2EFlowRuntime,
    flowName: typeof candidate.flowName === 'string' ? candidate.flowName : undefined,
  };
}
