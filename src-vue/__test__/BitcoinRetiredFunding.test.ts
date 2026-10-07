import { afterEach, describe, expect, it, vi } from 'vitest';
import { BitcoinLock, type BlockWatch } from '@argonprotocol/apps-core';
import { reactive } from 'vue';
import { BitcoinNetwork, getChildXpriv } from '@argonprotocol/bitcoin';
import { u8aToHex } from '@argonprotocol/mainchain';
import type { Db } from '../lib/Db.ts';
import BitcoinMempool from '../lib/BitcoinMempool.ts';
import { WalletForBitcoin } from '../lib/WalletForBitcoin.ts';
import { BitcoinLockStatus } from '../interfaces/IBitcoinLockRecord.ts';
import { getMainchainClient } from '../stores/mainchain.ts';
import { createTestDbAtMigration } from './helpers/db.ts';
import {
  createBitcoinLockConfig,
  createCurrentLock,
  createLock,
  createStore,
  historyBlock,
} from './helpers/bitcoin.ts';

vi.mock('../stores/mainchain.ts', () => ({ getMainchainClient: vi.fn() }));
afterEach(() => {
  vi.restoreAllMocks();
});

async function createFundingScenario(db: Db) {
  const block = { ...historyBlock(100), blockTime: Date.now() };
  const native = createCurrentLock({
    lockId: 7,
    fundedSatoshis: 0n,
    fundingUtxos: [],
    createdAtHeight: 100,
    securitizationHoldExpirationBitcoinHeight: 106,
  });
  for (const [index, field] of (['vaultPubkey', 'vaultClaimPubkey', 'ownerPubkey'] as const).entries()) {
    native[field] = u8aToHex(
      getChildXpriv(new Uint8Array(32).fill(index + 1), 'm/0', BitcoinNetwork.Bitcoin).publicKey,
    );
  }
  const client = {
    consts: { bitcoinLocks: { argonTicksPerDay: { toNumber: () => 1_440 } } },
    query: {
      bitcoinLocks: { orphanedUtxosByAccount: { entries: async () => [] } },
      bitcoinUtxos: {
        confirmedBitcoinBlockTip: async () => ({ blockHeight: 120 }),
      },
    },
  };
  const blockWatch = {
    finalizedBlockHeader: block,
    bestBlockHeader: block,
    start: async () => undefined,
    events: { on: () => () => undefined },
    getApi: vi.fn(async () => client),
    getFinalizedApi: async () => client,
    getEventsWithSpec: async () => ({ api: client, events: [] }),
  };
  const mempool = new BitcoinMempool();
  vi.spyOn(mempool, 'getAddressUtxos').mockResolvedValue([]);
  vi.spyOn(mempool, 'getTipHeight').mockResolvedValue(130);
  const store = createStore({ db, blockWatch: blockWatch as unknown as BlockWatch, mempool });
  store.data = reactive(store.data);
  store.utxoTracking.data = reactive(store.utxoTracking.data);
  const template = createLock({
    uuid: 'synthetic-channel',
    utxoId: 7,
    status: BitcoinLockStatus.LockPendingFunding,
    createdAt: '2026-01-01',
  });
  template.fundedSatoshis = 0n;
  Object.assign(template.scriptDetails!, native);
  native.p2wshScriptHashHex = store.createCosignScript({ lock: template, fundedSatoshis: 0n }).calculateScriptPubkey();
  template.scriptDetails!.p2wshScriptHashHex = native.p2wshScriptHashHex;
  const getLock = vi.spyOn(BitcoinLock, 'get').mockResolvedValue(new BitcoinLock(native));
  const idsByOwner = vi.spyOn(BitcoinLock, 'idsByOwner').mockResolvedValue([7]);
  vi.spyOn(BitcoinLock, 'getConfig').mockResolvedValue(createBitcoinLockConfig());
  vi.mocked(getMainchainClient).mockResolvedValue(client as unknown as Awaited<ReturnType<typeof getMainchainClient>>);
  const wallet = new WalletForBitcoin(
    () => store,
    () => native.ownerAccount,
    {} as never,
  );
  return {
    db,
    store,
    wallet,
    native,
    template,
    getLock,
    idsByOwner,
    block,
    blockWatch,
    mempool,
    client,
  };
}

