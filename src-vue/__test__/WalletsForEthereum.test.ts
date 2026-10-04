import { afterEach, describe, expect, it, vi } from 'vitest';
import { WalletForEthereum } from '../lib/WalletForEthereum.ts';
import { WalletsForEthereum } from '../lib/WalletsForEthereum.ts';
import { FinancialCacheTypes } from '../lib/db/FinancialCacheTable.ts';
import { createTestDb } from './helpers/db.ts';
import { nextTick, reactive, watchEffect } from 'vue';
import { createDeferred } from '@argonprotocol/apps-core';

const coreAddress = '0x0000000000000000000000000000000000000001';
const externalAddress = '0x0000000000000000000000000000000000000002';

afterEach(() => vi.restoreAllMocks());

describe('WalletsForEthereum', () => {
  it('always owns the core wallet without exposing or persisting it while it is empty', async () => {
    const db = await createTestDb();
    vi.spyOn(WalletForEthereum.prototype, 'load').mockResolvedValue();
    const wallets = createWallets(db);

    try {
      expect(wallets.coreWallet.address).toBe(coreAddress);
      expect(wallets.coreWallet.isPersisted).toBe(false);
      expect(wallets.persistedWallets).toEqual([]);

      await wallets.load();

      expect(await db.walletsTable.fetchEthereumWallets()).toEqual([]);
      expect(wallets.persistedWallets).toEqual([]);
      await expect(wallets.resolve(coreAddress.toUpperCase())).resolves.toBe(wallets.coreWallet);
    } finally {
      wallets.dispose();
      await db.close();
    }
  });

  it('persists and publishes the existing core object only after discovering value', async () => {
    const db = await createTestDb();
    vi.spyOn(WalletForEthereum.prototype, 'load').mockImplementation(async function (this: WalletForEthereum) {
      if (this.isCore) this.data.availableMicrogons = 1n;
    });
    const wallets = createWallets(db);
    const coreWallet = wallets.coreWallet;

    try {
      await wallets.load();

      expect(wallets.coreWallet).toBe(coreWallet);
      expect(wallets.persistedWallets).toEqual([coreWallet]);
      expect(coreWallet.isPersisted).toBe(true);
      expect((await db.walletsTable.fetchEthereumWallets()).map(record => record.address)).toEqual([coreAddress]);
    } finally {
      wallets.dispose();
      await db.close();
    }
  });

  it('preserves canonical wallet identity while reconciling persisted records', async () => {
    const db = await createTestDb();
    vi.spyOn(WalletForEthereum.prototype, 'load').mockResolvedValue();
    const record = await db.walletsTable.importExternalEthereum({
      name: 'External',
      address: externalAddress,
      coreEthereumAddress: coreAddress,
      secretKind: 'privateKey',
      encryptedSecret: 'encrypted',
    });
    const wallets = createWallets(db);

    try {
      await wallets.load();
      const wallet = wallets.get(record.id);

      await wallets.load();

      expect(wallets.get(record.id)).toBe(wallet);
      expect(wallets.findByAddress(externalAddress.toUpperCase())).toBe(wallet);
    } finally {
      wallets.dispose();
      await db.close();
    }
  });

  it('persists a renamed wallet and updates mounted observers without replacing the wallet or its credentials', async () => {
    const db = await createTestDb();
    const record = await db.walletsTable.importExternalEthereum({
      name: 'External',
      address: externalAddress,
      coreEthereumAddress: coreAddress,
      secretKind: 'mnemonic',
      encryptedSecret: 'encrypted',
      derivationPath: "m/44'/60'/0'/0/1",
    });
    const wallets = createWallets(db);
    await wallets.loadCachedBalances();
    const wallet = wallets.get(record.id);
    wallet.data.availableMicrogons = 11n;
    let visibleName = '';
    const stop = watchEffect(() => {
      visibleName = reactive(wallet).name;
    });
    let restored: WalletsForEthereum | undefined;
    const snapshotRead = createDeferred<void>(false);
    const releaseRead = createDeferred<void>(false);
    const renameSaved = createDeferred<void>(false);
    const fetchRecords = db.walletsTable.fetchEthereumWallets.bind(db.walletsTable);
    vi.spyOn(db.walletsTable, 'fetchEthereumWallets').mockImplementationOnce(async () => {
      const records = await fetchRecords();
      snapshotRead.resolve();
      await releaseRead.promise;
      return records;
    });
    const saveName = db.walletsTable.renameEthereumWallet.bind(db.walletsTable);
    vi.spyOn(db.walletsTable, 'renameEthereumWallet').mockImplementationOnce(async (...args) => {
      const renamedRecord = await saveName(...args);
      renameSaved.resolve();
      return renamedRecord;
    });
    const reload = wallets.loadCachedBalances();

    try {
      await snapshotRead.promise;
      const rename = wallets.rename(wallet, '  Trading Wallet  ');
      await renameSaved.promise;
      releaseRead.resolve();
      await Promise.all([rename, reload]);
      await nextTick();

      expect(visibleName).toBe('Trading Wallet');
      expect(wallets.get(record.id)).toBe(wallet);
      expect(wallet.data.availableMicrogons).toBe(11n);
      expect((await db.walletsTable.fetchEthereumWallets())[0]).toMatchObject({
        ...record,
        name: 'Trading Wallet',
        updatedAt: expect.any(Date),
      });

      wallets.dispose();
      restored = createWallets(db);
      await restored.loadCachedBalances();
      expect(restored.get(record.id).name).toBe('Trading Wallet');
      expect(restored.get(record.id).record?.encryptedSecret).toBe('encrypted');
    } finally {
      releaseRead.resolve();
      await reload;
      stop();
      wallets.dispose();
      restored?.dispose();
      await db.close();
    }
  });

  it('keeps the saved and visible wallet name after a failed rename and permits a retry', async () => {
    const db = await createTestDb();
    const record = await db.walletsTable.createDefaultEthereum({
      address: coreAddress,
      derivationPath: "m/44'/60'/0'/0/0",
    });
    const wallets = createWallets(db);
    await wallets.loadCachedBalances();
    const wallet = wallets.get(record.id);
    const write = vi.spyOn(db.walletsTable, 'renameEthereumWallet');
    write.mockRejectedValueOnce(new Error('Synthetic database write failure'));

    try {
      await expect(wallets.rename(wallet, 'New Name')).rejects.toThrow('Synthetic database write failure');
      expect(wallet.name).toBe(record.name);
      expect((await db.walletsTable.fetchEthereumWallets())[0].name).toBe(record.name);
      await expect(wallets.rename(wallet, '   ')).rejects.toThrow('Enter a wallet name.');
      await expect(wallets.rename(wallet, 'A'.repeat(19))).rejects.toThrow('18 characters');
      expect(wallet.name).toBe(record.name);
      expect((await db.walletsTable.fetchEthereumWallets())[0].name).toBe(record.name);

      await wallets.rename(wallet, 'New Name');
      expect(wallets.coreWallet).toBe(wallet);
      expect(wallet.name).toBe('New Name');
      expect((await db.walletsTable.fetchEthereumWallets())[0].name).toBe('New Name');
    } finally {
      wallets.dispose();
      await db.close();
    }
  });

  it('restores persisted Ethereum balances before the network refresh', async () => {
    const db = await createTestDb();
    const record = await db.walletsTable.importExternalEthereum({
      name: 'External',
      address: externalAddress,
      coreEthereumAddress: coreAddress,
      secretKind: 'privateKey',
      encryptedSecret: 'encrypted',
    });
    await db.financialCacheTable.upsert(FinancialCacheTypes.ExternalWalletBalance, `ethereum:${externalAddress}`, {
      chain: 'ethereum',
      address: externalAddress,
      availableMicrogons: 11n,
      availableMicronots: 22n,
      otherTokens: [],
      observedAt: new Date('2026-08-29T12:00:00.000Z'),
    });
    const wallets = createWallets(db);

    try {
      await wallets.loadCachedBalances();

      expect(wallets.get(record.id).data).toMatchObject({
        availableMicrogons: 11n,
        availableMicronots: 22n,
        totalMicrogons: 11n,
        totalMicronots: 22n,
        balanceIsCached: true,
      });
    } finally {
      wallets.dispose();
      await db.close();
    }
  });

  it('removes a disconnected wallet from persistence and the live collection', async () => {
    const db = await createTestDb();
    vi.spyOn(WalletForEthereum.prototype, 'load').mockResolvedValue();
    const record = await db.walletsTable.importExternalEthereum({
      name: 'External',
      address: externalAddress,
      coreEthereumAddress: coreAddress,
      secretKind: 'privateKey',
      encryptedSecret: 'encrypted',
    });
    const wallets = createWallets(db);

    try {
      await wallets.load();
      const wallet = wallets.get(record.id);

      await wallets.disconnect(wallet);

      expect(wallets.find(record.id)).toBeUndefined();
      expect(wallets.persistedWallets).not.toContain(wallet);
      expect(await db.walletsTable.fetchEthereumWallets()).toEqual([]);
    } finally {
      wallets.dispose();
      await db.close();
    }
  });
});

function createWallets(db: Awaited<ReturnType<typeof createTestDb>>) {
  return new WalletsForEthereum(
    {
      coreEthereumAddress: coreAddress,
      isCoreEthereumWallet: record => record?.address.toLowerCase() === coreAddress,
    },
    Promise.resolve(db),
    Promise.resolve(db.financialCacheTable),
  );
}
