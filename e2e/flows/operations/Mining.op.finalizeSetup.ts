import assert from 'node:assert/strict';
import { clickIfVisible, parseRequiredNumber, pollEvery } from '../helpers/utils.ts';
import type { IE2EFlowRuntime, IE2EOperationInspectState } from '../types.ts';
import { Operation } from './index.ts';
import type { IMiningFlowContext } from '../contexts/miningContext.ts';

type IFinalizeSetupUiState = {
  dashboardVisible: boolean;
  firstAuctionVisible: boolean;
  startingBotVisible: boolean;
  launchBotVisible: boolean;
  launchBotEnabled: boolean;
  launchBotClickable: boolean;
  installProgressVisible: boolean;
  setupInstallingVisible: boolean;
  totalBlocksMined: number | null;
};

interface IFinalizeSetupState extends IE2EOperationInspectState<Record<string, never>, IFinalizeSetupUiState> {
  dashboardVisible: boolean;
  firstAuctionVisible: boolean;
  startingBotVisible: boolean;
  launchBotVisible: boolean;
  launchBotEnabled: boolean;
  launchBotClickable: boolean;
  installProgressVisible: boolean;
  setupInstallingVisible: boolean;
  installingVisible: boolean;
  totalBlocksMined: number | null;
}

const INSTALL_PROGRESS_POLL_MS = 1_000;
const INSTALL_PROGRESS_TIMEOUT_MS = 10 * 60_000;
const INSTALL_PROGRESS_STALL_TIMEOUT_MS = 90_000;
const SERVER_INSTALL_READY_TIMEOUT_MS = 15 * 60_000;
const MINING_INSTALL_STABLE_SUCCESS_MS = 90_000;

