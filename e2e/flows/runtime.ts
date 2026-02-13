import type { DriverClient } from '../driver/client.js';
import type {
  E2ECommandArgs,
  E2EClipboardOptions,
  E2EFlowDefinition,
  E2EFlowExecutionOptions,
  E2EFlowExecutionResult,
  E2EFlowRuntime,
  E2ETarget,
  E2ETimeoutOptions,
  E2ETypeOptions,
  E2EWaitOptions,
} from './types.js';

const DEFAULT_FLOW_TIMEOUT_MS = 15_000;

function normalizeInput(input: E2EFlowExecutionOptions['input']): E2ECommandArgs {
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
  flow: E2EFlowDefinition,
  execution: E2EFlowExecutionOptions = {},
): Promise<E2EFlowExecutionResult> {
  const data = new Map<string, unknown>();
  const input = normalizeInput(execution.input);
  const defaultTimeoutMs = flow.defaultTimeoutMs ?? DEFAULT_FLOW_TIMEOUT_MS;

  const runtime: E2EFlowRuntime = {
    input,
    defaultTimeoutMs,
    run: (command, args) => driver.command(command, args ?? {}),
    click: (target, options) =>
      driver.command('ui.click', {
        ...resolveTarget(target),
        timeoutMs: options?.timeoutMs ?? defaultTimeoutMs,
      }),
    type: (target, text, options: E2ETypeOptions = {}) =>
      driver.command('ui.type', {
        ...resolveTarget(target),
        text,
        clear: options?.clear ?? false,
        timeoutMs: options?.timeoutMs ?? defaultTimeoutMs,
      }),
    waitFor: (target, options: E2EWaitOptions = {}) =>
      driver.command('ui.waitFor', {
        ...resolveTarget(target),
        state: options?.state ?? 'visible',
        timeoutMs: options?.timeoutMs ?? defaultTimeoutMs,
      }),
    isVisible: target => driver.command('ui.isVisible', resolveTarget(target)),
    count: async target => {
      const result = await driver.command<{ count?: unknown }>('ui.count', resolveTarget(target));
      if (typeof result?.count !== 'number' || !Number.isInteger(result.count) || result.count < 0) {
        throw new Error('ui.count returned an invalid payload');
      }
      return result.count;
    },
    getText: async (target, options: E2ETimeoutOptions = {}) => {
      const result = await driver.command<{ text?: unknown }>('ui.getText', {
        ...resolveTarget(target),
        timeoutMs: options?.timeoutMs ?? defaultTimeoutMs,
      });
      if (typeof result?.text !== 'string') {
        throw new Error('ui.getText returned a non-string payload');
      }
      return result.text;
    },
    getAttribute: async (target, attribute: string, options: E2ETimeoutOptions = {}) => {
      const result = await driver.command<{ value?: unknown }>('ui.getAttribute', {
        ...resolveTarget(target),
        attribute,
        timeoutMs: options?.timeoutMs ?? defaultTimeoutMs,
      });
      if (typeof result?.value === 'string' || result?.value == null) {
        return result.value as string | null;
      }
      throw new Error('ui.getAttribute returned a non-string payload');
    },
    copy: (target, options: E2ETimeoutOptions = {}) =>
      driver.command('ui.copy', {
        ...resolveTarget(target),
        timeoutMs: options?.timeoutMs ?? defaultTimeoutMs,
      }),
    paste: (target, options: E2EClipboardOptions = {}) =>
      driver.command('ui.paste', {
        ...resolveTarget(target),
        clear: options?.clear ?? false,
        timeoutMs: options?.timeoutMs ?? defaultTimeoutMs,
      }),
    setData: (key, value) => {
      data.set(key, value);
    },
    getData: <T = unknown>(key: string) => data.get(key) as T | undefined,
  };

  await flow.run(runtime);

  return {
    data: Object.fromEntries(data.entries()),
  };
}

export type { E2EFlowDefinition, E2ECommandArgs } from './types.js';
