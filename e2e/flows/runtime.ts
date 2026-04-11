import type { DriverClient } from '../driver/client.ts';
import { captureE2EScreenshot, getE2EScreenshotMode } from './helpers/screenshotMode.ts';
import { isRetryableAppConnectionError, sleep } from './helpers/utils.ts';
import { runOperation } from './operations/index.ts';
import type {
  E2ECommandArgs,
  IE2EClipboardOptions,
  IE2EFlowDefinition,
  IE2EFlowExecutionOptions,
  IE2EFlowExecutionResult,
  IE2EFlowRuntime,
  IE2EQueryAppOptions,
  IE2ERunOperationOptions,
  E2ETarget,
  IE2EClickOptions,
  IE2ETimeoutOptions,
  IE2ETypeOptions,
  IE2EWaitOptions,
} from './types.ts';

const DEFAULT_FLOW_TIMEOUT_MS = 15_000;

interface IQueryAppCommandResult<T = unknown> {
  value?: T;
}

function normalizeInput(input: IE2EFlowExecutionOptions['input']): E2ECommandArgs {
  if (!input) return {};
  return input;
}

function resolveTarget(target: E2ETarget): { testId?: string; selector?: string; index?: number } {
  if (typeof target === 'string') {
    return { testId: target };
  }
  if (!target.testId && !target.selector) {
    throw new Error('[E2E] Target must include testId or selector');
  }
  return target;
}

function looksLikeOperation(value: unknown): boolean {
  return !!value && typeof value === 'object' && typeof (value as { inspect?: unknown }).inspect === 'function';
}

