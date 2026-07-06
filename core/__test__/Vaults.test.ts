import { describe, expect, it, vi } from 'vitest';
import { Vaults } from '../src/Vaults.ts';

describe('Vaults load retry', () => {
  it('retries after an initial bootstrap failure', async () => {
    const miningFrames = {
      load: vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(undefined),
    };
    const client = {
      query: {
        vaults: {
          vaultsById: {
            entries: vi.fn().mockResolvedValue([]),
          },
        },
      },
    };
    const mainchainClients = {
      get: vi.fn().mockResolvedValue(client),
    };
    const vaults = new Vaults('dev-docker', {} as any, miningFrames as any, mainchainClients as any);

    await expect(vaults.load()).rejects.toThrow('offline');
    await expect(vaults.load()).resolves.toBeUndefined();

    expect(mainchainClients.get).toHaveBeenCalledTimes(2);
    expect(miningFrames.load).toHaveBeenCalledTimes(2);
    expect(client.query.vaults.vaultsById.entries).toHaveBeenCalledOnce();
  });
});
