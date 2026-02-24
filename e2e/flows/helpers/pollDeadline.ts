class PollDeadlineExceededError extends Error {
  readonly deadlineMs: number;

  constructor(deadlineMs: number) {
    super(`Polling check exceeded deadline (${deadlineMs})`);
    this.name = 'PollDeadlineExceededError';
    this.deadlineMs = deadlineMs;
  }
}

let currentPollDeadlineMs: number | undefined;

export async function withPollDeadline<T>(deadlineMs: number, run: () => Promise<T>): Promise<T> {
  const remainingMs = deadlineMs - Date.now();
  if (remainingMs <= 0) {
    throw new PollDeadlineExceededError(deadlineMs);
  }

  const previousPollDeadlineMs = currentPollDeadlineMs;
  currentPollDeadlineMs = deadlineMs;

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new PollDeadlineExceededError(deadlineMs)), remainingMs);
  });

  try {
    return await Promise.race([run(), timeout]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    currentPollDeadlineMs = previousPollDeadlineMs;
  }
}

export function isPollDeadlineExceededError(error: unknown): boolean {
  return error instanceof PollDeadlineExceededError;
}

export function getCurrentPollDeadlineMs(): number | undefined {
  return currentPollDeadlineMs;
}
