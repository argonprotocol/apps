import assert from 'node:assert/strict';
import { MICROGONS_PER_ARGON } from '@argonprotocol/mainchain';
import type { E2EFlowDefinition, E2EFlowRuntime, E2ETarget } from '../types.js';
import { getWalletOverlayFundingNeeded, sudoFundWallet } from '../shared/sudoFundWallet.js';
import { readClipboardWithRetries } from '../shared/readClipboardWithRetries.js';
import {
  clickIfVisible,
  normalizeAmountInput,
  parseBip21,
  parseDecimalToUnits,
  pollEvery,
  sleep,
} from '../shared/utils.js';
import { generateBlocks, runBtcCli } from '../shared/btcCli.js';

export const vaultingOnboardingFlow: E2EFlowDefinition = {
  name: 'vaultingOnboarding',
  description: 'Run vault setup, fund wallet, perform bitcoin lock and unlock flow.',
  defaultTimeoutMs: 20_000,
  async run(flow) {
    // Enter vaulting setup.
    await flow.waitFor({ selector: '#app' }, { state: 'exists', timeoutMs: 30_000 });
    await clickIfVisible(flow, 'WelcomeOverlay.closeOverlay()');

    await flow.click('TabSwitcher.goto(ScreenKey.Vaulting)');
    await waitForVaultingEntry(flow);

    await flow.click('FinalSetupChecklist.openHowVaultingWorksOverlay()');
    await flow.click('HowVaultingWorks.closeOverlay()', { timeoutMs: 30_000 });
    await flow.waitFor('HowVaultingWorks.closeOverlay()', { state: 'missing', timeoutMs: 30_000 });

    await flow.click('FinalSetupChecklist.openVaultCreateOverlay()');
    await clickIfVisible(flow, 'VaultCreatePanel.stopSuggestingTour()');
    await flow.click('VaultCreatePanel.saveRules()');
    await flow.waitFor('FinalSetupChecklist.openFundVaultingAccountOverlay()', { timeoutMs: 15_000 });

    // Fund vault wallet so the lock flow can start.
    await fundVaultWallet(flow);

    // Wait for vault creation to finish and entry actions to become available.
    await pollEvery(
      5_000,
      async () => {
        const vaultInstallError = await getVaultInstallError(flow);
        if (vaultInstallError) {
          throw new Error(`Vault creation failed: ${vaultInstallError}`);
        }

        const lockOverlayEntry = await flow.isVisible('PersonalBitcoin.showLockingOverlay()');
        if (lockOverlayEntry.visible) return true;

        const dashboard = await flow.isVisible('Dashboard');
        if (dashboard.visible) return true;

        const createVaultVisible = await flow.isVisible('FinalSetupChecklist.createVault()');
        if (createVaultVisible.visible) {
          try {
            await flow.click('FinalSetupChecklist.createVault()', { timeoutMs: 1_000 });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (!message.includes('Timed out waiting for clickable')) {
              throw error;
            }
          }
        }
        return false;
      },
      {
        timeoutMs: 10 * 60_000,
        timeoutMessage: 'Vault creation did not reach a ready vaulting state within 10 minutes.',
      },
    );

    // Lock flow.
    await flow.waitFor(personalLockStatus('LockReadyForBitcoin'), { timeoutMs: 180_000 });
    await flow.click('PersonalBitcoin.showLockingOverlay()', { timeoutMs: 30_000 });
    const bip21 = await readClipboardWithRetries(
      flow,
      () => flow.click('fundingBip21.copyContent()'),
      value => value.startsWith('bitcoin:'),
    );

    const { address: lockAddress, amount: lockAmount } = parseBip21(bip21);

    if (!lockAddress) {
      throw new Error('vaultingOnboarding: missing lock address');
    }
    if (!lockAmount) {
      throw new Error('vaultingOnboarding: missing lock amount');
    }

    const normalizedLockAmount = lockAmount.replace(/,/g, '');
    runBtcCli(['sendtoaddress', lockAddress, normalizedLockAmount]);

    const lockProgress = await advanceLockUntilCollecting(flow);
    assert.ok(lockProgress.collectingOverlayVisible, 'Missing lock collecting overlay state');
    assert.ok(lockProgress.personalProcessingOnBitcoin, 'Missing personal lock ProcessingOnBitcoin state');
    assert.ok(lockProgress.personalReadyForUnlock, 'Missing personal lock ready-for-unlock state');

    await flow.click('LockCollecting.closeOverlay()', { timeoutMs: 180_000 });

    // Unlock flow.
    await flow.click('PersonalBitcoin.showReleaseOverlay()', { timeoutMs: 180_000 });

    const releaseAddress = runBtcCli(['getnewaddress']);
    await flow.type('UnlockStart.destinationAddress', releaseAddress);

    await flow.click('UnlockStart.submitRelease()');
    const releaseProgress = await advanceUnlockUntilComplete(flow);
    assert.ok(
      releaseProgress.overlayUnlockCompleteSeen || releaseProgress.personalReleaseCompleteSeen,
      'Missing unlock completion state (overlay or lock-state None)',
    );
    if (!releaseProgress.personalReleaseProcessingBitcoinSeen) {
      console.warn('[E2E] vaultingOnboarding: unlock completed without observing ReleaseIsProcessingOnBitcoin state');
    }

    if (releaseProgress.overlayUnlockCompleteSeen) {
      await flow.click('UnlockComplete.closeOverlay()', { timeoutMs: 180_000 });
    }
    if (releaseProgress.personalReleaseCompleteSeen || releaseProgress.overlayUnlockCompleteSeen) {
      await flow.waitFor(personalLockStatus('None'), { timeoutMs: 120_000 });
    } else {
      console.warn(
        '[E2E] vaultingOnboarding: unlock completion not observed; proceeding after sustained ReleaseIsProcessingOnBitcoin',
      );
    }

    let receivedReleaseBitcoin = 0;
    const releaseMinerAddress = runBtcCli(['getnewaddress']);
    await pollEvery(
      3_000,
      async () => {
        generateBlocks(1, releaseMinerAddress);
        const received = Number(runBtcCli(['getreceivedbyaddress', releaseAddress, '1']));
        if (!Number.isFinite(received)) {
          throw new Error(`vaultingOnboarding: invalid bitcoin received amount "${String(received)}"`);
        }
        receivedReleaseBitcoin = received;
        return received > 0;
      },
      {
        timeoutMs: 120_000,
        timeoutMessage: `vaultingOnboarding: no bitcoin received at release address ${releaseAddress}`,
      },
    );
    assert.ok(receivedReleaseBitcoin > 0, `No bitcoin received at release address ${releaseAddress}`);
  },
};