export async function executeFlow(
  driver: DriverClient,
  flow: IE2EFlowDefinition,
  execution: IE2EFlowExecutionOptions = {},
): Promise<IE2EFlowExecutionResult> {
  const data = new Map<string, unknown>();
  const input = normalizeInput(execution.input);
  const defaultTimeoutMs = flow.defaultTimeoutMs ?? DEFAULT_FLOW_TIMEOUT_MS;
  let activeOperationName = '';
  let screenshotSequence = 0;

  const withCommandMeta = (args?: E2ECommandArgs): E2ECommandArgs => {
    const payload: E2ECommandArgs = { ...(args ?? {}) };
    if (activeOperationName && typeof payload.__operationName !== 'string') {
      payload.__operationName = activeOperationName;
    }
    return payload;
  };

  const toCommandScreenshotName = (sequenceNumber: number, command: string, args?: E2ECommandArgs): string => {
    const sequence = sequenceNumber.toString().padStart(4, '0');
    const operationName = activeOperationName ? `${activeOperationName}-` : '';
    const target =
      typeof args?.testId === 'string' ? args.testId : typeof args?.selector === 'string' ? args.selector : 'no-target';
    const state = typeof args?.state === 'string' ? `-${args.state}` : '';
    return `${sequence}-${operationName}${command}-${target}${state}`;
  };

  const isMutatingUiCommand = (command: string): boolean => {
    return command === 'ui.click' || command === 'ui.type' || command === 'ui.copy' || command === 'ui.paste';
  };

  const getPreInteractionWaitState = (command: string): 'clickable' | 'enabled' | null => {
    if (command === 'ui.click') return 'clickable';
    if (command === 'ui.type' || command === 'ui.copy' || command === 'ui.paste') return 'enabled';
    return null;
  };

  const runDriverCommand = async <Result>(command: string, args?: E2ECommandArgs): Promise<Result> => {
    const payload = withCommandMeta(args);
    if (command === 'app.captureScreenshot') {
      return await driver.command<Result>(command, payload);
    }
    const screenshotMode = getE2EScreenshotMode();
    const shouldCaptureCommandScreenshot = isMutatingUiCommand(command) && screenshotMode === 'on';
    let name: string | undefined;

    const captureCommandScreenshot = async (
      phase: 'start' | 'failure',
      scope: 'operation' | 'interaction',
    ): Promise<void> => {
      if (!name) {
        screenshotSequence += 1;
        name = toCommandScreenshotName(screenshotSequence, command, payload);
      }
      await captureE2EScreenshot(runtime, {
        scope,
        phase,
        flowName: flow.name,
        name,
      });
    };

    try {
      if (shouldCaptureCommandScreenshot) {
        const readinessState = getPreInteractionWaitState(command);
        const waitArgs: E2ECommandArgs = {};
        if (typeof payload.testId === 'string') waitArgs.testId = payload.testId;
        if (typeof payload.selector === 'string') waitArgs.selector = payload.selector;
        if (typeof payload.index === 'number') waitArgs.index = payload.index;
        if (readinessState) {
          waitArgs.state = readinessState;
        }
        waitArgs.timeoutMs = typeof payload.timeoutMs === 'number' ? payload.timeoutMs : defaultTimeoutMs;
        await driver.command('ui.waitFor', withCommandMeta(waitArgs));
        await captureCommandScreenshot('start', 'interaction');
      }
      const result = await driver.command<Result>(command, payload);
      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (
        shouldCaptureCommandScreenshot &&
        !errorMessage.includes('[app_command_not_received]') &&
        !errorMessage.includes('[driver_command_timeout]') &&
        !errorMessage.includes('[app_disconnected]') &&
        !errorMessage.includes('Driver socket closed')
      ) {
        await captureCommandScreenshot('failure', 'interaction');
      }
      throw error;
    }
  };

  const runtime: IE2EFlowRuntime = {
    flowName: flow.name,
    input,
    defaultTimeoutMs,
    setActiveOperation: (operationName?: string) => {
      activeOperationName = operationName?.trim() ?? '';
    },
    getAppReloadMarker: () => driver.getAppReloadMarker(),
    waitForReload: async (reloadMarker, options = {}) => {
      const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
      let timeoutId: ReturnType<typeof setTimeout> | null = null;
      const timeout = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error(`[E2E] Timed out waiting for app reload after ${timeoutMs}ms`));
        }, timeoutMs);
      });

      try {
        await Promise.race([driver.waitForApp(reloadMarker + 1), timeout]);
      } finally {
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
      }
      await waitForAppUiReadyAfterReload(driver, withCommandMeta, timeoutMs);
    },
    command: (command, args) => {
      if (command.startsWith('command.')) {
        throw new Error(`[E2E] '${command}' is reserved for runtime internals. Use a dedicated flow method instead.`);
      }
      return runDriverCommand(command, args);
    },
    run: async (...args: unknown[]) => {
      if (looksLikeOperation(args[0])) {
        throw new Error('flow.run(operation) requires an active operation context.');
      }
      const [context, operation, options] = args;
      await runOperation(context, operation as never, options as IE2ERunOperationOptions<typeof context> | undefined);
    },
    inspect: async () => {
      throw new Error('flow.inspect() requires an active operation context.');
    },
    waitUntilRunnable: async () => {
      throw new Error('flow.waitUntilRunnable() requires an active operation context.');
    },
    poll: async () => {
      throw new Error('flow.poll() requires an active operation context.');
    },
    queryApp: async <T = unknown>(fn: string, options: IE2EQueryAppOptions = {}) => {
      const result = await runDriverCommand<IQueryAppCommandResult<T>>('command.queryApp', {
        ...withCommandMeta(),
        fn,
        timeoutMs: options.timeoutMs ?? defaultTimeoutMs,
        args: options.args ?? {},
      }).catch(() => undefined);
      return result?.value;
    },
    click: async (target, options?: IE2EClickOptions) => {
      const resolvedTarget = resolveTarget(target);
      await runDriverCommand('ui.click', {
        ...withCommandMeta(),
        ...resolvedTarget,
        timeoutMs: options?.timeoutMs ?? defaultTimeoutMs,
      });
      if (!options?.waitForDisappearMs) {
        return;
      }
      await runDriverCommand('ui.waitFor', {
        ...withCommandMeta(),
        ...resolvedTarget,
        state: 'missing',
        timeoutMs: options.waitForDisappearMs,
      });
    },
    type: (target, text, options: IE2ETypeOptions = {}) =>
      runDriverCommand('ui.type', {
        ...withCommandMeta(),
        ...resolveTarget(target),
        text,
        clear: options?.clear ?? false,
        timeoutMs: options?.timeoutMs ?? defaultTimeoutMs,
      }),
    waitFor: (target, options: IE2EWaitOptions = {}) =>
      runDriverCommand('ui.waitFor', {
        ...withCommandMeta(),
        ...resolveTarget(target),
        state: options?.state ?? 'visible',
        timeoutMs: options?.timeoutMs ?? defaultTimeoutMs,
      }),
    isVisible: target => runDriverCommand('ui.isVisible', { ...withCommandMeta(), ...resolveTarget(target) }),
    count: async target => {
      const result = await runDriverCommand<{ count?: unknown }>('ui.count', {
        ...withCommandMeta(),
        ...resolveTarget(target),
      });
      if (typeof result?.count !== 'number' || !Number.isInteger(result.count) || result.count < 0) {
        throw new Error('ui.count returned an invalid payload');
      }
      return result.count;
    },
    getText: async (target, options: IE2ETimeoutOptions = {}) => {
      const result = await runDriverCommand<{ text?: unknown }>('ui.getText', {
        ...withCommandMeta(),
        ...resolveTarget(target),
        timeoutMs: options?.timeoutMs ?? defaultTimeoutMs,
      });
      if (typeof result?.text !== 'string') {
        throw new Error('ui.getText returned a non-string payload');
      }
      return result.text;
    },
    getAttribute: async (target, attribute: string, options: IE2ETimeoutOptions = {}) => {
      const result = await runDriverCommand<{ value?: unknown }>('ui.getAttribute', {
        ...withCommandMeta(),
        ...resolveTarget(target),
        attribute,
        timeoutMs: options?.timeoutMs ?? defaultTimeoutMs,
      });
      if (typeof result?.value === 'string' || result?.value == null) {
        return result.value as string | null;
      }
      throw new Error('ui.getAttribute returned a non-string payload');
    },
    copy: (target, options: IE2ETimeoutOptions = {}) =>
      runDriverCommand('ui.copy', {
        ...withCommandMeta(),
        ...resolveTarget(target),
        timeoutMs: options?.timeoutMs ?? defaultTimeoutMs,
      }),
    paste: (target, options: IE2EClipboardOptions = {}) =>
      runDriverCommand('ui.paste', {
        ...withCommandMeta(),
        ...resolveTarget(target),
        clear: options?.clear ?? false,
        timeoutMs: options?.timeoutMs ?? defaultTimeoutMs,
      }),
    captureScreenshot: async options => {
      const result = await driver.command<{ path?: unknown }>('app.captureScreenshot', {
        ...withCommandMeta(),
        outputPath: options?.outputPath ?? null,
        name: options?.name ?? null,
        timeoutMs: options?.timeoutMs ?? defaultTimeoutMs,
      });
      if (typeof result?.path !== 'string' || !result.path.trim()) {
        throw new Error('app.captureScreenshot returned an invalid path');
      }
      return result.path;
    },
    setData: (key, value) => {
      data.set(key, value);
    },
    getData: <T = unknown>(key: string) => data.get(key) as T | undefined,
  };

  await ensureRuntimeUiReady(runtime);
  await flow.run(runtime);

  return {
    data: Object.fromEntries(data.entries()),
  };
}

async function ensureRuntimeUiReady(runtime: IE2EFlowRuntime): Promise<void> {
  await runtime.waitFor({ selector: '#app' }, { state: 'exists', timeoutMs: 30_000 });
}

async function waitForAppUiReadyAfterReload(
  driver: DriverClient,
  withCommandMeta: (args?: E2ECommandArgs) => E2ECommandArgs,
  timeoutMs: number,
): Promise<void> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const remainingMs = timeoutMs - (Date.now() - startedAt);

    try {
      await driver.command(
        'ui.waitFor',
        withCommandMeta({
          selector: '#app',
          state: 'exists',
          timeoutMs: Math.min(15_000, Math.max(1_000, remainingMs)),
        }),
      );
      return;
    } catch (error) {
      if (!isRetryableAppConnectionError(error)) {
        throw error;
      }
      await sleep(250);
    }
  }

  throw new Error(`[E2E] Timed out waiting for app UI after reload after ${timeoutMs}ms`);
}

export { type IE2EFlowDefinition, type E2ECommandArgs } from './types.ts';
