import { mnemonicGenerate } from '@argonprotocol/mainchain';
import type { IE2EFlowRuntime, IE2EOperationInspectState } from '../types.ts';
import { isRetryableAppConnectionError, pollEvery } from '../helpers/utils.ts';
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
    const appState = await flow.queryApp<{ showWelcomeOverlay?: boolean }>(
      'refs => ({ showWelcomeOverlay: refs.config.showWelcomeOverlay })',
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

    const appReloadMarker = flow.getAppReloadMarker();
    const mnemonic = mnemonicGenerate();

    await flow.click('WelcomeOverlay.startImportAccount()', { timeoutMs: 10_000 });

    await flow.command('clipboard.write', { text: mnemonic });
    await flow.click({ selector: '[role="dialog"] ol input[type="text"]', index: 0 }, { timeoutMs: 5_000 });
    await flow.paste({ selector: '[role="dialog"] ol input[type="text"]', index: 0 }, { timeoutMs: 5_000 });

    await flow.click('WelcomeOverlay.importFromMnemonic()', { timeoutMs: 10_000 });

    let sawReloadError = false;
    await pollEvery(
      500,
      async () => {
        try {
          const importButton = await flow.isVisible('WelcomeOverlay.importFromMnemonic()');
          return !importButton.exists || !importButton.visible;
        } catch (error) {
          if (isRetryableAppConnectionError(error)) {
            sawReloadError = true;
            return false;
          }
          throw error;
        }
      },
      {
        timeoutMs: 30_000,
        timeoutMessage: 'Welcome overlay did not clear after mnemonic import.',
      },
    );

    let reloadHandled = false;
    let settledPolls = 0;
    await pollEvery(
      250,
      async () => {
        try {
          if (!reloadHandled && (sawReloadError || flow.getAppReloadMarker() > appReloadMarker)) {
            await flow.waitForReload(appReloadMarker, { timeoutMs: 30_000 });
            reloadHandled = true;
            sawReloadError = false;
            settledPolls = 0;
            return false;
          }

          const appState = await flow.queryApp<{ showWelcomeOverlay?: boolean }>(
            'refs => ({ showWelcomeOverlay: refs.config.showWelcomeOverlay })',
            { timeoutMs: 1_000 },
          );
          if (appState?.showWelcomeOverlay !== false) {
            settledPolls = 0;
            return false;
          }

          settledPolls += 1;
          return settledPolls >= 5;
        } catch (error) {
          if (!isRetryableAppConnectionError(error)) {
            throw error;
          }
          sawReloadError = true;
          settledPolls = 0;
          return false;
        }
      },
      {
        timeoutMs: 30_000,
        timeoutMessage: 'App did not stabilize after mnemonic import.',
      },
    );
  },
});
