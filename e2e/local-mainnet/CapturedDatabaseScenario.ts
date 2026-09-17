import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import Path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { LocalMainnet } from './LocalMainnet.ts';
import type { RuntimeMigrationManifest } from './manifest.ts';

export interface ReadonlyAccountExpectations {
  configuredServer: boolean;
  operations: boolean;
  upstream: boolean;
  vault: boolean;
}

export interface CapturedDatabaseBeforeMigration {
  latestMigration: number;
  walletIdentitySha256: string;
  migratableBitcoinLockIds: number[];
  readonlyAccount: ReadonlyAccountExpectations;
}

export interface CapturedDatabaseAfterMigration {
  latestMigration: number;
  quickCheck: string;
  walletIdentitySha256: string;
  fundedBitcoinLockIds: number[];
  fundingBitcoinUtxoIds: number[];
  migratedBitcoinFissionIds: number[];
}

export interface CapturedDatabaseScenarioResult {
  before: CapturedDatabaseBeforeMigration;
  afterMigration: CapturedDatabaseAfterMigration;
  afterRestart: CapturedDatabaseAfterMigration;
  instanceName: string;
  instancePackagePath: string;
}

export class CapturedDatabaseScenario {
  public static async run(args: {
    manifest: RuntimeMigrationManifest;
    mainnet: LocalMainnet;
    appsDirectory: string;
    runDirectory: string;
  }): Promise<CapturedDatabaseScenarioResult> {
    const { manifest, mainnet, appsDirectory, runDirectory } = args;
    if (!Path.isAbsolute(runDirectory)) {
      throw new Error('Captured database runDirectory must be an absolute path');
    }

    const sourceDatabasePath = Path.join(manifest.capturedDatabase.instancePackagePath, 'database.sqlite');
    const before = CapturedDatabaseScenario.inspectBeforeMigration(sourceDatabasePath);
    const instanceSuffix = createHash('sha256').update(runDirectory).digest('hex').slice(0, 10);
    const instanceName = `${manifest.capturedDatabase.instanceLabel.slice(0, 48)}-${instanceSuffix}`;
    let instanceDirectory: string | undefined;
    let completed = false;

    try {
      const primarySession = await mainnet.launchApp({
        appsDirectory,
        instanceName,
        appLogsMode: 'quiet',
        sourceInstancePackagePath: manifest.capturedDatabase.instancePackagePath,
      });
      instanceDirectory = primarySession.appInstanceDirectory;
      await mainnet.closeApp();

      const migratedDatabasePath = Path.join(instanceDirectory, 'database.sqlite');
      const afterMigration = CapturedDatabaseScenario.inspectAfterMigration(migratedDatabasePath);
      const restartedSession = await mainnet.launchApp({
        appsDirectory,
        instanceName,
        appLogsMode: 'quiet',
      });
      if (restartedSession.appInstanceDirectory !== instanceDirectory) {
        throw new Error('Restarted app resolved a different captured database instance directory');
      }
      await mainnet.closeApp();

      const afterRestart = CapturedDatabaseScenario.inspectAfterMigration(migratedDatabasePath);
      mkdirSync(runDirectory, { recursive: true });
      const instancePackagePath = Path.join(runDirectory, 'instance');
      cpSync(instanceDirectory, instancePackagePath, {
        recursive: true,
        errorOnExist: true,
        force: false,
      });
      completed = true;
      return { before, afterMigration, afterRestart, instanceName, instancePackagePath };
    } finally {
      await mainnet.closeApp();
      if (completed) {
        if (instanceDirectory) rmSync(instanceDirectory, { recursive: true, force: true });
        if (instanceDirectory) rmSync(`${instanceDirectory}-host`, { recursive: true, force: true });
      }
    }
  }