function personalLockStatus(name: string): E2ETarget {
  return {
    selector: `[data-testid="PersonalBitcoin"][data-lock-state="${name}"]`,
  };
}

function personalLockState(isLocked: boolean): E2ETarget {
  return {
    selector: `[data-testid="PersonalBitcoin"][data-is-locked="${isLocked ? 'true' : 'false'}"]`,
  };
}

async function waitForVaultingEntry(flow: E2EFlowRuntime): Promise<void> {
  await pollEvery(
    500,
    async () => {
      const blankSlate = await flow.isVisible('BlankSlate.startSettingUpVault()');
      if (blankSlate.visible) return true;

      const checklist = await flow.isVisible('FinalSetupChecklist.openHowVaultingWorksOverlay()');
      return checklist.visible;
    },
    {
      timeoutMs: 30_000,
      timeoutMessage: 'Expected vault setup checklist or blank slate to display.',
    },
  );

  if (await clickIfVisible(flow, 'BlankSlate.startSettingUpVault()')) {
    await flow.waitFor('FinalSetupChecklist.openHowVaultingWorksOverlay()', { timeoutMs: 30_000 });
  }
}

async function fundVaultWallet(flow: E2EFlowRuntime): Promise<void> {
  await flow.click('FinalSetupChecklist.openFundVaultingAccountOverlay()');
  const { address, microgons, micronots } = await getWalletOverlayFundingNeeded(flow);

  const extraFundingArgons =
    normalizeAmountInput(flow.input.extraFundingArgons, 'vaultingOnboarding.extraFundingArgons') ?? '1000';
  const extraMicrogons = parseDecimalToUnits(
    extraFundingArgons,
    BigInt(MICROGONS_PER_ARGON),
    'vaultingOnboarding.extraFundingArgons',
  );

  await flow.click('WalletOverlay.closeOverlay()', { timeoutMs: 8_000 });

  await sudoFundWallet({
    address,
    microgons: microgons + extraMicrogons,
    micronots,
  });
}

interface LockProgress {
  collectingOverlayVisible: boolean;
  personalProcessingOnBitcoin: boolean;
  personalReadyForUnlock: boolean;
}