export default new Operation<IMiningFlowContext, IFinalizeSetupState>(import.meta, {
  async inspect({ flow, flowName }) {
    const [dashboard, firstAuction, startingBot, launchBot, installProgress, setupInstalling] = await Promise.all([
      flow.isVisible('MiningDashboard'),
      flow.isVisible('FirstAuction'),
      flow.isVisible('MiningStartingBot'),
      flow.isVisible('SetupChecklist.launchMiningBot()'),
      flow.isVisible({ selector: '.InstallProgress' }),
      flow.isVisible('MiningIsInstalling'),
    ]);
    const installingVisible = installProgress.visible || setupInstalling.visible;

    if (!dashboard.visible) {
      const hasPostLaunchState = setupInstalling.visible || startingBot.visible;
      let operationState: 'complete' | 'runnable' | 'processing' = 'processing';
      if (firstAuction.visible || hasPostLaunchState) {
        operationState = 'complete';
      } else if (launchBot.clickable) {
        operationState = 'runnable';
      }

      const blockers: string[] = [];
      if (!launchBot.visible && !installingVisible && !startingBot.visible) {
        blockers.push('Launch Mining Bot button is not visible.');
      } else if (!launchBot.enabled && !installingVisible && !startingBot.visible) {
        blockers.push('Launch Mining Bot button is disabled.');
      }
      return {
        chainState: {},
        uiState: {
          dashboardVisible: false,
          firstAuctionVisible: firstAuction.visible,
          startingBotVisible: startingBot.visible,
          launchBotVisible: launchBot.visible,
          launchBotEnabled: launchBot.enabled,
          launchBotClickable: launchBot.clickable,
          installProgressVisible: installProgress.visible,
          setupInstallingVisible: setupInstalling.visible,
          totalBlocksMined: null,
        },
        state: operationState,
        dashboardVisible: false,
        firstAuctionVisible: firstAuction.visible,
        startingBotVisible: startingBot.visible,
        launchBotVisible: launchBot.visible,
        launchBotEnabled: launchBot.enabled,
        launchBotClickable: launchBot.clickable,
        installProgressVisible: installProgress.visible,
        setupInstallingVisible: setupInstalling.visible,
        installingVisible,
        totalBlocksMined: null,
        blockers: operationState === 'runnable' ? [] : blockers,
      };
    }

    const totalBlocksMined = await tryGetTotalBlocksMined(flow, flowName);

    return {
      chainState: {},
      uiState: {
        dashboardVisible: true,
        firstAuctionVisible: firstAuction.visible,
        startingBotVisible: startingBot.visible,
        launchBotVisible: launchBot.visible,
        launchBotEnabled: launchBot.enabled,
        launchBotClickable: launchBot.clickable,
        installProgressVisible: installProgress.visible,
        setupInstallingVisible: setupInstalling.visible,
        totalBlocksMined,
      },
      state: 'complete',
      dashboardVisible: true,
      firstAuctionVisible: firstAuction.visible,
      startingBotVisible: startingBot.visible,
      launchBotVisible: launchBot.visible,
      launchBotEnabled: launchBot.enabled,
      launchBotClickable: launchBot.clickable,
      installProgressVisible: installProgress.visible,
      setupInstallingVisible: setupInstalling.visible,
      installingVisible,
      totalBlocksMined,
      blockers: ['ALREADY_COMPLETE'],
    };
  },
  async run({ flow, flowName }, state) {
    console.info(
      `[E2E] ${flowName}: finalizeSetup start dashboard=${state.dashboardVisible} firstAuction=${state.firstAuctionVisible} startingBot=${state.startingBotVisible} launchVisible=${state.launchBotVisible} launchEnabled=${state.launchBotEnabled} installing=${state.installingVisible}`,
    );

    if (state.dashboardVisible && state.totalBlocksMined != null && state.totalBlocksMined > 0) {
      return;
    }

    if (state.dashboardVisible) {
      console.info(`[E2E] ${flowName}: finalizeSetup waiting for TotalBlocksMined > 0`);
      await waitForTotalBlocksMined(flow, flowName);
      return;
    }

    if (state.startingBotVisible) {
      console.info(`[E2E] ${flowName}: finalizeSetup detected MiningStartingBot; waiting for ready state`);
      await waitForPostLaunchReadyState(flow, flowName);
      return;
    }

    if (!state.launchBotClickable) {
      if (!state.installingVisible) {
        throw new Error(
          `${flowName}: launch mining bot is not ready (visible=${state.launchBotVisible}, enabled=${state.launchBotEnabled}, clickable=${state.launchBotClickable}).`,
        );
      }
      console.info(`[E2E] ${flowName}: finalizeSetup waiting for launch button to become ready`);
      await waitForServerInstallToReachLaunchableState(flow, flowName);
    }

    const [dashboardBeforeLaunch, firstAuctionBeforeLaunch, startingBotBeforeLaunch, launchBotBeforeLaunch] =
      await Promise.all([
        flow.isVisible('MiningDashboard'),
        flow.isVisible('FirstAuction'),
        flow.isVisible('MiningStartingBot'),
        flow.isVisible('SetupChecklist.launchMiningBot()'),
      ]);
    if (dashboardBeforeLaunch.visible || firstAuctionBeforeLaunch.visible) {
      return;
    }
    if (startingBotBeforeLaunch.visible) {
      console.info(`[E2E] ${flowName}: finalizeSetup entered StartingBot before click; waiting for ready state`);
      await waitForPostLaunchReadyState(flow, flowName);
      return;
    }

    if (!launchBotBeforeLaunch.clickable) {
      throw new Error(
        `${flowName}: launch mining bot is not ready after server install wait (visible=${launchBotBeforeLaunch.visible}, enabled=${launchBotBeforeLaunch.enabled}, clickable=${launchBotBeforeLaunch.clickable}).`,
      );
    }

    const didFinishInstall = async (): Promise<boolean> => {
      const [dashboardState, firstAuctionState] = await Promise.all([
        flow.isVisible('MiningDashboard'),
        flow.isVisible('FirstAuction'),
      ]);
      return dashboardState.visible || firstAuctionState.visible;
    };

    await pollEvery(
      1_000,
      async () => {
        if (await didFinishInstall()) return true;

        const [startingBotVisible, miningInstallingVisible, launchBot] = await Promise.all([
          flow.isVisible('MiningStartingBot'),
          flow.isVisible('MiningIsInstalling'),
          flow.isVisible('SetupChecklist.launchMiningBot()'),
        ]);
        if (startingBotVisible.visible || miningInstallingVisible.visible) {
          return true;
        }
        if (!launchBot.clickable) {
          return false;
        }

        console.info(`[E2E] ${flowName}: finalizeSetup clicking launch mining bot`);
        return await clickIfVisible(flow, 'SetupChecklist.launchMiningBot()', { timeoutMs: 1_500 });
      },
      {
        timeoutMs: 120_000,
        timeoutMessage: `${flowName}: launch mining bot did not become clickable.`,
      },
    );
    await waitForInstallUiToAppearOrComplete(flow, didFinishInstall, flowName);
    console.info(`[E2E] ${flowName}: finalizeSetup observed install UI; monitoring completion`);

    const stallTimeoutMs = getInstallProgressStallTimeoutMs();
    let lastProgressSignature = '';
    let lastProgressChangeAt = Date.now();
    let lastProgressLogAt = 0;
    let miningInstallingVisibleSince = 0;
    await pollEvery(
      INSTALL_PROGRESS_POLL_MS,
      async () => {
        if (await didFinishInstall()) return true;

        const [installProgressVisible, miningInstallingVisible, startingBotVisible] = await Promise.all([
          flow.isVisible({ selector: '.InstallProgress' }),
          flow.isVisible('MiningIsInstalling'),
          flow.isVisible('MiningStartingBot'),
        ]);
        const stepCount = await flow.count({ selector: '.InstallProgressStep' });
        const now = Date.now();
        if (now - lastProgressLogAt >= 15_000) {
          console.info(
            `[E2E] ${flowName}: finalizeSetup poll installProgress=${installProgressVisible.visible} miningInstalling=${miningInstallingVisible.visible} startingBot=${startingBotVisible.visible} stepCount=${stepCount}`,
          );
          lastProgressLogAt = now;
        }
        if (stepCount === 0) {
          // Mining setup can render dedicated screens without overlay-style InstallProgress steps.
          if (!installProgressVisible.visible && startingBotVisible.visible) {
            console.info(`[E2E] ${flowName}: finalizeSetup reached MiningStartingBot; considering launch successful`);
            return true;
          }
          if (!installProgressVisible.visible && miningInstallingVisible.visible) {
            if (miningInstallingVisibleSince === 0) {
              miningInstallingVisibleSince = Date.now();
            }
            const installingForMs = Date.now() - miningInstallingVisibleSince;
            if (installingForMs >= MINING_INSTALL_STABLE_SUCCESS_MS) {
              console.info(
                `[E2E] ${flowName}: finalizeSetup remained in MiningIsInstalling for ${Math.round(
                  installingForMs / 1000,
                )}s; treating launch as successful and leaving install to continue in background`,
              );
              return true;
            }
            return await didFinishInstall();
          }
          miningInstallingVisibleSince = 0;
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

    const [dashboardAfterLaunch, firstAuctionAfterLaunch, startingBotAfterLaunch, miningInstallingAfterLaunch] =
      await Promise.all([
        flow.isVisible('MiningDashboard'),
        flow.isVisible('FirstAuction'),
        flow.isVisible('MiningStartingBot'),
        flow.isVisible('MiningIsInstalling'),
      ]);
    if (!dashboardAfterLaunch.visible && !firstAuctionAfterLaunch.visible && !startingBotAfterLaunch.visible) {
      if (!miningInstallingAfterLaunch.visible) {
        throw new Error(`${flowName}: launch/install did not reach a recognizable post-launch mining state.`);
      }
      console.info(`[E2E] ${flowName}: finalizeSetup ending while MiningIsInstalling remains visible`);
      return;
    }
    if (firstAuctionAfterLaunch.visible) {
      return;
    }
    if (startingBotAfterLaunch.visible || miningInstallingAfterLaunch.visible) {
      await waitForPostLaunchReadyState(flow, flowName);
      return;
    }
    await waitForPostLaunchReadyState(flow, flowName);
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

async function waitForServerInstallToReachLaunchableState(flow: IE2EFlowRuntime, flowName: string): Promise<void> {
  await pollEvery(
    2_000,
    async () => {
      const [dashboard, firstAuction, startingBot, launchBot, installProgress] = await Promise.all([
        flow.isVisible('MiningDashboard'),
        flow.isVisible('FirstAuction'),
        flow.isVisible('MiningStartingBot'),
        flow.isVisible('SetupChecklist.launchMiningBot()'),
        flow.isVisible({ selector: '.InstallProgress' }),
      ]);
      if (dashboard.visible || firstAuction.visible) return true;
      if (startingBot.visible) return true;
      if (launchBot.clickable) return true;

      const overlayCloseButton = await flow.isVisible('OverlayBase.clickClose()');
      if (overlayCloseButton.visible && overlayCloseButton.enabled) {
        console.info(`[E2E] ${flowName}: finalizeSetup closing blocking overlay while waiting for launch readiness`);
        await flow.click('OverlayBase.clickClose()').catch(() => undefined);
      }

      const failedStepCount = installProgress.visible
        ? await flow.count({ selector: '.InstallProgressStep[data-status="Failed"]' }).catch(() => 0)
        : 0;
      if (failedStepCount > 0) {
        throw new Error(`${flowName}: server install failed before launch button became available.`);
      }
      return false;
    },
    {
      timeoutMs: SERVER_INSTALL_READY_TIMEOUT_MS,
      timeoutMessage: `${flowName}: server install did not reach launchable state within ${
        SERVER_INSTALL_READY_TIMEOUT_MS / 60_000
      } minutes.`,
    },
  );
}

async function waitForInstallUiToAppearOrComplete(
  flow: IE2EFlowRuntime,
  didFinishInstall: () => Promise<boolean>,
  flowName: string,
): Promise<void> {
  if (await didFinishInstall()) return;

  await pollEvery(
    1_000,
    async () => {
      if (await didFinishInstall()) return true;
      const [installProgressVisible, miningInstallingVisible, startingBotVisible] = await Promise.all([
        flow.isVisible({ selector: '.InstallProgress' }),
        flow.isVisible('MiningIsInstalling'),
        flow.isVisible('MiningStartingBot'),
      ]);
      return installProgressVisible.visible || miningInstallingVisible.visible || startingBotVisible.visible;
    },
    {
      timeoutMs: 120_000,
      timeoutMessage: `${flowName}: install UI did not appear after launching mining bot.`,
    },
  );
}

async function waitForTotalBlocksMined(flow: IE2EFlowRuntime, flowName: string): Promise<void> {
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
}

async function waitForPostLaunchReadyState(flow: IE2EFlowRuntime, flowName: string): Promise<void> {
  await pollEvery(
    2_000,
    async () => {
      const [dashboardVisible, firstAuctionVisible] = await Promise.all([
        flow.isVisible('MiningDashboard'),
        flow.isVisible('FirstAuction'),
      ]);
      return dashboardVisible.visible || firstAuctionVisible.visible;
    },
    {
      timeoutMs: INSTALL_PROGRESS_TIMEOUT_MS,
      timeoutMessage: `${flowName}: post-launch mining state did not reach dashboard or first auction in time.`,
    },
  );
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
