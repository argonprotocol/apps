import { mnemonicGenerate } from '@argonprotocol/mainchain';
import { DriverClient } from '../../driver/client.ts';
import type { IE2EFlowRuntime, IE2EOperationInspectState } from '../types.ts';
import { pollEvery } from '../helpers/utils.ts';
import { Operation } from './index.ts';

interface IAppFlowContext {
  flow: IE2EFlowRuntime;
}

type IPrepareAccessUiState = {
  welcomeOverlayVisible: boolean;
};

type IPrepareAccessState = IE2EOperationInspectState<Record<string, never>, IPrepareAccessUiState>;

export default new Operation<IAppFlowContext, IPrepareAccessState>(import.meta, {
  async inspect({ flow }) {
    const appState = await flow.queryApp(
      refs => ({
        showWelcomeOverlay: refs.config.showWelcomeOverlay,
      }),
      { timeoutMs: 5_000 },
    );
    const welcomeOverlayVisible = appState?.showWelcomeOverlay ?? true;
    const isComplete = !welcomeOverlayVisible;
    let operationState: 'complete' | 'runnable' = 'runnable';
    if (isComplete) {
      operationState = 'complete';
    }
    return {
      chainState: {},
      uiState: {
        welcomeOverlayVisible,
      },
      state: operationState,
      blockers: [],
    };
  },
  async run({ flow }, state) {
    if (!state.uiState.welcomeOverlayVisible) {
      return;
    }

    await flow.command('app.waitForReady', { timeoutMs: 120_000 });

    const appReloadMarker = flow.getAppReloadMarker();
    const mnemonic = mnemonicGenerate();
    flow.setData('walletMnemonic', mnemonic);

    await flow.click('WelcomeOverlay.startImportAccount()', { timeoutMs: 10_000 });

    await flow.command('clipboard.write', { text: mnemonic });
    await flow.click({ selector: '[role="dialog"] ol input[type="text"]', index: 0 }, { timeoutMs: 5_000 });
    await flow.paste({ selector: '[role="dialog"] ol input[type="text"]', index: 0 }, { timeoutMs: 5_000 });

    try {
      await flow.click('WelcomeOverlay.importFromMnemonic()', { timeoutMs: 10_000 });
    } catch (error) {
      if (!DriverClient.isRetryableConnectionError(error)) throw error;
    }

    // Import always restarts the UI; a hidden Welcome overlay can still belong to the old session.
    await flow.waitForReload(appReloadMarker, { timeoutMs: 120_000 });
    await pollEvery(
      500,
      async () => {
        try {
          await flow.command('app.waitForReady', { timeoutMs: 120_000 });
          const appState = await flow.queryApp(refs => ({ showWelcomeOverlay: refs.config.showWelcomeOverlay }), {
            timeoutMs: 1_000,
          });
          return appState?.showWelcomeOverlay === false;
        } catch (error) {
          if (!DriverClient.isRetryableConnectionError(error)) throw error;
          return false;
        }
      },
      {
        timeoutMs: 120_000,
        timeoutMessage: 'The imported account did not become ready after restarting the app.',
      },
    );
  },
});
