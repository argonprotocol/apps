import type { DriverClient } from '../driver/client.ts';
import { captureE2EScreenshot } from './helpers/screenshotMode.ts';
import { runOperations } from './operations/index.ts';
import type {
  E2ECommandArgs,
  IE2EClipboardOptions,
  IE2EFlowDefinition,
  IE2EFlowExecutionOptions,
  IE2EFlowExecutionResult,
  IE2EFlowRuntime,
  E2ETarget,
  IE2ETimeoutOptions,
  IE2ETypeOptions,
  IE2EWaitOptions,
} from './types.ts';

const DEFAULT_FLOW_TIMEOUT_MS = 15_000;

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

export async function executeFlow(
  driver: DriverClient,
  flow: IE2EFlowDefinition,
  execution: IE2EFlowExecutionOptions = {},
): Promise<IE2EFlowExecutionResult> {
  const data = new Map<string, unknown>();
  const input = normalizeInput(execution.input);
  const defaultTimeoutMs = flow.defaultTimeoutMs ?? DEFAULT_FLOW_TIMEOUT_MS;
  let activeOperationName = '';
  let interactionSequence = 0;

  const withCommandMeta = (args?: E2ECommandArgs): E2ECommandArgs => {
    const payload: E2ECommandArgs = { ...(args ?? {}) };
    if (activeOperationName && typeof payload.__operationName !== 'string') {
      payload.__operationName = activeOperationName;
    }
    return payload;
  };

  const toInteractionScreenshotName = (sequenceNumber: number, command: string, args?: E2ECommandArgs): string => {
    const sequence = sequenceNumber.toString().padStart(4, '0');
    const operationName = activeOperationName ? `${activeOperationName}-` : '';
    const target =
      typeof args?.testId === 'string' ? args.testId : typeof args?.selector === 'string' ? args.selector : 'no-target';
    const state = typeof args?.state === 'string' ? `-${args.state}` : '';
    return `${sequence}-${operationName}${command}-${target}${state}`;
  };

  const shouldCaptureInteractionScreenshot = (command: string, args?: E2ECommandArgs): boolean => {
    if (command === 'ui.click' || command === 'ui.type' || command === 'ui.copy' || command === 'ui.paste') {
      return true;
    }
    if (command !== 'ui.waitFor') {
      return false;
    }

    const state = typeof args?.state === 'string' ? args.state : 'visible';
    if (state === 'missing' || state === 'hidden') {
      return false;
    }
    if (typeof args?.selector === 'string' && args.selector === '#app') {
      return false;
    }
    return true;
  };

  const runDriverCommand = async <Result>(command: string, args?: E2ECommandArgs): Promise<Result> => {
    const payload = withCommandMeta(args);
    if (command === 'app.captureScreenshot') {
      return await driver.command<Result>(command, payload);
    }
    const shouldCaptureInteraction = shouldCaptureInteractionScreenshot(command, payload);
    let name: string | undefined;

    const captureInteractionScreenshot = async (phase: 'end' | 'failure') => {
      if (!name) {
        interactionSequence += 1;
        name = toInteractionScreenshotName(interactionSequence, command, payload);
      }
      await captureE2EScreenshot(runtime, {
        scope: 'interaction',
        phase,
        flowName: flow.name,
        name,
      });
    };

    try {
      const result = await driver.command<Result>(command, payload);
      if (shouldCaptureInteraction) {
        if (command !== 'ui.waitFor') {
          await new Promise(resolve => setTimeout(resolve, 180));
        }
        await captureInteractionScreenshot('end');
      }
      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (
        !errorMessage.includes('[app_command_not_received]') &&
        !errorMessage.includes('[driver_command_timeout]') &&
        !errorMessage.includes('[app_disconnected]') &&
        !errorMessage.includes('Driver socket closed')
      ) {
        await captureInteractionScreenshot('failure');
      }
      throw error;
    }
  };

  const runtime: IE2EFlowRuntime = {
    input,
    defaultTimeoutMs,
    setActiveOperation: (operationName?: string) => {
      activeOperationName = operationName?.trim() ?? '';
    },
    run: (command, args) => runDriverCommand(command, args),
    runOperations: async (context, operations) => {
      await runOperations(context, operations);
    },
    click: (target, options) =>
      runDriverCommand('ui.click', {
        ...withCommandMeta(),
        ...resolveTarget(target),
        timeoutMs: options?.timeoutMs ?? defaultTimeoutMs,
      }),
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

export type { IE2EFlowDefinition, E2ECommandArgs } from './types.ts';
