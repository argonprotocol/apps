import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import Path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { AccountActivityKind, type IIndexerSpec } from '@argonprotocol/apps-core';
import { getClient, type ArgonClient } from '@argonprotocol/mainchain';
import { ApiPromise } from '@polkadot/api';
import { encodeAddress } from '@polkadot/util-crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SyncStateKeys } from 'src-vue/lib/db/SyncStateTable.ts';
import { reduceFinancialPositions } from 'src-vue/lib/financials/index.ts';
import { historyEvent } from 'src-vue/__test__/helpers/bitcoin.ts';
import { AppSession } from '../AppSession.ts';
import { AppSessionDiagnostics } from '../AppSessionDiagnostics.ts';
import { FlowSession } from '../FlowSession.ts';
import { LocalMainnetFork, type ProducedBlock } from '../local-mainnet/LocalMainnetFork.ts';
import { LocalMainnetIndexer } from '../local-mainnet/LocalMainnetIndexer.ts';
import { LocalMainnetReview, type AccountReviewResult } from '../local-mainnet/LocalMainnetReview.ts';
import type { LocalMainnetManifest } from '../local-mainnet/manifest.ts';
import type { CandidateRuntimeArtifact } from '../local-mainnet/RuntimeCandidate.ts';
import type { StartingDatabaseRegistry } from '../local-mainnet/StartingDatabaseCapture.ts';

vi.mock('@argonprotocol/mainchain', async importOriginal => ({
  ...(await importOriginal<typeof import('@argonprotocol/mainchain')>()),
  getClient: vi.fn(),
}));

