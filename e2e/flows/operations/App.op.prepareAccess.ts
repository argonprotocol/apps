import type { IE2EFlowRuntime, IE2EOperationInspectState } from '../types.ts';
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
    const welcomeOverlay = await flow.isVisible({ selector: '[data-testid="WelcomeOverlay"]' });
    const isComplete = !welcomeOverlay.visible;
    let operationState: 'complete' | 'runnable' = 'runnable';
    if (isComplete) {
      operationState = 'complete';
    }
    return {
      chainState: {},
      uiState: {
        welcomeOverlayVisible: welcomeOverlay.visible,
      },
      state: operationState,
      blockers: [],
    };
  },
  async run({ flow }, state) {
    if (!state.uiState.welcomeOverlayVisible) {
      return;
    }

    await flow.command('command.queryApp', {
      timeoutMs: 10_000,
      fn: `(refs) => {
        refs.config.bootstrapDetails = {
          type: 'Public',
          routerHost: 'LOADING',
        };
        return refs.config.save().then(() => ({
          showWelcomeOverlay: refs.config.showWelcomeOverlay,
          bootstrapDetails: refs.config.bootstrapDetails,
        }));
      }`,
    });

    await flow.waitFor({ selector: '[data-testid="WelcomeOverlay"]' }, { state: 'missing', timeoutMs: 10_000 });
  },
});
