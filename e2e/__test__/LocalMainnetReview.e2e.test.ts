import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import Path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { type IIndexerSpec } from '@argonprotocol/apps-core';
import { getClient, type ArgonClient } from '@argonprotocol/mainchain';
import { ApiPromise } from '@polkadot/api';
import { encodeAddress } from '@polkadot/util-crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { reduceFinancialPositions } from 'src-vue/lib/financials/index.ts';
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
    const packagePath = Path.join(directory, 'scenario-001');
    mkdirSync(packagePath);
    const databasePath = Path.join(packagePath, 'database.sqlite');
    const database = new DatabaseSync(databasePath);
    database.exec('CREATE TABLE RecoveryCheckpoint (blockNumber INTEGER); INSERT INTO RecoveryCheckpoint VALUES (100)');
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
    registry.accounts.push({
      ...registry.accounts[0],
      label: 'scenario-003',
      instancePackagePath: Path.join(directory, 'incomplete'),
      history: { ...registry.accounts[0].history, complete: false },
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
      definitionVersion: 1,
      coverage: { fromBlock: 100, toBlock: 103, gaps: [] },
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json(activity)),
    );
    const chainClient = Object.create(ApiPromise.prototype) as ArgonClient;
    vi.spyOn(chainClient, 'disconnect').mockResolvedValue();
    vi.mocked(getClient).mockResolvedValue(chainClient);
    vi.spyOn(AppSessionDiagnostics, 'getInstanceDirectory').mockImplementation((_appId, _network, instance) =>
      Path.join(directory, 'app', instance),
    );
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
      vi.spyOn(session, 'recoverAccountHistory').mockResolvedValue({
        accountId: registry.accounts[0].defaultArgonAccountId,
        throughBlock: 103,
        previousLife: { detected: false, recovered: true },
        walletHistory: { asOfBlock: 103, addresses: [], activityMasks: {} },
        financialHistory: { accountId: registry.accounts[0].defaultArgonAccountId, asOfBlock: 103 },
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
    await expect(LocalMainnetReview.runFromCommandLine()).rejects.toThrow('1 account review(s) failed');
    const failedResult = {
      label: 'scenario-001',
      status: 'failed',
      error: 'Account database checksum mismatch for scenario-001',
      durationMs: expect.any(Number),
    };
    expect(persistedAtLaunch[0]).toEqual([failedResult]);
    expect(JSON.parse(readFileSync(resultsPath, 'utf8'))).toEqual([
      failedResult,
      { label: 'scenario-004', status: 'passed', durationMs: expect.any(Number) },
    ]);
    expect(activeApps.size).toBe(0);
    expect(runningResources.size).toBe(0);

    copyFileSync(Path.join(usablePackagePath, 'database.sqlite'), databasePath);
    resultsPath = Path.join(directory, 'all-passed/account-results.json');
    process.argv[process.argv.length - 1] = Path.join(directory, 'all-passed');
    await expect(LocalMainnetReview.runFromCommandLine()).rejects.toThrow('starting database capture is incomplete');
    const passedResults = JSON.parse(readFileSync(resultsPath, 'utf8')) as AccountReviewResult[];
    expect(passedResults).toEqual([
      { label: 'scenario-001', status: 'passed', durationMs: expect.any(Number) },
      { label: 'scenario-004', status: 'passed', durationMs: expect.any(Number) },
    ]);
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
    expect(partialReport.skipped).toEqual([{ label: 'scenario-003', reason: 'Starting history is incomplete' }]);
    expect(partial.stdout).toContain('not qualified');

    registry.accounts = diagnostic.registry.accounts.filter(account => account.history.complete);
    registry.failures = [];
    registry.selection.selectedAccounts = 2;
    registry.coverage.complete = true;
    writeFileSync(registryPath, JSON.stringify(registry));
    writeFileSync(timingsPath, 'runtime-build\t2\t0\ncapture\t3\t0\nreview\t4\t0\n');
    const passed = spawnSync(process.execPath, ['--import', 'tsx', reportPath, '--directory', directory], {
      encoding: 'utf8',
    });
    expect(passed.status, passed.stderr).toBe(0);
    expect(JSON.parse(readFileSync(Path.join(directory, 'qualification-report.json'), 'utf8')).qualified).toBe(true);
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
