import type { DriverClient } from '../driver/client.ts';
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

  const withCommandMeta = (args?: E2ECommandArgs): E2ECommandArgs => {
    const payload: E2ECommandArgs = { ...(args ?? {}) };
    if (activeOperationName && typeof payload.__operationName !== 'string') {
      payload.__operationName = activeOperationName;
    }
    return payload;
  };

  const runtime: IE2EFlowRuntime = {
    input,
    defaultTimeoutMs,
    setActiveOperation: (operationName?: string) => {
      activeOperationName = operationName?.trim() ?? '';
    },
    run: (command, args) => driver.command(command, withCommandMeta(args)),
    runOperations: async (context, operations) => {
      await runOperations(context, operations);
    },
    click: (target, options) =>
      driver.command('ui.click', {
        ...withCommandMeta(),
        ...resolveTarget(target),
        timeoutMs: options?.timeoutMs ?? defaultTimeoutMs,
      }),
    type: (target, text, options: IE2ETypeOptions = {}) =>
      driver.command('ui.type', {
        ...withCommandMeta(),
        ...resolveTarget(target),
        text,
        clear: options?.clear ?? false,
        timeoutMs: options?.timeoutMs ?? defaultTimeoutMs,
      }),
    waitFor: (target, options: IE2EWaitOptions = {}) =>
      driver.command('ui.waitFor', {
        ...withCommandMeta(),
        ...resolveTarget(target),
        state: options?.state ?? 'visible',
        timeoutMs: options?.timeoutMs ?? defaultTimeoutMs,
      }),
    isVisible: target => driver.command('ui.isVisible', { ...withCommandMeta(), ...resolveTarget(target) }),
    count: async target => {
      const result = await driver.command<{ count?: unknown }>('ui.count', {
        ...withCommandMeta(),
        ...resolveTarget(target),
      });
      if (typeof result?.count !== 'number' || !Number.isInteger(result.count) || result.count < 0) {
        throw new Error('ui.count returned an invalid payload');
      }
      return result.count;
    },
    getText: async (target, options: IE2ETimeoutOptions = {}) => {
      const result = await driver.command<{ text?: unknown }>('ui.getText', {
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
      const result = await driver.command<{ value?: unknown }>('ui.getAttribute', {
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
      driver.command('ui.copy', {
        ...withCommandMeta(),
        ...resolveTarget(target),
        timeoutMs: options?.timeoutMs ?? defaultTimeoutMs,
      }),
    paste: (target, options: IE2EClipboardOptions = {}) =>
      driver.command('ui.paste', {
        ...withCommandMeta(),
        ...resolveTarget(target),
        clear: options?.clear ?? false,
        timeoutMs: options?.timeoutMs ?? defaultTimeoutMs,
      }),
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