async function advanceLockUntilCollecting(flow: E2EFlowRuntime): Promise<LockProgress> {
  const personalLockProcessingBitcoinTarget = personalLockStatus('LockIsProcessingOnBitcoin');
  const personalLockedTarget = personalLockState(true);

  const progress: LockProgress = {
    collectingOverlayVisible: false,
    personalProcessingOnBitcoin: false,
    personalReadyForUnlock: false,
  };
  const minerAddress = runBtcCli(['getnewaddress']);

  for (let i = 0; i < 120; i += 1) {
    const lockCollectingClose = await flow.isVisible('LockCollecting.closeOverlay()');
    if (lockCollectingClose.visible) {
      progress.collectingOverlayVisible = true;
    }

    const personalProcessingBitcoinCount = await flow.count(personalLockProcessingBitcoinTarget);
    if (personalProcessingBitcoinCount > 0) {
      progress.personalProcessingOnBitcoin = true;
    }

    const personalLockedCount = await flow.count(personalLockedTarget);
    if (personalLockedCount > 0) {
      progress.personalReadyForUnlock = true;
    }

    if (progress.collectingOverlayVisible && progress.personalProcessingOnBitcoin && progress.personalReadyForUnlock) {
      return progress;
    }

    generateBlocks(1, minerAddress);
    await sleep(2_000);
  }

  return progress;
}

interface UnlockProgress {
  personalReleaseProcessingArgonSeen: boolean;
  personalReleaseWaitingForVaultSeen: boolean;
  personalReleaseSignedSeen: boolean;
  personalReleaseProcessingBitcoinSeen: boolean;
  overlayUnlockCompleteSeen: boolean;
  personalReleaseCompleteSeen: boolean;
  fellBackAfterBitcoinProcessing: boolean;
}

async function advanceUnlockUntilComplete(flow: E2EFlowRuntime): Promise<UnlockProgress> {
  const personalReleaseProcessingArgonTarget = personalLockStatus('ReleaseIsProcessingOnArgon');
  const personalReleaseWaitingForVaultTarget = personalLockStatus('ReleaseIsWaitingForVault');
  const personalReleaseSignedTarget = personalLockStatus('ReleaseSigned');
  const personalReleaseProcessingBitcoinTarget = personalLockStatus('ReleaseIsProcessingOnBitcoin');
  const personalReleaseCompleteTarget = personalLockStatus('None');

  const progress: UnlockProgress = {
    personalReleaseProcessingArgonSeen: false,
    personalReleaseWaitingForVaultSeen: false,
    personalReleaseSignedSeen: false,
    personalReleaseProcessingBitcoinSeen: false,
    overlayUnlockCompleteSeen: false,
    personalReleaseCompleteSeen: false,
    fellBackAfterBitcoinProcessing: false,
  };
  const minerAddress = runBtcCli(['getnewaddress']);
  let releaseProcessingBitcoinLoops = 0;

  for (let i = 0; i < 180; i += 1) {
    const personalReleaseProcessingArgonCount = await flow.count(personalReleaseProcessingArgonTarget);
    if (personalReleaseProcessingArgonCount > 0) {
      progress.personalReleaseProcessingArgonSeen = true;
    }
    const personalReleaseWaitingForVaultCount = await flow.count(personalReleaseWaitingForVaultTarget);
    if (personalReleaseWaitingForVaultCount > 0) {
      progress.personalReleaseWaitingForVaultSeen = true;
    }
    const personalReleaseSignedCount = await flow.count(personalReleaseSignedTarget);
    if (personalReleaseSignedCount > 0) {
      progress.personalReleaseSignedSeen = true;
    }
    const personalReleaseProcessingBitcoinCount = await flow.count(personalReleaseProcessingBitcoinTarget);
    if (personalReleaseProcessingBitcoinCount > 0) {
      progress.personalReleaseProcessingBitcoinSeen = true;
      releaseProcessingBitcoinLoops += 1;
    } else {
      releaseProcessingBitcoinLoops = 0;
    }
    const personalReleaseCompleteCount = await flow.count(personalReleaseCompleteTarget);
    if (personalReleaseCompleteCount > 0) {
      progress.personalReleaseCompleteSeen = true;
      return progress;
    }

    const unlockComplete = await flow.isVisible('UnlockComplete.closeOverlay()');
    if (unlockComplete.visible) {
      progress.overlayUnlockCompleteSeen = true;
      return progress;
    }

    if (releaseProcessingBitcoinLoops >= 40) {
      progress.fellBackAfterBitcoinProcessing = true;
      return progress;
    }

    generateBlocks(1, minerAddress);
    await sleep(3_000);
  }

  return progress;
}

async function getVaultInstallError(flow: E2EFlowRuntime): Promise<string | null> {
  const errorTarget = 'VaultIsInstalling.errorMessage';
  const errorState = await flow.isVisible(errorTarget);
  if (!errorState.visible) return null;

  const message = (await flow.getText(errorTarget, { timeoutMs: 1_000 })).trim();
  return message.length > 0 ? message : 'Unknown vault setup error';
}
