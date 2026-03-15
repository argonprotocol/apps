export interface IWaitForOptions {
  pollMs?: number;
  retryErrors?: boolean;
  timeoutMessage?: string;
}

export async function waitFor<T>(
  timeoutMs: number,
  label: string,
  check: () => Promise<T | boolean | undefined | null> | T | boolean | undefined | null,
  options: IWaitForOptions = {},
): Promise<T> {
  const pollMs = options.pollMs ?? 500;
  const retryErrors = options.retryErrors ?? true;
  const startedAt = Date.now();
  let lastError: unknown;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const result = await check();
      if (result === true) {
        return true as T;
      }
      if (result !== undefined && result !== null && result !== false) {
        return result as T;
      }
    } catch (error) {
      if (!retryErrors) {
        throw error;
      }
      lastError = error;
    }

    await new Promise(resolve => setTimeout(resolve, pollMs));
  }

  const errorSuffix = lastError ? ` (${String(lastError)})` : '';
  throw new Error(options.timeoutMessage ?? `${label} timed out after ${timeoutMs}ms${errorSuffix}`);
}
