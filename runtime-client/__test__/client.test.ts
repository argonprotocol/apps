import { TypeRegistry } from '@polkadot/types/create';
import { describe, expect, it, vi } from 'vitest';
import { runtimeClient } from '../src/client.ts';

describe('runtimeClient', () => {
  it('returns null synchronously when a query is absent from the supplied API', () => {
    const client = runtimeClient({ query: {} });

    expect(client.query.treasury.bondLotById(1n)).toBeNull();
  });

  it('keeps storage Option::None distinct from an absent query', async () => {
    const registry = new TypeRegistry();
    const bondLotById = vi.fn(() => Promise.resolve(registry.createType('Option<u128>', null)));
    const client = runtimeClient({ query: { treasury: { bondLotById } } });

    const result = client.query.treasury.bondLotById(1n);

    expect(result).toBeInstanceOf(Promise);
    await expect(result).resolves.toBeNull();
  });

  it('normalizes direct, multi, and subscription results from an installed query', async () => {
    const registry = new TypeRegistry();
    const direct = registry.createType('Option<u128>', 9);
    const unsubscribe = vi.fn();
    const query = Object.assign(
      vi.fn((...args: unknown[]) => {
        const callback = args.at(-1);
        if (typeof callback === 'function') {
          (callback as (value: unknown) => void)(direct);
          return Promise.resolve(unsubscribe);
        }
        return Promise.resolve(direct);
      }),
      {
        multi: vi.fn(() => Promise.resolve([direct, registry.createType('Option<u128>', null)])),
      },
    );
    const client = runtimeClient({ query: { treasury: { bondLotById: query } } });
    const callback = vi.fn();

    await expect(client.query.treasury.bondLotById(1n)).resolves.toBe(9n);
    await expect(client.query.treasury.bondLotById.multi([[1n], [2n]])).resolves.toEqual([9n, null]);
    await expect(client.query.treasury.bondLotById(1n, callback)).resolves.toBe(unsubscribe);
    expect(callback).toHaveBeenCalledWith(9n);
  });
});
