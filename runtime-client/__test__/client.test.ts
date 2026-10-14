import { TypeRegistry } from '@polkadot/types/create';
import { Metadata } from '@polkadot/types';
import { decorateConstants, decorateStorage } from '@polkadot/types/metadata/decorate';
import BigNumber from 'bignumber.js';
import { getBundledMetadata } from '../src/index.ts';
import { describe, expect, it, vi } from 'vitest';
import { runtimeClient } from '../src/client.ts';

describe('runtimeClient', () => {
  it.each([159, 160])('reads native constants and bond IDs from runtime %s metadata', async spec => {
    const registry = new TypeRegistry();
    const metadata = new Metadata(
      registry,
      Object.entries(getBundledMetadata()).find(([key]) => key.endsWith(`-${spec}`))![1],
    );
    registry.setMetadata(metadata);
    const storage = decorateStorage(registry, metadata.asLatest, metadata.version);
    const accountId = registry.createType('AccountId32', `0x${'11'.repeat(32)}`);
    const accountKey = registry.createType('StorageKey', [storage.treasury.bondLotIdsByAccount, [accountId, 7]]);
    const treasury = {
      bondLotIdsByAccount: Object.assign(vi.fn(), { keys: async () => [accountKey] }),
      ...(spec === 160
        ? {
            bondLotIdsByVault: Object.assign(vi.fn(), {
              keys: async () => [registry.createType('StorageKey', [storage.treasury.bondLotIdsByVault, [4, 7]])],
            }),
          }
        : {}),
    };
    const raw = { query: { treasury }, consts: decorateConstants(registry, metadata.asLatest, metadata.version) };
    const client = runtimeClient(raw);
    expect('treasuryPositions' in storage).toBe(spec === 160);
    expect('totalActiveArgonotBonds' in storage.treasury).toBe(spec === 159);
    expect('bitcoinLiquidityTolerance' in client.consts.operationalAccounts).toBe(spec === 160);
    expect(client.consts.balances.existentialDeposit).toBe(BigInt(raw.consts.balances.existentialDeposit.toString()));
    expect(typeof client.consts.bitcoinLocks.maxBtcPriceTickAge).toBe('number');
    expect(client.consts.bitcoinLocks.lockReleaseCosignDeadlineFrames).toBe(10);
    expect(client.consts.bitcoinLocks.securitizationHoldBlocks).toBe(144);
    expect(client.consts.vaults.revenueCollectionExpirationFrames).toBe(10);
    expect(client.consts.blockRewards.minerPayoutPercent).toEqual(new BigNumber(0.75));
    expect(typeof client.consts.treasury.palletId).toBe('string');
    expect('securitizationExitNoticeBlocks' in client.consts.vaults).toBe(spec === 160);
    if ('percentForVaultPool' in client.consts.treasury) {
      expect(client.consts.treasury.percentForVaultPool).toEqual(new BigNumber(0.51));
      expect(client.consts.vaults).toHaveProperty('securitizationExitNoticeBlocks');
    } else {
      expect(client.consts.treasury.percentForTreasuryReserves).toBeInstanceOf(BigNumber);
    }
    const accountKeys = await client.query.treasury.bondLotIdsByAccount.keys(accountId);
    expect(accountKeys[0].args).toEqual([accountId.toString(), 7]);
    if (spec === 160) {
      const vaultKeys = await client.query.treasury.bondLotIdsByVault.keys(4);
      expect(vaultKeys?.[0].args).toEqual([4, 7]);
    }
  });

  it('reflects installed query presence through nested sections', () => {
    const client = runtimeClient({ query: { treasury: { currentFrameArgonotBondParticipants: vi.fn() } } });

    expect('currentFrameArgonotBondParticipants' in client.query.treasury).toBe(true);
    expect('bondLotById' in client.query.treasury).toBe(false);
  });

  it('normalizes Treasury positions and upstream participation from published runtime metadata', async () => {
    const registry = new TypeRegistry();
    const metadata = new Metadata(
      registry,
      Object.entries(getBundledMetadata()).find(([key]) => key.endsWith('-160'))![1],
    );
    registry.setMetadata(metadata);
    const positionsByAccount = registry.createType('Option<PalletTreasuryPositionsPosition>', {
      bondPrincipal: 2_500_000_000n,
      quantities: { bonds: 9_007_199_254_740_993n, stakes: 42, fissionLiquidity: 3_000_000_000n },
      upstream: {
        vaultId: 4,
        bitcoinSecuritization: 1_000_000_000n,
        bitcoinAllocatedSecuritization: 2_000_000_000n,
        bondPrincipal: 500_000_000n,
      },
    });
    const currentFrameVaultCapital = registry.createType('Option<PalletTreasuryFrameVaultCapital>', {
      frameId: 7,
      vaultSecuritizationPositions: {
        4: { operatorAccountId: new Uint8Array(32).fill(1), upstreamParticipation: 250_000_000_000_000_000n },
      },
    });
    const client = runtimeClient({
      query: {
        treasuryPositions: { positionsByAccount: async () => positionsByAccount },
        treasury: { currentFrameVaultCapital: async () => currentFrameVaultCapital },
      },
      consts: decorateConstants(registry, metadata.asLatest, metadata.version),
    });

    expect(await client.query.treasuryPositions.positionsByAccount(new Uint8Array(32).fill(1))).toMatchObject({
      bondPrincipal: 2_500_000_000n,
      quantities: { bonds: 9_007_199_254_740_993n, stakes: 42n, fissionLiquidity: 3_000_000_000n },
      upstream: {
        vaultId: 4,
        bitcoinSecuritization: 1_000_000_000n,
        bitcoinAllocatedSecuritization: 2_000_000_000n,
        bondPrincipal: 500_000_000n,
      },
    });
    const frameCapital = await client.query.treasury.currentFrameVaultCapital();
    expect(frameCapital).toMatchObject({
      frameId: 7,
      vaultSecuritizationPositions: { 4: { upstreamParticipation: new BigNumber('0.25') } },
    });
    expect('bitcoinLockDurationBlocks' in client.consts.vaults).toBe(true);
    if ('bitcoinLockDurationBlocks' in client.consts.vaults) {
      expect(client.consts.vaults.bitcoinLockDurationBlocks).toBe(
        Number(client.consts.bitcoinLocks.lockDurationBlocks),
      );
    }
  });

  it('refreshes retained constant sections when runtime metadata is replaced', () => {
    const constants = [159, 160].map(spec => {
      const registry = new TypeRegistry();
      const metadata = new Metadata(
        registry,
        Object.entries(getBundledMetadata()).find(([key]) => key.endsWith(`-${spec}`))![1],
      );
      registry.setMetadata(metadata);
      return decorateConstants(registry, metadata.asLatest, metadata.version);
    });
    const raw = { query: {}, consts: constants[0] };
    const client = runtimeClient(raw);
    const treasury = client.consts.treasury;
    const vaults = client.consts.vaults;
    expect('percentForVaultPool' in treasury).toBe(false);
    expect('securitizationExitNoticeBlocks' in vaults).toBe(false);
    raw.consts = constants[1];
    expect('percentForVaultPool' in treasury).toBe(true);
    expect('securitizationExitNoticeBlocks' in vaults).toBe(true);
    if ('percentForVaultPool' in treasury) expect(treasury.percentForVaultPool).toEqual(new BigNumber(0.51));
  });

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
