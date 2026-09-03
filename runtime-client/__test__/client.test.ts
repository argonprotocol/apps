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

  it('normalizes direct and subscription results from an installed query', async () => {
    const registry = new TypeRegistry();
    const direct = registry.createType('Option<u128>', 9);
    const unsubscribe = vi.fn();
    const query = vi.fn((...args: unknown[]) => {
      const callback = args.at(-1);
      if (typeof callback === 'function') {
        (callback as (value: unknown) => void)(direct);
        return Promise.resolve(unsubscribe);
      }
      return Promise.resolve(direct);
    });
    const client = runtimeClient({ query: { treasury: { bondLotById: query } } });
    const callback = vi.fn();

    await expect(client.query.treasury.bondLotById(1n)).resolves.toBe(9n);
    await expect(client.query.treasury.bondLotById(1n, callback)).resolves.toBe(unsubscribe);
    expect(callback).toHaveBeenCalledWith(9n);
  });

  it('forwards every storage key through a historical client query', async () => {
    const registry = new TypeRegistry();
    const lastFeeCouponNonceByVaultAndAccount = vi.fn(() => Promise.resolve(registry.createType('Option<u128>', 9)));
    const historicalApi = {
      query: { bitcoinLocks: { lastFeeCouponNonceByVaultAndAccount } },
    };
    const at = vi.fn((_blockHash: string) => Promise.resolve(historicalApi));
    const client = runtimeClient({ at, query: {} });

    const historicalClient = await client.at('0x1234');
    const result = historicalClient.query.bitcoinLocks.lastFeeCouponNonceByVaultAndAccount(7, 'owner-account');

    await expect(result).resolves.toBe(9n);
    expect(at).toHaveBeenCalledWith('0x1234');
    expect(lastFeeCouponNonceByVaultAndAccount).toHaveBeenCalledWith(7, 'owner-account');
  });
});