  private static inspectBeforeMigration(databasePath: string): CapturedDatabaseBeforeMigration {
    const database = new DatabaseSync(databasePath, { open: true, readOnly: true });
    try {
      const migrations = database.prepare('SELECT MAX(version) AS version FROM _sqlx_migrations').get() as {
        version: number;
      };
      const migratableBitcoinLockIds = CapturedDatabaseScenario.numberColumn(
        database,
        `SELECT utxoId AS id
         FROM BitcoinLocks
         WHERE utxoId IS NOT NULL
           AND status IN ('LockedAndIsMinting', 'LockedAndMinted', 'Releasing', 'Released')
           AND CAST(liquidityPromised AS INTEGER) > 0
           AND json_extract(lockDetails, '$.ownerAccount') IS NOT NULL
         ORDER BY utxoId`,
      );
      const vaultCount = database.prepare('SELECT COUNT(*) AS count FROM Vaults').get() as { count: number };

      return {
        latestMigration: migrations.version,
        walletIdentitySha256: CapturedDatabaseScenario.walletIdentitySha256(database),
        migratableBitcoinLockIds,
        readonlyAccount: {
          configuredServer: CapturedDatabaseScenario.configBoolean(database, 'isServerInstalled'),
          operations: CapturedDatabaseScenario.configBoolean(database, 'hasExtensionOperations'),
          upstream: CapturedDatabaseScenario.configBoolean(database, 'upstreamOperator'),
          vault: vaultCount.count > 0,
        },
      };
    } finally {
      database.close();
    }
  }

  private static inspectAfterMigration(databasePath: string): CapturedDatabaseAfterMigration {
    const database = new DatabaseSync(databasePath, { open: true, readOnly: true });
    try {
      const migrations = database.prepare('SELECT MAX(version) AS version FROM _sqlx_migrations').get() as {
        version: number;
      };
      const quickCheck = database.prepare('PRAGMA quick_check').get() as { quick_check: string };
      return {
        latestMigration: migrations.version,
        quickCheck: quickCheck.quick_check,
        walletIdentitySha256: CapturedDatabaseScenario.walletIdentitySha256(database),
        fundedBitcoinLockIds: CapturedDatabaseScenario.numberColumn(
          database,
          `SELECT utxoId AS id
         FROM BitcoinLocks
         WHERE status = 'LockFunded'
           AND utxoId IN (SELECT utxoId FROM BitcoinFissions WHERE origin = 'lock-migration')
         ORDER BY utxoId`,
        ),
        fundingBitcoinUtxoIds: CapturedDatabaseScenario.numberColumn(
          database,
          `SELECT lockUtxoId AS id
         FROM BitcoinUtxos
         WHERE role = 'Funding'
           AND lockUtxoId IN (SELECT utxoId FROM BitcoinFissions WHERE origin = 'lock-migration')
         ORDER BY lockUtxoId`,
        ),
        migratedBitcoinFissionIds: CapturedDatabaseScenario.numberColumn(
          database,
          `SELECT fissionId AS id
         FROM BitcoinFissions
         WHERE origin = 'lock-migration'
         ORDER BY fissionId`,
        ),
      };
    } finally {
      database.close();
    }
  }

  private static numberColumn(database: DatabaseSync, query: string): number[] {
    return (database.prepare(query).all() as unknown as Array<{ id: number }>).map(row => row.id);
  }

  private static walletIdentitySha256(database: DatabaseSync): string {
    const wallets = database
      .prepare(
        `SELECT id, walletType, name, address, sortOrder, keyReference, derivationPath, secretKind
       FROM Wallets
       ORDER BY id`,
      )
      .all();
    return createHash('sha256').update(JSON.stringify(wallets)).digest('hex');
  }

  private static configBoolean(database: DatabaseSync, key: string): boolean {
    const record = database.prepare('SELECT value FROM Config WHERE key = ?').get(key) as { value: string } | undefined;
    if (!record?.value) return false;
    const value = JSON.parse(record.value) as unknown;
    return typeof value === 'boolean' ? value : value !== null;
  }
}