describe('Historically expired Bitcoin funding', () => {
  it.each(['LockExpiredWaitingForFunding', 'LockExpiredWaitingForFundingAcknowledged'])(
    'repairs %s during upgrade and keeps its address retired after restart',
    async expiredStatus => {
      const { db, migrateToLatest } = await createTestDbAtMigration(32);
      const scenario = await createFundingScenario(db);
      await db.execute(
        `INSERT INTO BitcoinLocks (
      uuid, status, utxoId, satoshis, lockedTargetPrice, liquidityPromised, ratchets,
      cosignVersion, lockDetails, network, hdPath, vaultId
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          scenario.template.uuid,
          'LockPendingFunding',
          7,
          10_000n,
          2_000n,
          0n,
          [],
          'v1',
          { ...scenario.template.scriptDetails, ownerAccount: scenario.native.ownerAccount },
          'testnet',
          scenario.template.hdPath,
          1,
        ],
      );
      await db.execute(`UPDATE BitcoinLocks SET status = ? WHERE uuid = ?`, [expiredStatus, scenario.template.uuid]);
      await migrateToLatest();
      scenario.getLock.mockResolvedValue(undefined);
      scenario.idsByOwner.mockResolvedValue([]);
      await scenario.store.load();
      const lock = scenario.store.getLockById(7)!;
      scenario.store.confirmAddress(lock);
      // This is the original defect: a valid old script was offered as a receive address after upgrade.
      expect(() => scenario.wallet.getChannelFundingAddress(lock)).toThrow(/no longer accepts funding/);
      expect(scenario.wallet.findReusableChannelLock({ vaultId: 1, isOwnedVault: false })).toBeUndefined();

      await vi.waitFor(() => expect(scenario.store.data.isReconciliationPending).toBe(false));
      expect((await db.bitcoinLocksTable.getByLockId(7))?.removalReason).toBe('expired');
      await scenario.store.shutdown();

      const restarted = createStore({
        db,
        blockWatch: scenario.blockWatch as unknown as BlockWatch,
        mempool: scenario.mempool,
      });
      await restarted.load();
      const restartedWallet = new WalletForBitcoin(
        () => restarted,
        () => scenario.native.ownerAccount,
        {} as never,
      );
      expect(restarted.getActiveLocks()).toEqual([]);
      expect(() => restartedWallet.getChannelFundingAddress(restarted.getLockById(7)!)).toThrow(
        /no longer accepts funding/,
      );
      expect((await db.bitcoinLocksTable.getByLockId(7))?.scriptDetails).toEqual(lock.scriptDetails);
      await restarted.shutdown();
    },
  );

  it.each(['no expiration', 'later accepted funding'])(
    'does not retire a current channel with %s during migration',
    async history => {
      const { db, migrateToLatest } = await createTestDbAtMigration(35);
      const scenario = await createFundingScenario(db);
      scenario.native.securitizationCoverageMicrogons = 0n;
      scenario.getLock.mockResolvedValue(new BitcoinLock(scenario.native));
      const pending = await db.bitcoinLocksTable.insertPending(scenario.template);
      const lock = await db.bitcoinLocksTable.finalizePending({ uuid: pending.uuid, lock: scenario.native });
      if (history === 'later accepted funding') {
        await db.execute(`INSERT INTO BitcoinLockStatusHistory (uuid, newStatus) VALUES (?, ?)`, [
          lock.uuid,
          'LockExpiredWaitingForFunding',
        ]);
        await db.bitcoinLocksTable.setStatus(lock, BitcoinLockStatus.LockFunded);
        await db.bitcoinLocksTable.setStatus(lock, BitcoinLockStatus.LockPendingFunding);
      }
      await migrateToLatest();
      await scenario.store.load();
      await vi.waitFor(() => expect(scenario.store.data.isReconciliationPending).toBe(false));
      const current = scenario.store.getLockById(7)!;
      expect(current.removalReason).toBeUndefined();
      expect(scenario.store.isSecuritizationHoldExpired(current)).toBe(true);
      expect(scenario.wallet.findReusableChannelLock({ vaultId: current.vaultId, isOwnedVault: false })).toBe(current);
      expect(scenario.wallet.getChannelFundingAddress(current)).toMatch(/^bc1/);
      await scenario.store.shutdown();
    },
  );
});