const directories: string[] = [];
const originalArgv = process.argv;
afterEach(() => {
  process.argv = originalArgv;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('partial capture diagnostics', () => {
  it('continues diagnosis after a corrupt account and rejects incomplete capture even when every review passes', async () => {
    const directory = mkdtempSync(Path.join(tmpdir(), 'qualification-partial-capture-'));
    directories.push(directory);
    vi.stubEnv('GITHUB_STEP_SUMMARY', Path.join(directory, 'summary.md'));
    const packagePath = Path.join(directory, 'scenario-001');
    mkdirSync(packagePath);
    const databasePath = Path.join(packagePath, 'database.sqlite');
    const database = new DatabaseSync(databasePath);
    database.exec(`
      CREATE TABLE RecoveryCheckpoint (blockNumber INTEGER); INSERT INTO RecoveryCheckpoint VALUES (100);
      CREATE TABLE SyncState (key TEXT PRIMARY KEY, state TEXT);
      CREATE TABLE BitcoinLocks (lockId INTEGER, isHistoryRecoveryPending INTEGER);
      CREATE TABLE BitcoinFissions (ownerAccount TEXT, fissionId INTEGER, liquidId INTEGER, closedAtArgonBlock INTEGER);
    `);
    database
      .prepare('INSERT INTO SyncState VALUES (?, ?)')
      .run(SyncStateKeys.WalletHistory, JSON.stringify({ asOfBlock: 100 }));
    database.prepare('INSERT INTO SyncState VALUES (?, ?)').run(
      SyncStateKeys.FinancialHistory,
      JSON.stringify({
        domainCheckpoints: { bitcoin: { asOfBlock: 100 }, bonds: { asOfBlock: 100 }, vaulting: { asOfBlock: 100 } },
      }),
    );
    database.close();
    const registry: StartingDatabaseRegistry = {
      formatVersion: 4,
      sourceApp: {
        version: '2.4.0',
        gitHead: '12'.repeat(20),
        runtimeQueriesSha256: '12'.repeat(32),
        historicalEventsSha256: '12'.repeat(32),
      },
      environment: {
        network: 'mainnet',
        blockNumber: 100,
        blockHash: `0x${'12'.repeat(32)}`,
        deployedSpecVersion: 159,
      },
      throughBlock: 100,
      selection: {
        kind: 'operational-account-graph',
        accountLimit: 12,
        graphAccounts: 12,
        selectedAccounts: 4,
        features: [],
      },
      coverage: {
        completeHistoryAccounts: 2,
        complete: false,
      },
      failures: [{ label: 'scenario-002', error: 'Old app recovery stalled' }],
      accounts: [
        {
          label: 'scenario-001',
          defaultArgonAccountId: encodeAddress(new Uint8Array(32).fill(1), 42),
          instancePackagePath: packagePath,
          databaseSha256: createHash('sha256').update(readFileSync(databasePath)).digest('hex'),
          quickCheck: 'ok',
          history: {
            throughBlock: 100,
            walletHistoryThroughBlock: 100,
            financialDomains: ['bitcoin', 'bonds', 'vaulting'],
            partialFinancialDomains: [],
            pendingBitcoinLocks: 0,
            complete: true,
          },
          selection: { features: ['bitcoin'] },
          expected: {
            bitcoinLiquidIds: [1, 2],
            archivedBitcoinLiquidIds: [1],
            bondLotIds: [],
            flexibleBondLotIds: [],
            stakeLotIds: [],
            historicalBondLotIds: [],
            historicalStakeLotIds: [],
            configuredServer: false,
            operations: false,
            treasury: false,
            upstream: false,
          },
        },
      ],
    };
    const usablePackagePath = Path.join(directory, 'scenario-004');
    mkdirSync(usablePackagePath);
    copyFileSync(databasePath, Path.join(usablePackagePath, 'database.sqlite'));
    registry.accounts.push({
      ...registry.accounts[0],
      label: 'scenario-004',
      instancePackagePath: usablePackagePath,
    });
    const incompletePackagePath = Path.join(directory, 'scenario-003');
    mkdirSync(incompletePackagePath);
    const incompleteDatabasePath = Path.join(incompletePackagePath, 'database.sqlite');
    copyFileSync(databasePath, incompleteDatabasePath);
    const incompleteDatabase = new DatabaseSync(incompleteDatabasePath);
    incompleteDatabase.prepare('UPDATE SyncState SET state = ? WHERE key = ?').run(
      JSON.stringify({
        domainCheckpoints: {
          bitcoin: { asOfBlock: 99, partialRecovery: true },
          bonds: { asOfBlock: 100 },
          vaulting: { asOfBlock: 100 },
        },
      }),
      SyncStateKeys.FinancialHistory,
    );
    incompleteDatabase.exec('INSERT INTO BitcoinLocks VALUES (1, 1)');
    incompleteDatabase.close();
    registry.accounts.push({
      ...registry.accounts[0],
      label: 'scenario-003',
      defaultArgonAccountId: encodeAddress(new Uint8Array(32).fill(3), 42),
      instancePackagePath: incompletePackagePath,
      databaseSha256: createHash('sha256').update(readFileSync(incompleteDatabasePath)).digest('hex'),
      history: {
        ...registry.accounts[0].history,
        complete: false,
        financialDomains: ['bonds', 'vaulting'],
        partialFinancialDomains: ['bitcoin'],
        pendingBitcoinLocks: 1,
        recoveryError: 'Missing creation event',
      },
    });
    mkdirSync(Path.join(directory, 'capture'));
    const registryPath = Path.join(directory, 'capture/starting-databases.json');
    writeFileSync(registryPath, JSON.stringify(registry));

    await expect(LocalMainnetReview['loadRegistry'](registryPath)).rejects.toThrow('not qualified');
    const diagnostic = await LocalMainnetReview['loadRegistry'](registryPath, true);
    expect(diagnostic.captureQualified).toBe(false);
    expect(diagnostic.registry.accounts.map(account => account.label)).toEqual([
      'scenario-001',
      'scenario-004',
      'scenario-003',
    ]);
    expect(diagnostic.registry.coverage.complete).toBe(false);
    expect(diagnostic.registry.failures).toEqual(registry.failures);

    for (const name of ['chopsticks.sqlite', 'mainnet-activity-v2.db']) {
      copyFileSync(databasePath, Path.join(directory, name));
    }
    const manifest: LocalMainnetManifest = {
      formatVersion: 1,
      network: 'mainnet',
      archive: {
        url: 'wss://rpc.argon.network',
        blockNumber: 100,
        blockHash: registry.environment.blockHash,
        deployedSpecVersion: 159,
        chopsticksDatabasePath: 'chopsticks.sqlite',
        sha256: registry.accounts[0].databaseSha256,
      },
      indexer: {
        blockNumber: 100,
        blockHash: registry.environment.blockHash,
        databasePath: 'mainnet-activity-v2.db',
        sha256: registry.accounts[0].databaseSha256,
      },
    };
    const manifestPath = Path.join(directory, 'manifest.json');
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const wasmPath = Path.join(directory, 'runtime.wasm');
    writeFileSync(wasmPath, Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]));
    const candidate: CandidateRuntimeArtifact = {
      sourceDirectory: directory,
      gitHead: '34'.repeat(20),
      wasmPath,
      wasmSha256: createHash('sha256').update(readFileSync(wasmPath)).digest('hex'),
      expectedSpecVersion: 159,
    };
    const candidatePath = Path.join(directory, 'attestation.json');
    writeFileSync(candidatePath, JSON.stringify(candidate));

    const deployedBlock: ProducedBlock = {
      number: 100,
      hash: registry.environment.blockHash,
      runtimeSpecVersion: 159,
      metadataSpecVersion: 159,
      includedTransactionHashes: [],
      events: [],
    };
    const upgradeTransactionHash = `0x${'34'.repeat(32)}`;
    const blocks: Record<Parameters<LocalMainnetFork['produceBlock']>[0], ProducedBlock> = {
      deployed: deployedBlock,
      upgrade: {
        ...deployedBlock,
        number: 101,
        includedTransactionHashes: [upgradeTransactionHash],
        events: ['system.CodeUpdated'],
      },
      migration: { ...deployedBlock, number: 102, runtimeSpecVersion: 159 },
      candidate: { ...deployedBlock, number: 103, runtimeSpecVersion: 159, metadataSpecVersion: 159 },
    };
    const runningResources = new Set<string>();
    const fork = Object.create(LocalMainnetFork.prototype) as LocalMainnetFork;
    Object.defineProperty(fork, 'archiveUrl', { value: 'ws://127.0.0.1:1' });
    vi.spyOn(LocalMainnetFork, 'start').mockImplementation(async ({ runDirectory }) => {
      mkdirSync(runDirectory, { recursive: true });
      runningResources.add('fork');
      return fork;
    });
    vi.spyOn(fork, 'submitRuntimeUpgrade').mockResolvedValue(upgradeTransactionHash);
    vi.spyOn(fork, 'produceBlock').mockImplementation(async stage => blocks[stage]);
    vi.spyOn(fork, 'close').mockImplementation(async () => {
      runningResources.delete('fork');
    });
    const indexer = Object.create(LocalMainnetIndexer.prototype) as LocalMainnetIndexer;
    Object.defineProperty(indexer, 'url', { value: 'http://127.0.0.1:2' });
    vi.spyOn(LocalMainnetIndexer, 'start').mockImplementation(async () => {
      runningResources.add('indexer');
      return indexer;
    });
    vi.spyOn(indexer, 'waitForBlock').mockResolvedValue();
    vi.spyOn(indexer, 'inspect').mockReturnValue({
      checkpoint: { blockNumber: 103, blockHash: blocks.candidate.hash, definitionVersion: 1 },
      blocks: [],
      runtimeMetadataSpecVersions: [159],
    });
    vi.spyOn(indexer, 'stop').mockImplementation(async () => {
      runningResources.delete('indexer');
    });
    const activity: IIndexerSpec['/v2/activity/:address']['responseType'] = {
      blocks: [],
      asOfBlock: 103,
      definitionVersion: 4,
      coverage: { fromBlock: 0, toBlock: 103, gaps: [] },
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: URL) =>
        Response.json({
          ...activity,
          blocks:
            Number(url.searchParams.get('activityMask')) === Number(AccountActivityKind.BondPosition)
              ? []
              : [
                  {
                    blockNumber: 90,
                    blockHash: `0x${'90'.repeat(32)}`,
                    specVersion: 157,
                    activityMask: AccountActivityKind.BitcoinMint,
                  },
                  {
                    blockNumber: 91,
                    blockHash: `0x${'91'.repeat(32)}`,
                    specVersion: 157,
                    activityMask: AccountActivityKind.BitcoinLock,
                  },
                  {
                    blockNumber: 92,
                    blockHash: `0x${'92'.repeat(32)}`,
                    specVersion: 159,
                    activityMask: AccountActivityKind.BitcoinLock,
                  },
                ],
        }),
      ),
    );
    const chainClient = Object.create(ApiPromise.prototype) as ArgonClient;
    vi.spyOn(chainClient, 'disconnect').mockResolvedValue();
    Object.defineProperty(chainClient, 'rpc', {
      configurable: true,
      value: { chain: { getHeader: async () => ({ parentHash: `0x${'90'.repeat(32)}` }) } },
    });
    const archivedApi = Object.create(ApiPromise.prototype) as Awaited<ReturnType<ArgonClient['at']>>;
    Object.defineProperty(archivedApi, 'query', {
      configurable: true,
      value: {
        system: {
          events: async () => [
            historyEvent(159, 'bitcoinFissions', 'FissionCreated', {
              accountId: registry.accounts[2].defaultArgonAccountId,
              fissionId: 99,
              liquidId: 99,
              lockId: 7,
              satoshis: 1_000n,
              microgonsAtTargetPerBtc: 1_000n,
              liquidityPromised: 100n,
            }),
            historyEvent(159, 'bitcoinFissions', 'FissionClosed', {
              accountId: registry.accounts[2].defaultArgonAccountId,
              fissionId: 99,
              redemptionAmount: 100n,
            }),
            historyEvent(159, 'bitcoinFissions', 'FissionClosed', {
              accountId: encodeAddress(new Uint8Array(32).fill(4), 42),
              fissionId: 101,
              redemptionAmount: 100n,
            }),
          ],
        },
      },
    });
    const legacyApi = Object.create(ApiPromise.prototype) as Awaited<ReturnType<ArgonClient['at']>>;
    Object.defineProperty(legacyApi, 'query', {
      configurable: true,
      value: {
        system: {
          events: async () => [
            historyEvent(157, 'mint', 'BitcoinMint', {
              accountId: registry.accounts[2].defaultArgonAccountId,
              utxoId: 9,
              amount: 100n,
            }),
            historyEvent(157, 'bitcoinUtxos', 'UtxoVerified', { utxoId: 11, satoshisReceived: 1_000n }),
            historyEvent(157, 'bitcoinLocks', 'BitcoinLockCreated', {
              utxoId: 12,
              vaultId: 1,
              liquidityPromised: 100n,
              securitization: 100n,
              lockedTargetPrice: 1_000n,
              accountId: registry.accounts[2].defaultArgonAccountId,
              securityFee: 0n,
            }),
          ],
        },
        bitcoinLocks: {
          locksByUtxoId: async (utxoId: number) => ({
            ownerAccount: registry.accounts[2].defaultArgonAccountId,
            liquidityPromised: utxoId === 11 ? 0n : 100n,
            utxoSatoshis: utxoId === 11 ? 1_000n : 0n,
            isVerified: utxoId === 11,
            satoshis: 1_000n,
          }),
        },
      },
    });
    const terminalApi = Object.create(ApiPromise.prototype) as Awaited<ReturnType<ArgonClient['at']>>;
    Object.defineProperty(terminalApi, 'query', {
      configurable: true,
      value: {
        system: {
          events: async () => [
            historyEvent(157, 'bitcoinUtxos', 'UtxoVerified', { utxoId: 10, satoshisReceived: 1_000n }),
            historyEvent(157, 'bitcoinLocks', 'BitcoinLockBurned', {
              utxoId: 10,
              vaultId: 1,
              wasUtxoSpent: true,
            }),
          ],
        },
        bitcoinLocks: { locksByUtxoId: async () => null },
      },
    });
    vi.spyOn(chainClient, 'at').mockImplementation(async hash => {
      if (hash === `0x${'90'.repeat(32)}`) return legacyApi;
      if (hash === `0x${'91'.repeat(32)}`) return terminalApi;
      return archivedApi;
    });
    vi.mocked(getClient).mockResolvedValue(chainClient);
    vi.spyOn(AppSessionDiagnostics, 'getInstanceDirectory').mockImplementation((_appId, _network, instance) =>
      Path.join(directory, 'app', instance),
    );
    let repairCandidateHistory = false;
    let repairBitcoinRecords = false;
    let repairPendingMintRecord = false;
    const activeApps = new Set<FlowSession>();
    const persistedAtLaunch: AccountReviewResult[][] = [];
    let resultsPath = Path.join(directory, 'review/account-results.json');
    vi.spyOn(FlowSession, 'start').mockImplementation(async (options = {}) => {
      persistedAtLaunch.push(existsSync(resultsPath) ? JSON.parse(readFileSync(resultsPath, 'utf8')) : []);
      const session = Object.create(FlowSession.prototype) as FlowSession;
      activeApps.add(session);
      vi.spyOn(session, 'appInstanceDirectory', 'get').mockReturnValue(
        AppSession.resolveInstanceDirectory({ networkName: 'mainnet', instanceName: options.sessionName! }),
      );
      vi.spyOn(session, 'waitForReady').mockResolvedValue();
      vi.spyOn(session, 'recoverAccountHistory').mockImplementation(async () => {
        const candidateDatabase = new DatabaseSync(Path.join(session.appInstanceDirectory, 'database.sqlite'));
        candidateDatabase
          .prepare('UPDATE SyncState SET state = ? WHERE key = ?')
          .run(JSON.stringify({ asOfBlock: 103 }), SyncStateKeys.WalletHistory);
        const repairsBitcoin = !options.sessionName!.endsWith('scenario-003') || repairCandidateHistory;
        candidateDatabase.prepare('UPDATE SyncState SET state = ? WHERE key = ?').run(
          JSON.stringify({
            domainCheckpoints: {
              bitcoin: { asOfBlock: repairsBitcoin ? 103 : 99, partialRecovery: !repairsBitcoin },
              bonds: { asOfBlock: 103 },
              vaulting: { asOfBlock: 103 },
            },
          }),
          SyncStateKeys.FinancialHistory,
        );
        if (repairsBitcoin) candidateDatabase.exec('UPDATE BitcoinLocks SET isHistoryRecoveryPending = 0');
        if (repairBitcoinRecords && options.sessionName!.endsWith('scenario-003')) {
          candidateDatabase
            .prepare('INSERT INTO BitcoinFissions VALUES (?, 99, 99, 90), (?, 9, 9, 90)')
            .run(registry.accounts[2].defaultArgonAccountId, registry.accounts[2].defaultArgonAccountId);
          if (repairPendingMintRecord) {
            candidateDatabase
              .prepare('INSERT INTO BitcoinFissions VALUES (?, 10, 10, 91)')
              .run(registry.accounts[2].defaultArgonAccountId);
          }
        }
        candidateDatabase.close();
        // App/driver boundary claims success even when durable Bitcoin recovery remains unresolved.
        return {
          accountId: registry.accounts[0].defaultArgonAccountId,
          throughBlock: 103,
          previousLife: { detected: false, recovered: true },
          walletHistory: { asOfBlock: 103, addresses: [], activityMasks: {} },
          financialHistory: { accountId: registry.accounts[0].defaultArgonAccountId, asOfBlock: 103 },
        };
      });
      vi.spyOn(session, 'run').mockResolvedValue({
        elapsedMs: 0,
        data: { 'App.flow.accountReview.snapshot': reduceFinancialPositions([]) },
      });
      vi.spyOn(session, 'checkpointDatabase').mockResolvedValue();
      vi.spyOn(session, 'close').mockImplementation(async () => {
        activeApps.delete(session);
      });
      return session;
    });
    vi.stubEnv('ARGON_E2E_HEADLESS', process.env.ARGON_E2E_HEADLESS);
    process.argv = [
      process.execPath,
      originalArgv[1],
      '--manifest',
      manifestPath,
      '--candidate',
      candidatePath,
      '--accounts',
      registryPath,
      '--all',
      '--diagnostic',
      '--run-directory',
      Path.join(directory, 'review'),
    ];
    writeFileSync(databasePath, 'damaged database');
    await expect(LocalMainnetReview.runFromCommandLine()).rejects.toThrow('2 account review(s) failed');
    const failedResult = {
      label: 'scenario-001',
      status: 'failed',
      error: 'Account database checksum mismatch for scenario-001',
      durationMs: expect.any(Number),
    };
    expect(persistedAtLaunch[0]).toEqual([failedResult]);
    const failedResults = JSON.parse(readFileSync(resultsPath, 'utf8')) as AccountReviewResult[];
    expect(failedResults).toMatchObject([
      failedResult,
      { label: 'scenario-004', status: 'passed', history: { throughBlock: 103, pendingBitcoinLocks: 0 } },
      { label: 'scenario-003', status: 'failed', error: expect.stringContaining('incomplete history after restart') },
    ]);
    expect(activeApps.size).toBe(0);
    expect(runningResources.size).toBe(0);

    repairCandidateHistory = true;
    copyFileSync(Path.join(usablePackagePath, 'database.sqlite'), databasePath);
    resultsPath = Path.join(directory, 'missing-record/account-results.json');
    process.argv[process.argv.length - 1] = Path.join(directory, 'missing-record');
    await expect(LocalMainnetReview.runFromCommandLine()).rejects.toThrow('1 account review(s) failed');
    const missingRecordResults = JSON.parse(readFileSync(resultsPath, 'utf8')) as AccountReviewResult[];
    expect(missingRecordResults).toContainEqual(
      expect.objectContaining({
        label: 'scenario-003',
        status: 'failed',
        error: expect.stringContaining('missing Bitcoin history records'),
      }),
    );
    repairBitcoinRecords = true;
    resultsPath = Path.join(directory, 'missing-pending-mint/account-results.json');
    process.argv[process.argv.length - 1] = Path.join(directory, 'missing-pending-mint');
    await expect(LocalMainnetReview.runFromCommandLine()).rejects.toThrow('1 account review(s) failed');
    expect(JSON.parse(readFileSync(resultsPath, 'utf8'))).toContainEqual(
      expect.objectContaining({
        label: 'scenario-003',
        status: 'failed',
        error: expect.stringContaining('missing Bitcoin history records: 10'),
      }),
    );
    repairPendingMintRecord = true;
    resultsPath = Path.join(directory, 'all-passed/account-results.json');
    process.argv[process.argv.length - 1] = Path.join(directory, 'all-passed');
    await expect(LocalMainnetReview.runFromCommandLine()).rejects.toThrow('starting database capture is incomplete');
    const passedResults = JSON.parse(readFileSync(resultsPath, 'utf8')) as AccountReviewResult[];
    expect(passedResults).toMatchObject([
      { label: 'scenario-001', status: 'passed' },
      { label: 'scenario-004', status: 'passed' },
      {
        label: 'scenario-003',
        status: 'passed',
        history: {
          throughBlock: 103,
          quickCheck: 'ok',
          bitcoinFissionIds: [9, 10, 99],
          expectedBitcoinFissionIds: [9, 10, 99],
          pendingBitcoinLocks: 0,
          partialFinancialDomains: [],
          financialDomains: ['bitcoin', 'bonds', 'vaulting'],
        },
      },
    ]);
    const retained = new DatabaseSync(incompleteDatabasePath, { readOnly: true });
    expect(retained.prepare('SELECT isHistoryRecoveryPending FROM BitcoinLocks').get()?.isHistoryRecoveryPending).toBe(
      1,
    );
    retained.close();
    expect(activeApps.size).toBe(0);
    expect(runningResources.size).toBe(0);
    copyFileSync(resultsPath, Path.join(directory, 'review/account-results.json'));
    resultsPath = Path.join(directory, 'review/account-results.json');
    const timingsPath = Path.join(directory, 'phase-timings.tsv');
    writeFileSync(timingsPath, 'runtime-build\t2\t0\ncapture\t3\t1\nreview\t4\t1\n');
    const reportPath = fileURLToPath(new URL('../local-mainnet/qualificationReport.ts', import.meta.url));
    const partial = spawnSync(process.execPath, ['--import', 'tsx', reportPath, '--directory', directory], {
      encoding: 'utf8',
    });
    expect(partial.status, partial.stderr).toBe(1);
    const partialReport = JSON.parse(readFileSync(Path.join(directory, 'qualification-report.json'), 'utf8'));
    expect(partialReport.qualified).toBe(false);
    expect(partialReport.captureFailures).toEqual(registry.failures);
    expect(partialReport.skipped).toEqual([]);
    expect(partial.stdout).toContain('not qualified');

    registry.failures = [];
    registry.selection.selectedAccounts = 3;
    registry.coverage.complete = true;
    writeFileSync(registryPath, JSON.stringify(registry));
    writeFileSync(timingsPath, 'runtime-build\t2\t0\ncapture\t3\t0\nreview\t4\t0\n');
    const passed = spawnSync(process.execPath, ['--import', 'tsx', reportPath, '--directory', directory], {
      encoding: 'utf8',
    });
    expect(passed.status, passed.stderr).toBe(0);
    const passedReport = JSON.parse(readFileSync(Path.join(directory, 'qualification-report.json'), 'utf8'));
    expect(passedReport.qualified).toBe(true);
    expect(passedReport.incompleteStartingHistories).toEqual([
      { label: 'scenario-003', error: 'Missing creation event' },
    ]);
    const repairedResult = passedResults.find(result => result.label === 'scenario-003')!;
    repairedResult.history!.bitcoinFissionIds = [9];
    writeFileSync(resultsPath, JSON.stringify(passedResults));
    const omittedRecord = spawnSync(process.execPath, ['--import', 'tsx', reportPath, '--directory', directory], {
      encoding: 'utf8',
    });
    expect(omittedRecord.status, omittedRecord.stderr).toBe(1);
    repairedResult.history!.bitcoinFissionIds = [9, 10, 99];
    repairedResult.history!.pendingBitcoinLocks = 1;
    writeFileSync(resultsPath, JSON.stringify(passedResults));
    const unresolved = spawnSync(process.execPath, ['--import', 'tsx', reportPath, '--directory', directory], {
      encoding: 'utf8',
    });
    expect(unresolved.status, unresolved.stderr).toBe(1);
    writeFileSync(resultsPath, JSON.stringify([{ label: 'unreviewed-account', status: 'passed', durationMs: 10 }]));
    const missingReview = spawnSync(process.execPath, ['--import', 'tsx', reportPath, '--directory', directory], {
      encoding: 'utf8',
    });
    expect(missingReview.status).toBe(1);
    await LocalMainnetReview['verifyStartingDatabase'](diagnostic.registry.accounts[0]);
    const restored = new DatabaseSync(diagnostic.registry.accounts[0].instancePackagePath + '/database.sqlite', {
      readOnly: true,
    });
    expect(restored.prepare('SELECT blockNumber FROM RecoveryCheckpoint').get()?.blockNumber).toBe(100);
    restored.close();
    writeFileSync(databasePath, 'damaged database');
    await expect(LocalMainnetReview['verifyStartingDatabase'](diagnostic.registry.accounts[0])).rejects.toThrow(
      'checksum mismatch',
    );
    await expect(LocalMainnetReview['loadRegistry'](registryPath)).rejects.toThrow('checksum mismatch');
    candidate.expectedSpecVersion = 158;
    writeFileSync(candidatePath, JSON.stringify(candidate));
    process.argv[process.argv.length - 1] = Path.join(directory, 'older-runtime');
    await expect(LocalMainnetReview.runFromCommandLine()).rejects.toThrow('older than deployed spec 159');
  });
});
