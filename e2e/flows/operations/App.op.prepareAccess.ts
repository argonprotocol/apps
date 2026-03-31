import { clickIfVisible } from '../helpers/utils.ts';
import type { IE2EFlowRuntime, IE2EOperationInspectState } from '../types.ts';
import { Operation } from './index.ts';

interface IAppFlowContext {
  flow: IE2EFlowRuntime;
}

type IPrepareAccessUiState = {
  welcomeOverlayVisible: boolean;
  createAccountVisible: boolean;
  createConnectVisible: boolean;
  importAccountVisible: boolean;
  importFromMnemonicVisible: boolean;
};

type IPrepareAccessState = IE2EOperationInspectState<Record<string, never>, IPrepareAccessUiState>;

export default new Operation<IAppFlowContext, IPrepareAccessState>(import.meta, {
  async inspect({ flow }) {
    const [welcomeOverlay, createAccount, createConnect, importAccount, importFromMnemonic] = await Promise.all([
      flow.isVisible({ selector: '[data-testid="WelcomeOverlay"]' }),
      flow.isVisible('WelcomeOverlay.startCreateAccount()'),
      flow.isVisible('WelcomeOverlay.connectToNetwork()'),
      flow.isVisible('WelcomeOverlay.startImportAccount()'),
      flow.isVisible('WelcomeOverlay.importFromMnemonic()'),
    ]);
    const isComplete = !welcomeOverlay.visible;
    let operationState: 'complete' | 'runnable' = 'runnable';
    if (isComplete) {
      operationState = 'complete';
    }
    return {
      chainState: {},
      uiState: {
        welcomeOverlayVisible: welcomeOverlay.visible,
        createAccountVisible: createAccount.visible,
        createConnectVisible: createConnect.visible,
        importAccountVisible: importAccount.visible,
        importFromMnemonicVisible: importFromMnemonic.visible,
      },
      state: operationState,
      blockers: [],
    };
  },
  async run({ flow }, state) {
    if (!state.uiState.welcomeOverlayVisible) {
      return;
    }

    if (process.env.E2E_WELCOME_MNEMONIC?.trim()) {
      await recoverMnemonicFromWelcomeOverlay(flow, process.env.E2E_WELCOME_MNEMONIC.trim());
      return;
    }

    await connectToKnownServer(flow);
  },
});

async function connectToKnownServer(flow: IE2EFlowRuntime): Promise<void> {
  const bootstrapHost = getKnownBootstrapHost();
  const connectVisible = await flow.isVisible('WelcomeOverlay.connectToNetwork()');

  if (!connectVisible.visible) {
    const started = await clickIfVisible(flow, 'WelcomeOverlay.startCreateAccount()', { timeoutMs: 5_000 });
    if (!started) {
      throw new Error('Welcome overlay is visible, but the create-account action is not clickable.');
    }
    await flow.waitFor('WelcomeOverlay.connectToNetwork()', { timeoutMs: 10_000 });
  }

  const switchedToPublic = await clickIfVisible(flow, 'WelcomeOverlay.setType(BootstrapType.Public)', {
    timeoutMs: 2_000,
  });
  if (!switchedToPublic) {
    throw new Error('Welcome overlay create step is visible, but the public bootstrap option is not clickable.');
  }

  await flow.type({ selector: '[data-testid="WelcomeOverlay"] input', index: 0 }, bootstrapHost, {
    clear: true,
    timeoutMs: 5_000,
  });
  await flow.click('WelcomeOverlay.connectToNetwork()', { timeoutMs: 5_000 });
  await flow.waitFor({ selector: '[data-testid="WelcomeOverlay"]' }, { state: 'missing', timeoutMs: 10_000 });
}

async function recoverMnemonicFromWelcomeOverlay(flow: IE2EFlowRuntime, mnemonic: string): Promise<void> {
  const importReady = await flow.isVisible('WelcomeOverlay.importFromMnemonic()');

  if (!importReady.visible) {
    const started = await clickIfVisible(flow, 'WelcomeOverlay.startImportAccount()', { timeoutMs: 5_000 });
    if (!started) {
      throw new Error('Welcome overlay is visible, but the import-account action is not clickable.');
    }
    await flow.click("Overview.goTo('import-from-mnemonic')", { timeoutMs: 10_000 });
    await flow.waitFor('WelcomeOverlay.importFromMnemonic()', { timeoutMs: 10_000 });
  }

  await flow.command('clipboard.write', { text: mnemonic });
  await flow.paste({ selector: '[data-testid="WelcomeOverlay"] input', index: 0 }, { clear: true, timeoutMs: 5_000 });
  await flow.click('WelcomeOverlay.importFromMnemonic()', { timeoutMs: 5_000 });
  await flow.waitFor({ selector: '[data-testid="WelcomeOverlay"]' }, { state: 'missing', timeoutMs: 30_000 });
}

function getKnownBootstrapHost(): string {
  const rawOverride = process.env.ARGON_NETWORK_CONFIG_OVERRIDE;
  if (!rawOverride) {
    throw new Error('ARGON_NETWORK_CONFIG_OVERRIDE is required to bootstrap the welcome overlay in e2e.');
  }

  let archiveUrl: string | undefined;
  try {
    archiveUrl = JSON.parse(rawOverride)?.archiveUrl;
  } catch (error) {
    throw new Error(`Failed to parse ARGON_NETWORK_CONFIG_OVERRIDE: ${(error as Error).message}`);
  }

  if (typeof archiveUrl !== 'string' || archiveUrl.trim().length === 0) {
    throw new Error('ARGON_NETWORK_CONFIG_OVERRIDE.archiveUrl is required to bootstrap the welcome overlay in e2e.');
  }

  try {
    return new URL(archiveUrl).host;
  } catch {
    return archiveUrl.replace(/^[a-z]+:\/\//i, '').split('/')[0] ?? archiveUrl;
  }
}
