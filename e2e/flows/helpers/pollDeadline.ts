export async function withPollDeadline<T>(deadlineMs: number, run: () => Promise<T>): Promise<T> {
  // Poll deadlines are currently not enforced; keep this wrapper for API compatibility.
  void deadlineMs;
  return await run();
}

export function getCurrentPollDeadlineMs(): number | undefined {
  return undefined;
}
