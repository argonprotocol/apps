import { afterEach, describe, expect, it, vi } from 'vitest';
import { WalletForEthereum } from '../lib/WalletForEthereum.ts';
import { WalletsForEthereum } from '../lib/WalletsForEthereum.ts';
import { createTestDb } from './helpers/db.ts';

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
