import assert from 'node:assert/strict';
import { MICROGONS_PER_ARGON } from '@argonprotocol/mainchain';
import type { E2EFlowDefinition, E2EFlowRuntime } from '../types.js';
import {
  clickIfVisible,
  normalizeAmountInput,
  parseDecimalToUnits,
  parseRequiredNumber,
  pollEvery,
} from '../shared/utils.js';
import {
  getWalletOverlayFundingNeeded,
  sudoFundWallet,
  type SudoFundWalletInput,
} from '../shared/sudoFundWallet.js';

const DEFAULT_MINING_FUNDING_MULTIPLIER = 3n;

export const miningOnboardingFlow: E2EFlowDefinition = {
  name: 'miningOnboarding',
  description: 'Run mining setup, fund the wallet, and launch the mining bot.',
  defaultTimeoutMs: 15_000,
  async run(flow) {
    const requestedServerTab = typeof flow.input.serverTab === 'string' ? flow.input.serverTab.trim() : '';
    const serverTab = requestedServerTab || 'local';

    const startingBidArgons = normalizeAmountInput(flow.input.startingBidArgons, 'miningOnboarding.startingBidArgons');
    const maximumBidArgons = normalizeAmountInput(flow.input.maximumBidArgons, 'miningOnboarding.maximumBidArgons');
    const fundingArgons = normalizeAmountInput(flow.input.fundingArgons, 'miningOnboarding.fundingArgons');

    await flow.waitFor({ selector: '#app' }, { state: 'exists', timeoutMs: 30_000 });
    await clickIfVisible(flow, 'WelcomeOverlay.closeOverlay()');
    await enterMiningSetup(flow);

    await flow.click('FinalSetupChecklist.openHowMiningWorksOverlay()');
    await flow.click('HowMiningWorks.closeOverlay()');

    await flow.click('FinalSetupChecklist.openBotCreateOverlay()');
    await clickIfVisible(flow, 'BotCreatePanel.stopSuggestingTour()');
    if (startingBidArgons) {
      await applyCustomBid(flow, 'startingBid', startingBidArgons);
    }
    if (maximumBidArgons) {
      await applyCustomBid(flow, 'maximumBid', maximumBidArgons);
    }
    await flow.click('BotCreatePanel.saveRules()');

    await flow.click('FinalSetupChecklist.openFundMiningAccountOverlay()');
    await flow.waitFor('WalletOverlay.micronotsNeeded');
    await flow.waitFor('WalletOverlay.microgonsNeeded');

    const requiredFunding = await getWalletOverlayFundingNeeded(flow);
    const funding = deriveMiningFunding(requiredFunding, fundingArgons);
    await flow.click('WalletOverlay.closeOverlay()', { timeoutMs: 8_000 });
    await flow.waitFor('WalletOverlay.closeOverlay()', { state: 'missing', timeoutMs: 20_000 });

    const fundingResult = await sudoFundWallet(funding);
    console.info('[E2E] miningOnboarding funded wallet', {
      address: fundingResult.address,
      requestedMicrogons: fundingResult.requestedMicrogons.toString(),
      requestedMicronots: fundingResult.requestedMicronots.toString(),
      fundedMicrogons: fundingResult.fundedMicrogons.toString(),
      fundedMicronots: fundingResult.fundedMicronots.toString(),
    });

    await flow.click('FinalSetupChecklist.openServerConnectOverlay()', { timeoutMs: 20_000 });
    await flow.click(`ServerConnectOverlay.selectedTab='${serverTab}'`);

    if (serverTab === 'local') {
      const warningText = await flow
        .getText('ServerConnectOverlay.local.warning', { timeoutMs: 1_000 })
        .catch(() => null);
      if (warningText?.toUpperCase().includes('INELIGIBLE')) {
        throw new Error(`Local server not eligible: ${warningText.replace(/\s+/g, ' ').trim()}`);
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
        `Server connect button did not become enabled. ${details}. Root error: ${error instanceof Error ? error.message : String(error)}`,
      );
    });

    await flow.click('ServerConnectOverlay.connect()', { timeoutMs: 8_000 });
    await flow.waitFor({ selector: '.ConnectOverlay' }, { state: 'missing', timeoutMs: 30_000 });

    await flow.click('FinalSetupChecklist.launchMiningBot()', { timeoutMs: 120_000 });

    const didFinishInstall = async (): Promise<boolean> => {
      const dashboardState = await flow.isVisible('Dashboard');
      if (dashboardState.visible) return true;
      const firstAuctionState = await flow.isVisible('FirstAuction');
      return firstAuctionState.visible;
    };

    const installProgressState = await flow.isVisible({ selector: '.InstallProgress' });
    if (!installProgressState.visible && !(await didFinishInstall())) {
      await flow.waitFor({ selector: '.InstallProgress' }, { timeoutMs: 120_000 });
    }

    const backgroundInstallGraceMs = 90_000;
    let backgroundInstallStartedAt: number | null = null;
    await pollEvery(
      1_000,
      async () => {
        if (await didFinishInstall()) return true;

        const failedCount = await flow.count({ selector: '.InstallProgressStep.Failed' });
        assert.equal(failedCount, 0, 'InstallProgress contains failed steps');

        const stepCount = await flow.count({ selector: '.InstallProgressStep' });
        if (stepCount === 0) {
          return didFinishInstall();
        }

        let incompleteSteps = 0;
        let hasActiveInstallStep = false;
        for (let index = 0; index < stepCount; index += 1) {
          const status = await getAttributeOrNull(
            flow,
            { selector: '.InstallProgressStep', index },
            'data-status',
            2_000,
          );
          if (status === 'Failed') {
            assert.notEqual(status, 'Failed', `InstallProgressStep[${index}] status is Failed`);
          }
          if (status == null) {
            if (await didFinishInstall()) return true;
            incompleteSteps += 1;
            continue;
          }
          if (status === 'Completed') {
            hasActiveInstallStep = true;
            continue;
          }
          if (status === 'Pending') {
            incompleteSteps += 1;
            continue;
          }
          if (status === 'Working' || status === 'Completing') {
            hasActiveInstallStep = true;
          }

          const progress = await getAttributeOrNull(
            flow,
            { selector: '.InstallProgressStep .ProgressBar > div', index },
            'data-progress',
            500,
          );
          if (progress == null) {
            if (await didFinishInstall()) return true;
            incompleteSteps += 1;
            continue;
          }

          const progressValue = parseRequiredNumber(progress, `InstallProgressStep[${index}] progress`);
          if (progressValue < 100) {
            incompleteSteps += 1;
          }
        }

        if (hasActiveInstallStep) {
          backgroundInstallStartedAt ??= Date.now();
          if (Date.now() - backgroundInstallStartedAt >= backgroundInstallGraceMs) {
            // Local machine install can continue in the background for several minutes.
            // Once launch is clearly in-progress and no step has failed, continue this flow.
            return true;
          }
        } else {
          backgroundInstallStartedAt = null;
        }

        return incompleteSteps === 0;
      },
      {
        timeoutMs: 10 * 60_000,
        timeoutMessage: 'InstallProgress did not complete within 10 minutes',
      },
    );

    if (!(await didFinishInstall())) {
      console.info('[E2E] miningOnboarding: install still in progress; continuing after launch validation');
      return;
    }

    const dashboardState = await flow.isVisible('Dashboard');
    if (!dashboardState.visible) {
      await flow.waitFor('FirstAuction', { timeoutMs: 60_000 });
      await flow.waitFor('Dashboard', { timeoutMs: 60_000 });
    }

    const totalBlocksMinedRaw = await flow.getAttribute('TotalBlocksMined', 'data-value', { timeoutMs: 120_000 });
    const totalBlocksMined = parseRequiredNumber(totalBlocksMinedRaw, 'TotalBlocksMined');
    assert.ok(totalBlocksMined > 0, 'Expected TotalBlocksMined to be greater than 0');
  },
};

