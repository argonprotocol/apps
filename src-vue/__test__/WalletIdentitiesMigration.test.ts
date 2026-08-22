import { describe, expect, it } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import Path from 'node:path';
import { JsonExt } from '@argonprotocol/apps-core';
import { createTestDb, TestSqliteDb } from './helpers/db.ts';

const MIGRATIONS_DIR = Path.resolve(__dirname, '../../src-tauri/migrations');
const MIGRATION = '32-wallet-identities';

describe('32-wallet-identities migration', () => {
  it('removes duplicate wallet roles and repairs persisted Argon identities', async () => {
    const db = new TestSqliteDb(':memory:');

    try {
      const migrationDirs = (await readdir(MIGRATIONS_DIR)).sort();
      for (const migrationDir of migrationDirs.filter(x => x < MIGRATION)) {
        await runMigration(db, migrationDir);
      }

      await db.run(
        `INSERT INTO Wallets (
          id, walletType, role, name, address, sortOrder, keyReference, derivationPath,
          secretKind, encryptedSecret, createdAt, updatedAt
        ) VALUES
          (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?),
          (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?),
          (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          10,
          'argon',
          'defaultArgon',
          'Internal App Wallet',
          '5argon',
          0,
          '//vaulting',
          null,
          null,
          null,
          '2026-08-01T00:00:00.000Z',
          '2026-08-02T00:00:00.000Z',
          20,
          'ethereum',
          'defaultEthereum',
          'Default Ethereum',
          '0xcore',
          1,
          null,
          "m/44'/60'/0'/0'/0'",
          'coreMnemonic',
          null,
          '2026-08-03T00:00:00.000Z',
          '2026-08-04T00:00:00.000Z',
          30,
          'ethereum',
          'externalEthereum',
          'Imported Wallet',
          '0xexternal',
          2,
          null,
          null,
          'privateKey',
          'encrypted-secret',
          '2026-08-05T00:00:00.000Z',
          '2026-08-06T00:00:00.000Z',
        ],
      );

      const transactionBase = ['{}', '5argon', '2026-08-07T00:00:00.000Z', 1];
      await db.run(
        `INSERT INTO Transactions (
          extrinsicHash, extrinsicMethodJson, extrinsicType, metadataJson,
          accountAddress, submittedAtTime, submittedAtBlockHeight
        ) VALUES (?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?)`,
        [
          '0xoutbound',
          transactionBase[0],
          'CrosschainTransferTransferOut',
          JsonExt.stringify({ sourceWalletType: 'defaultArgon', amount: 10n, note: 'defaultArgon' }),
          ...transactionBase.slice(1),
          '0xactivate',
          transactionBase[0],
          'OperationalActivateAndClaim',
          JsonExt.stringify({ rewardAccount: 'defaultArgon', claimedMicrogons: 20n }),
          ...transactionBase.slice(1),
          '0xclaim',
          transactionBase[0],
          'OperationalClaimRewards',
          JsonExt.stringify({ claimAccount: 'defaultArgon', amount: 30n }),
          ...transactionBase.slice(1),
          '0xunrelated',
          transactionBase[0],
          'Transfer',
          JsonExt.stringify({ sourceWalletType: 'defaultArgon' }),
          ...transactionBase.slice(1),
        ],
      );
      await db.run(
        `INSERT INTO WalletTransfers (
          walletAddress, walletName, amount, currency, transferType, isInternal,
          extrinsicIndex, microgonsForArgonot, microgonsForUsd, blockNumber, blockHash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ['5argon', 'defaultArgon', '10', 'argon', 'faucet', 0, 0, '1000000', '1000000', 1, '0xblock'],
      );

      await runMigration(db, MIGRATION);

      const columns = await db.all<{ name: string }[]>('PRAGMA table_info(Wallets)');
      expect(columns.map(column => column.name)).not.toContain('role');
      await expect(db.all('SELECT role FROM Wallets')).rejects.toThrow();

      const wallets = await db.all<
        {
          id: number;
          walletType: string;
          name: string;
          address: string;
          sortOrder: number;
          keyReference: string | null;
          derivationPath: string | null;
          secretKind: string | null;
          encryptedSecret: string | null;
          createdAt: string;
          updatedAt: string;
        }[]
      >('SELECT * FROM Wallets ORDER BY id');
      expect(wallets).toEqual([
        expect.objectContaining({
          id: 10,
          walletType: 'argon',
          name: 'Internal App Wallet',
          address: '5argon',
          sortOrder: 0,
          keyReference: '//vaulting',
          derivationPath: null,
          secretKind: null,
          encryptedSecret: null,
          createdAt: '2026-08-01T00:00:00.000Z',
          updatedAt: '2026-08-02T00:00:00.000Z',
        }),
        expect.objectContaining({
          id: 20,
          walletType: 'ethereum',
          address: '0xcore',
          sortOrder: 1,
          derivationPath: "m/44'/60'/0'/0'/0'",
          secretKind: 'coreMnemonic',
          encryptedSecret: null,
        }),
        expect.objectContaining({
          id: 30,
          walletType: 'ethereum',
          address: '0xexternal',
          sortOrder: 2,
          secretKind: 'privateKey',
          encryptedSecret: 'encrypted-secret',
        }),
      ]);

      const transactionMetadata = await db.all<{ extrinsicHash: string; metadataJson: string }[]>(
        'SELECT extrinsicHash, metadataJson FROM Transactions ORDER BY id',
      );
      expect(transactionMetadata.map(record => [record.extrinsicHash, JsonExt.parse(record.metadataJson)])).toEqual([
        ['0xoutbound', { sourceWalletType: 'argon', amount: 10n, note: 'defaultArgon' }],
        ['0xactivate', { rewardAccount: 'argon', claimedMicrogons: 20n }],
        ['0xclaim', { claimAccount: 'argon', amount: 30n }],
        ['0xunrelated', { sourceWalletType: 'defaultArgon' }],
      ]);
      await expect(db.get('SELECT walletName FROM WalletTransfers')).resolves.toEqual({ walletName: 'argon' });

      await expect(
        db.run(`INSERT INTO Wallets (walletType, name, address) VALUES ('argon', 'Duplicate', '5duplicate')`),
      ).rejects.toThrow();
      await expect(
        db.run(
          `INSERT INTO Wallets (walletType, name, address, secretKind)
           VALUES ('ethereum', 'Missing Secret', '0xmissing', 'privateKey')`,
        ),
      ).rejects.toThrow();
    } finally {
      await db.close();
    }
  });

  it('does not store an imported secret for the secured core Ethereum address', async () => {
    const db = await createTestDb();

    try {
      await expect(
        db.walletsTable.importExternalEthereum({
          name: 'Duplicate Core',
          address: '0xcore',
          coreEthereumAddress: '0xCORE',
          secretKind: 'privateKey',
          encryptedSecret: 'encrypted-secret',
        }),
      ).rejects.toThrow("This is already the app's core Ethereum wallet.");
      await expect(db.walletsTable.fetchEthereumWallets()).resolves.toEqual([]);
    } finally {
      await db.close();
    }
  });
});

async function runMigration(db: TestSqliteDb, migrationDir: string): Promise<void> {
  const migrationSql = await readFile(Path.join(MIGRATIONS_DIR, migrationDir, 'up.sql'), 'utf8');
  await db.exec(migrationSql);
}
