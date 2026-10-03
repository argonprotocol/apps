import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import Path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as core from '@argonprotocol/apps-core';
import { ApiPromise } from '@polkadot/api';
import { encodeAddress } from '@polkadot/util-crypto';
import { SyncStateKeys } from 'src-vue/lib/db/SyncStateTable.ts';
import { AppSession } from '../AppSession.ts';
import { AppSessionDiagnostics } from '../AppSessionDiagnostics.ts';
import { LocalMainnet } from '../local-mainnet/LocalMainnet.ts';
import { LocalMainnetFork } from '../local-mainnet/LocalMainnetFork.ts';
import { LocalMainnetIndexer } from '../local-mainnet/LocalMainnetIndexer.ts';
import { StartingDatabaseCapture } from '../local-mainnet/StartingDatabaseCapture.ts';
import type { OperationalAccountGraphNode } from '../local-mainnet/OperationalAccountGraph.ts';
import {
  inspectStartingDatabase,
  isStartingDatabaseComplete,
  type StartingDatabaseInspection,
} from '../local-mainnet/StartingDatabaseInspection.ts';

const directories: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('starting database capture', () => {
  it('requires every recovery domain to reach the pinned block without partial or pending work', () => {
    const complete: StartingDatabaseInspection = {
      quickCheck: 'ok',
      walletHistoryThroughBlock: 100,
      financialDomains: ['bitcoin', 'bonds', 'vaulting'],
      partialFinancialDomains: [],
      pendingBitcoinLocks: 0,
      bitcoinLiquidIds: [],
      archivedBitcoinLiquidIds: [],
      bondLotIds: [],
      stakeLotIds: [],
      configuredServer: false,
      operations: false,
      treasury: false,
      upstream: false,
    };

    expect(isStartingDatabaseComplete(complete, 100)).toBe(true);
    expect(isStartingDatabaseComplete({ ...complete, walletHistoryThroughBlock: 99 }, 100)).toBe(false);
    expect(isStartingDatabaseComplete({ ...complete, financialDomains: ['bitcoin', 'bonds'] }, 100)).toBe(false);
    expect(isStartingDatabaseComplete({ ...complete, partialFinancialDomains: ['vaulting'] }, 100)).toBe(false);
    expect(isStartingDatabaseComplete({ ...complete, pendingBitcoinLocks: 1 }, 100)).toBe(false);
  });

  it('retains a safely closed incomplete source, retries transport stalls, and rejects unsafe shutdown', async () => {
    vi.useFakeTimers();
    const directory = mkdtempSync(Path.join(tmpdir(), 'qualification-source-failure-'));
    directories.push(directory);
    const appsDirectory = Path.resolve(import.meta.dirname, '../..');
    const fork = Object.assign(Object.create(LocalMainnetFork.prototype) as LocalMainnetFork, {
      archiveUrl: 'ws://127.0.0.1:1',
    });
    const indexer = Object.assign(Object.create(LocalMainnetIndexer.prototype) as LocalMainnetIndexer, {
      url: 'http://127.0.0.1:2',
    });
    const mainnet: LocalMainnet = Reflect.construct(LocalMainnet, [
      { network: 'mainnet' },
      directory,
      fork,
      indexer,
      { number: 100, hash: `0x${'12'.repeat(32)}`, runtimeSpecVersion: 159 },
    ]);
    const capture: StartingDatabaseCapture = Reflect.construct(StartingDatabaseCapture, [
      mainnet,
      appsDirectory,
      directory,
      12,
    ]);
    vi.spyOn(AppSessionDiagnostics, 'getInstanceDirectory').mockImplementation((_appId, _network, instance) =>
      Path.join(directory, 'app', instance),
    );
    const accountId = encodeAddress(new Uint8Array(32).fill(1), 42);
    const scenario: OperationalAccountGraphNode = {
      identity: {
        operatorName: 'test',
        defaultAccountId: accountId,
        operationalAccountId: accountId,
        miningAccountId: accountId,
      },
      operationalAccountId: accountId,
      features: ['bitcoin'],
    };
    const client = Object.create(ApiPromise.prototype) as core.ArgonClient;
    vi.spyOn(client, 'at').mockResolvedValue(
      Object.create(ApiPromise.prototype) as Awaited<ReturnType<core.ArgonClient['at']>>,
    );
    vi.spyOn(core.BitcoinFission, 'getAllByOwner').mockResolvedValue([]);
    vi.spyOn(core.TreasuryBonds, 'getBondLotsByAccount').mockResolvedValue([]);
    vi.spyOn(core, 'getVaultByOperator').mockResolvedValue(undefined);
    let starts = 0;
    let transient = false;
    let unsafeClose = false;
    vi.spyOn(AppSession, 'start').mockImplementation(async (options = {}) => {
      starts += 1;
      const session = Object.create(AppSession.prototype) as AppSession;
      const instanceDirectory = AppSession.resolveInstanceDirectory({
        networkName: 'mainnet',
        instanceName: options.sessionName!,
      });
      vi.spyOn(session, 'appInstanceDirectory', 'get').mockReturnValue(instanceDirectory);
      const database = new DatabaseSync(Path.join(instanceDirectory, 'database.sqlite'));
      database.exec(`
        CREATE TABLE IF NOT EXISTS SyncState (key TEXT PRIMARY KEY, state TEXT);
        CREATE TABLE IF NOT EXISTS BitcoinLocks (lockId INTEGER, isHistoryRecoveryPending INTEGER);
        CREATE TABLE IF NOT EXISTS BitcoinFissions (ownerAccount TEXT, liquidId INTEGER, closedAtArgonBlock INTEGER);
      `);
      database
        .prepare('INSERT OR REPLACE INTO SyncState VALUES (?, ?)')
        .run(SyncStateKeys.WalletHistory, JSON.stringify({ asOfBlock: 100 }));
      database.prepare('INSERT OR REPLACE INTO SyncState VALUES (?, ?)').run(
        SyncStateKeys.FinancialHistory,
        JSON.stringify({
          domainCheckpoints: {
            bitcoin: { asOfBlock: transient && starts > 1 ? 100 : 99 },
            bonds: { asOfBlock: 100 },
            vaulting: { asOfBlock: 100 },
          },
        }),
      );
      database.close();
      vi.spyOn(session, 'frontendErrors', 'get').mockReturnValue([
        transient
          ? '[FinancialHistory] Unable to initialize recovery: RPC disconnected'
          : '[FinancialHistory] Unable to initialize recovery: Bitcoin Fission 1 history is missing its creation event',
      ]);
      vi.spyOn(session, 'checkpointDatabase').mockResolvedValue();
      vi.spyOn(session, 'close').mockImplementation(async () => {
        if (unsafeClose) throw new Error('Process did not close');
      });
      return session;
    });

    const startedAt = Date.now();
    const retained = expect(
      capture['captureAccount']({
        client,
        scenario,
        label: 'scenario-001',
        index: 0,
      }),
    ).resolves.toBeUndefined();
    await Promise.all([retained, vi.runAllTimersAsync()]);
    expect(Date.now() - startedAt).toBeLessThan(60_000);
    const source = capture['registry'].accounts[0];
    expect(source.history).toMatchObject({
      complete: false,
      financialDomains: ['bonds', 'vaulting'],
      recoveryError: expect.stringContaining('missing its creation event'),
    });
    const copied = inspectStartingDatabase(Path.join(source.instancePackagePath, 'database.sqlite'), 100, accountId);
    expect(copied.quickCheck).toBe('ok');
    expect(copied.walletHistoryThroughBlock).toBe(100);
    expect(isStartingDatabaseComplete(copied, 100)).toBe(false);
    expect(
      JSON.parse(readFileSync(Path.join(source.instancePackagePath, 'wallet.json'), 'utf8')).encryptedMnemonic,
    ).toBe('');

    starts = 0;
    transient = true;
    const retried = expect(
      capture['captureAccount']({
        client,
        scenario,
        label: 'scenario-002',
        index: 1,
      }),
    ).resolves.toBeUndefined();
    await Promise.all([retried, vi.runAllTimersAsync()]);
    expect(capture['registry'].accounts[1].history).toMatchObject({
      complete: true,
      financialDomains: ['bitcoin', 'bonds', 'vaulting'],
    });

    transient = false;
    unsafeClose = true;
    await expect(
      capture['captureAccount']({
        client,
        scenario,
        label: 'scenario-003',
        index: 2,
      }),
    ).rejects.toThrow('could not checkpoint and close');
    expect(capture['registry'].accounts.map(account => account.label)).toEqual(['scenario-001', 'scenario-002']);
  });

  it('captures current and archived Liquids without requiring pre-cutover Bitcoin columns', () => {
    const directory = mkdtempSync(Path.join(tmpdir(), 'qualification-current-history-'));
    directories.push(directory);
    const path = Path.join(directory, 'database.sqlite');
    const database = new DatabaseSync(path);
    database.exec(`
      CREATE TABLE BitcoinLocks (lockId INTEGER, isHistoryRecoveryPending INTEGER);
      CREATE TABLE BitcoinFissions (ownerAccount TEXT, liquidId INTEGER, closedAtArgonBlock INTEGER);
      INSERT INTO BitcoinFissions VALUES
        ('account', 1, 90), ('account', 2, 90), ('account', 2, NULL),
        ('account', 3, NULL), ('other-account', 4, 90);
      CREATE TABLE SyncState (key INTEGER, state TEXT);
      CREATE TABLE BondLotHistory (accountId TEXT, programType TEXT, bondLotId INTEGER, releaseBlockHash TEXT);
      CREATE TABLE Config (key TEXT, value TEXT);
    `);
    database.close();

    const inspection = inspectStartingDatabase(path, 100, 'account');
    expect(inspection.bitcoinLiquidIds).toEqual([1, 2, 3]);
    expect(inspection.archivedBitcoinLiquidIds).toEqual([1]);
    expect(inspection.pendingBitcoinLocks).toBe(0);
    expect(isStartingDatabaseComplete(inspection, 100)).toBe(false);
  });
});
