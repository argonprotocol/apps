import assert from 'node:assert/strict';
import { parseRequiredNumber, pollEvery } from '../helpers/utils.ts';
import type { IE2EFlowRuntime, IE2EOperationInspectState } from '../types.ts';
import { Operation } from './index.ts';
import type { IMiningFlowContext } from '../contexts/miningContext.ts';

type IFinalizeSetupUiState = {
  dashboardVisible: boolean;
  launchBotVisible: boolean;
  launchBotEnabled: boolean;
  totalBlocksMined: number | null;
};

interface IFinalizeSetupState extends IE2EOperationInspectState<Record<string, never>, IFinalizeSetupUiState> {
  dashboardVisible: boolean;
  launchBotVisible: boolean;
  launchBotEnabled: boolean;
  totalBlocksMined: number | null;
  runnable: boolean;
  blockers: string[];
}

const INSTALL_PROGRESS_POLL_MS = 1_000;
const INSTALL_PROGRESS_TIMEOUT_MS = 10 * 60_000;
const INSTALL_PROGRESS_STALL_TIMEOUT_MS = 90_000;

export default new Operation<IMiningFlowContext, IFinalizeSetupState>(import.meta, {
  async inspect({ flow, flowName }) {
    const [dashboard, launchBot] = await Promise.all([
      flow.isVisible('MiningDashboard'),
      flow.isVisible('FinalSetupChecklist.launchMiningBot()'),
    ]);
    if (!dashboard.visible) {
      const runnable = launchBot.visible && launchBot.enabled;
      const blockers: string[] = [];
      if (!launchBot.visible) {
        blockers.push('Launch Mining Bot button is not visible.');
      } else if (!launchBot.enabled) {
        blockers.push('Launch Mining Bot button is disabled.');
      }
      return {
        chainState: {},
        uiState: {
          dashboardVisible: false,
          launchBotVisible: launchBot.visible,
          launchBotEnabled: launchBot.enabled,
          totalBlocksMined: null,
        },
        isRunnable: runnable,
        isComplete: false,
        dashboardVisible: false,
        launchBotVisible: launchBot.visible,
        launchBotEnabled: launchBot.enabled,
        totalBlocksMined: null,
        runnable,
        blockers: runnable ? [] : blockers,
      };
    }

    const totalBlocksMinedRaw = await flow.getAttribute('TotalBlocksMined', 'data-value', { timeoutMs: 5_000 });
    const totalBlocksMined = parseRequiredNumber(totalBlocksMinedRaw, `${flowName}.TotalBlocksMined`);
    const runnable = totalBlocksMined <= 0;
    const isComplete = totalBlocksMined > 0;
    const isRunnable = !isComplete && runnable;
    return {
      chainState: {},
      uiState: {
        dashboardVisible: true,
        launchBotVisible: launchBot.visible,
        launchBotEnabled: launchBot.enabled,
        totalBlocksMined,
      },
      isRunnable,
      isComplete,
      dashboardVisible: true,
      launchBotVisible: launchBot.visible,
      launchBotEnabled: launchBot.enabled,
      totalBlocksMined,
      runnable,
      blockers: isRunnable ? [] : ['ALREADY_COMPLETE'],
    };
  },
  async run({ flow, flowName }, state) {
    if (state.dashboardVisible && state.totalBlocksMined != null && state.totalBlocksMined > 0) {
      return;
    }
    if (!state.launchBotVisible || !state.launchBotEnabled) {
      throw new Error(
        `${flowName}: launch mining bot is not ready (visible=${state.launchBotVisible}, enabled=${state.launchBotEnabled}).`,
      );
    }

    await flow.click('FinalSetupChecklist.launchMiningBot()', { timeoutMs: 120_000 });

    const didFinishInstall = async (): Promise<boolean> => {
      const dashboardState = await flow.isVisible('MiningDashboard');
      return dashboardState.visible;
    };

    const installProgressState = await flow.isVisible({ selector: '.InstallProgress' });
    if (!installProgressState.visible && !(await didFinishInstall())) {
      await flow.waitFor({ selector: '.InstallProgress' }, { timeoutMs: 120_000 });
    }

    const stallTimeoutMs = getInstallProgressStallTimeoutMs();
    let lastProgressSignature = '';
    let lastProgressChangeAt = Date.now();
    await pollEvery(
      INSTALL_PROGRESS_POLL_MS,
      async () => {
        if (await didFinishInstall()) return true;

        const installProgressVisible = await flow.isVisible({ selector: '.InstallProgress' });
        const stepCount = await flow.count({ selector: '.InstallProgressStep' });
        if (stepCount === 0) {
          const firstAuctionState = await flow.isVisible('FirstAuction');
          const signature = `stepCount=0|installProgressVisible=${installProgressVisible.visible}|firstAuction=${firstAuctionState.visible}`;
          updateProgressHeartbeat(signature, {
            flowName,
            stallTimeoutMs,
            getLastProgressSignature: () => lastProgressSignature,
            setLastProgressSignature: value => {
              lastProgressSignature = value;
            },
            getLastProgressChangeAt: () => lastProgressChangeAt,
            setLastProgressChangeAt: value => {
              lastProgressChangeAt = value;
            },
          });
          return firstAuctionState.visible || (await didFinishInstall());
        }
        const failedStepNames = await getFailedInstallStepNames(flow, stepCount);
        assert.equal(
          failedStepNames.length,
          0,
          `InstallProgress contains failed steps: ${failedStepNames.join(', ') || 'unknown'}`,
        );

        let hasPendingStep = false;
        const stepProgressTokens: string[] = [];
        for (let index = 0; index < stepCount; index += 1) {
          const status = await getAttributeOrNull(
            flow,
            { selector: '.InstallProgressStep', index },
            'data-status',
            2_000,
          );
          if (status == null) {
            if (await didFinishInstall()) return true;
            hasPendingStep = true;
            stepProgressTokens.push(`${index}:missing`);
            continue;
          }
          if (status !== 'Completed') hasPendingStep = true;
          if (!['Working', 'Completing', 'Completed', 'Failed'].includes(status)) {
            stepProgressTokens.push(`${index}:${status}:na`);
            continue;
          }

          const progress = await getAttributeOrNull(
            flow,
            { selector: '.InstallProgressStep .ProgressBar > div', index },
            'data-progress',
            500,
          );
          if (progress == null) {
            if (await didFinishInstall()) return true;
            stepProgressTokens.push(`${index}:${status}:na`);
            continue;
          }

          const progressValue = parseRequiredNumber(progress, `InstallProgressStep[${index}] progress`);
          stepProgressTokens.push(`${index}:${status}:${Math.round(progressValue * 100) / 100}`);
        }

        const signature = `stepCount=${stepCount}|${stepProgressTokens.join('|')}`;
        updateProgressHeartbeat(signature, {
          flowName,
          stallTimeoutMs,
          getLastProgressSignature: () => lastProgressSignature,
          setLastProgressSignature: value => {
            lastProgressSignature = value;
          },
          getLastProgressChangeAt: () => lastProgressChangeAt,
          setLastProgressChangeAt: value => {
            lastProgressChangeAt = value;
          },
        });

        return !hasPendingStep;
      },
      {
        timeoutMs: INSTALL_PROGRESS_TIMEOUT_MS,
        timeoutMessage: `${flowName}: install progress did not complete within ${
          INSTALL_PROGRESS_TIMEOUT_MS / 60_000
        } minutes`,
      },
    );

    try {
      await flow.waitFor('MiningDashboard', { timeoutMs: 60_000 });
    } catch (error) {
      const dashboardState = await flow.isVisible('MiningDashboard');
      const firstAuctionState = await flow.isVisible('FirstAuction');
      const installProgress = await flow.isVisible({ selector: '.InstallProgress' });
      const stepCount = installProgress.visible ? await flow.count({ selector: '.InstallProgressStep' }) : 0;
      const failedStepNames = stepCount > 0 ? await getFailedInstallStepNames(flow, stepCount) : [];
      throw new Error(
        `${flowName}: dashboard did not appear after launch within timeout. dashboard=${dashboardState.visible} firstAuction=${
          firstAuctionState.visible
        } installProgressVisible=${installProgress.visible} steps=${stepCount} failedSteps=${
          failedStepNames.length ? failedStepNames.join('; ') : 'none'
        }. Root error: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    await pollEvery(
      2_000,
      async () => {
        const totalBlocksMined = await tryGetTotalBlocksMined(flow, flowName);
        return totalBlocksMined != null && totalBlocksMined > 0;
      },
      {
        timeoutMs: 120_000,
        timeoutMessage: `${flowName}: expected TotalBlocksMined to become greater than 0.`,
      },
    );
  },
});

function getInstallProgressStallTimeoutMs(): number {
  const raw = process.env.E2E_INSTALL_STALL_TIMEOUT_MS;
  if (!raw) return INSTALL_PROGRESS_STALL_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return INSTALL_PROGRESS_STALL_TIMEOUT_MS;
  return parsed;
}

function updateProgressHeartbeat(
  signature: string,
  args: {
    flowName: string;
    stallTimeoutMs: number;
    getLastProgressSignature: () => string;
    setLastProgressSignature: (value: string) => void;
    getLastProgressChangeAt: () => number;
    setLastProgressChangeAt: (value: number) => void;
  },
): void {
  if (signature !== args.getLastProgressSignature()) {
    args.setLastProgressSignature(signature);
    args.setLastProgressChangeAt(Date.now());
    return;
  }

  const stagnantForMs = Date.now() - args.getLastProgressChangeAt();
  if (stagnantForMs < args.stallTimeoutMs) return;

  throw new Error(
    `${args.flowName}: install progress stalled for ${Math.ceil(stagnantForMs / 1000)}s (threshold ${Math.ceil(
      args.stallTimeoutMs / 1000,
    )}s). lastProgress=${signature}`,
  );
}

async function getFailedInstallStepNames(flow: IE2EFlowRuntime, stepCount: number): Promise<string[]> {
  const failedSteps: string[] = [];
  for (let index = 0; index < stepCount; index += 1) {
    const status = await getAttributeOrNull(flow, { selector: '.InstallProgressStep', index }, 'data-status', 500);
    if (status !== 'Failed') continue;

    const failedLabel = await flow
      .getText({ selector: '.InstallProgressStep', index }, { timeoutMs: 1_000 })
      .catch(() => null);
    const normalized = (failedLabel ?? '').replace(/\s+/g, ' ').trim() || `index-${index}`;
    const parsed = normalized.match(/FAILED to (.+?)(?:\s+Retry|$)/i);
    failedSteps.push(parsed?.[1]?.trim() ? `${index}: ${parsed[1].trim()}` : `${index}: ${normalized}`);
  }
  return failedSteps;
}

async function tryGetTotalBlocksMined(flow: IE2EFlowRuntime, flowName: string): Promise<number | null> {
  const value = await getAttributeOrNull(flow, 'TotalBlocksMined', 'data-value', 2_000);
  if (value == null || value.trim().length === 0) return null;
  try {
    return parseRequiredNumber(value, `${flowName}.TotalBlocksMined`);
  } catch {
    return null;
  }
}

async function getAttributeOrNull(
  flow: IE2EFlowRuntime,
  target: Parameters<IE2EFlowRuntime['getAttribute']>[0],
  attribute: string,
  timeoutMs = 500,
): Promise<string | null> {
  try {
    return await flow.getAttribute(target, attribute, { timeoutMs });
  } catch (_error) {
    return null;
  }
}