async function enterMiningSetup(flow: E2EFlowRuntime): Promise<void> {
  await pollEvery(
    500,
    async () => {
      await flow.click('TabSwitcher.goto(ScreenKey.Mining)');

      const blankSlate = await flow.isVisible('BlankSlate.startSettingUpMiner()');
      if (blankSlate.visible) return true;

      const checklist = await flow.isVisible('FinalSetupChecklist.openHowMiningWorksOverlay()');
      if (checklist.visible) return true;

      const dashboard = await flow.isVisible('Dashboard');
      if (dashboard.visible) return true;

      const firstAuction = await flow.isVisible('FirstAuction');
      return firstAuction.visible;
    },
    {
      timeoutMs: 30_000,
      timeoutMessage: 'Expected mining setup entry after selecting the mining tab.',
    },
  );

  if (await clickIfVisible(flow, 'BlankSlate.startSettingUpMiner()')) {
    await flow.waitFor('FinalSetupChecklist.openHowMiningWorksOverlay()', { timeoutMs: 30_000 });
  }
}

async function applyCustomBid(
  flow: E2EFlowRuntime,
  bidType: 'startingBid' | 'maximumBid',
  amountArgons: string,
): Promise<void> {
  await flow.click(`BotSettings.openEditBoxOverlay('${bidType}')`);
  const formulaTestId = bidType === 'startingBid' ? 'startingBidFormulaType' : 'maximumBidFormulaType';
  await flow.click(formulaTestId);
  await flow.click('Custom Amount');

  const inputId = bidType === 'startingBid' ? 'startingBidCustomAmount' : 'maximumBidCustomAmount';
  await flow.type({ selector: `[data-testid="${inputId}"] [data-testid="input-number"]` }, amountArgons, {
    clear: true,
  });
  await flow.click('EditBoxOverlay.saveOverlay()');
}

async function getAttributeOrNull(
  flow: E2EFlowRuntime,
  target: Parameters<E2EFlowRuntime['getAttribute']>[0],
  attribute: string,
  timeoutMs = 500,
): Promise<string | null> {
  try {
    return await flow.getAttribute(target, attribute, { timeoutMs });
  } catch (_error) {
    return null;
  }
}

function deriveMiningFunding(baseFunding: SudoFundWalletInput, fundingArgons: string | null): SudoFundWalletInput {
  if (!fundingArgons) {
    return {
      ...baseFunding,
      microgons: baseFunding.microgons * DEFAULT_MINING_FUNDING_MULTIPLIER,
      micronots: baseFunding.micronots * DEFAULT_MINING_FUNDING_MULTIPLIER,
    };
  }

  const targetMicrogons = parseDecimalToUnits(
    fundingArgons,
    BigInt(MICROGONS_PER_ARGON),
    'miningOnboarding.fundingArgons',
  );

  if (targetMicrogons <= baseFunding.microgons) {
    return baseFunding;
  }

  if (baseFunding.microgons <= 0n) {
    throw new Error('miningOnboarding: expected microgons requirement > 0');
  }

  const scaledMicronots =
    (baseFunding.micronots * targetMicrogons + baseFunding.microgons - 1n) / baseFunding.microgons;

  return {
    ...baseFunding,
    microgons: targetMicrogons,
    micronots: scaledMicronots > baseFunding.micronots ? scaledMicronots : baseFunding.micronots,
  };
}
