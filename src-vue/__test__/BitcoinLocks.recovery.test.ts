import { describe, expect, it } from 'vitest';
import BitcoinLocks from '../lib/BitcoinLocks.ts';
import { BitcoinLockStatus, type IBitcoinLockRecord } from '../lib/db/BitcoinLocksTable.ts';

function createStore() {
  return new BitcoinLocks(
    Promise.resolve({} as any),
    {} as any,
    {
      start: async () => undefined,
      events: { on: () => () => undefined },
      bestBlockHeader: { blockNumber: 0, blockHash: '0x0' },
    } as any,
    { load: async () => undefined, priceIndex: {} } as any,
    { load: async () => undefined, pendingBlockTxInfosAtLoad: [], data: { txInfos: [], txInfosByType: {} } } as any,
  );
}

function createLock(args: {
  uuid: string;
  utxoId?: number;
  status: BitcoinLockStatus;
  vaultId?: number;
  createdAt: string;
}): IBitcoinLockRecord {
  return {
    uuid: args.uuid,
    utxoId: args.utxoId,
    status: args.status,
    satoshis: 10_000n,
    liquidityPromised: 0n,
    lockedMarketRate: 0n,
    ratchets: [],
    cosignVersion: 'v1',
    lockDetails: { p2wshScriptHashHex: '00' } as any,
    fundingUtxoRecordId: null,
    fundingUtxoRecord: undefined,
    network: 'testnet',
    hdPath: "m/84'/0'/0'",
    vaultId: args.vaultId ?? 1,
    createdAt: new Date(args.createdAt),
    updatedAt: new Date(args.createdAt),
  };
}

describe('BitcoinLocks getActiveLocksForVault', () => {
  it('excludes finished locks and sorts newest first', () => {
    const store = createStore();

    store.data.locksByUtxoId = {
      1: createLock({
        uuid: 'released',
        utxoId: 1,
        status: BitcoinLockStatus.Released,
        createdAt: '2026-01-01T00:00:00Z',
      }),
      2: createLock({
        uuid: 'pending',
        utxoId: 2,
        status: BitcoinLockStatus.LockPendingFunding,
        createdAt: '2026-01-03T00:00:00Z',
      }),
      3: createLock({
        uuid: 'minted',
        utxoId: 3,
        status: BitcoinLockStatus.LockedAndMinted,
        createdAt: '2026-01-02T00:00:00Z',
      }),
      4: createLock({
        uuid: 'expired',
        utxoId: 4,
        status: BitcoinLockStatus.LockExpiredWaitingForFunding,
        createdAt: '2026-01-04T00:00:00Z',
      }),
    };

    const active = store.getActiveLocksForVault(1);
    expect(active.map(x => x.uuid)).toEqual(['pending', 'minted']);
  });

  it('includes pending lock for the same vault', () => {
    const store = createStore();

    store.data.pendingLock = createLock({
      uuid: 'pending-init',
      status: BitcoinLockStatus.LockIsProcessingOnArgon,
      createdAt: '2026-01-05T00:00:00Z',
    });
    store.data.locksByUtxoId = {
      1: createLock({
        uuid: 'older-active',
        utxoId: 1,
        status: BitcoinLockStatus.LockPendingFunding,
        createdAt: '2026-01-01T00:00:00Z',
      }),
    };

    const active = store.getActiveLocksForVault(1);
    expect(active.map(x => x.uuid)).toEqual(['pending-init', 'older-active']);
  });
});
