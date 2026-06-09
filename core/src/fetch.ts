export type FetchImplementation = (...args: Parameters<typeof globalThis.fetch>) => ReturnType<typeof globalThis.fetch>;

let fetchImplementation: FetchImplementation | undefined;

export function setFetchImplementation(next?: FetchImplementation): void {
  fetchImplementation = next;
}

export function fetch(...args: Parameters<FetchImplementation>): ReturnType<FetchImplementation> {
  if (fetchImplementation) return fetchImplementation(...args);
  if (typeof globalThis.fetch === 'function') return globalThis.fetch(...args);

  throw new Error('Fetch API is not available in this runtime');
}
