import type { IE2EFlowRuntime } from '../types.ts';
import { pollEvery } from './utils.ts';

interface IReadClipboardWithRetriesOptions {
  label?: string;
  timeoutMs?: number;
  intervalMs?: number;
}

export async function readClipboardWithRetries(
  flow: IE2EFlowRuntime,
  triggerCopy: () => Promise<void>,
  isValid: (value: string) => boolean,
  options?: IReadClipboardWithRetriesOptions,
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
