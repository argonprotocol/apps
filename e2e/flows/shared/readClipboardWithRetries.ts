import type { E2EFlowRuntime } from '../types.js';
import { pollEvery } from './utils.js';

interface ReadClipboardWithRetriesOptions {
  label?: string;
  timeoutMs?: number;
  intervalMs?: number;
}

export async function readClipboardWithRetries(
  flow: E2EFlowRuntime,
  triggerCopy: () => Promise<void>,
  isValid: (value: string) => boolean,
  options?: ReadClipboardWithRetriesOptions,
): Promise<string> {
  options ??= {};
  const timeoutMs = options.timeoutMs ?? 10_000;
  const intervalMs = options.intervalMs ?? 250;
  let value = '';
  options.label ??= triggerCopy.toString();

  await pollEvery(
    intervalMs,
    async () => {
      await triggerCopy();
      const clipboard = await flow.run<{ text?: string }>('clipboard.read');
      value = clipboard?.text?.trim() ?? '';
      return isValid(value);
    },
    {
      timeoutMs,
      timeoutMessage: `Timed out reading ${options.label} from clipboard`,
    },
  );

  if (!value) {
    throw new Error(`${options.label}: clipboard value is empty`);
  }
  return value;
}
