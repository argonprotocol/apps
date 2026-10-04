#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import Path from 'node:path';
import process from 'node:process';
import { parseArgs } from 'node:util';
import {
  BitcoinFission,
  createArgonClient,
  getVaultByOperator,
  TreasuryBonds,
  type ArgonClient,
} from '@argonprotocol/apps-core';
import { getClient } from '@argonprotocol/mainchain';
import type { IFinancialHistoryDomain } from 'src-vue/lib/db/SyncStateTable.ts';
import { AppSession } from '../AppSession.ts';
import { delay } from '../../scripts/utils.ts';
import { writeReadonlyWallet } from '../../scripts/troubleshootAccount.ts';
import { LocalMainnet } from './LocalMainnet.ts';
import { loadLocalMainnetManifest } from './manifest.ts';
import {
  OPERATIONAL_ACCOUNT_FEATURES,
  OperationalAccountGraph,
  type OperationalAccountFeature,
  type OperationalAccountGraphNode,
} from './OperationalAccountGraph.ts';
import {
  inspectStartingDatabase,
  inspectStartingDatabaseRecovery,
  isStartingDatabaseComplete,
  isStartingDatabaseHistoryRecovered,
  type StartingDatabaseRecoveryProgress,
} from './StartingDatabaseInspection.ts';

const CAPTURE_HISTORY_TIMEOUT_MS = 30 * 60_000;
const CAPTURE_HISTORY_STALL_TIMEOUT_MS = 3 * 60_000;
const CAPTURE_HISTORY_POLL_MS = 1_000;
const CAPTURE_HISTORY_MAX_APP_STARTS = 3;

export interface CapturedStartingDatabase {
  label: string;
  defaultArgonAccountId: string;
  instancePackagePath: string;
  databaseSha256: string;
  migration?: number;
  quickCheck: string;
  history: {
    throughBlock: number;
    walletHistoryThroughBlock?: number;
    financialDomains: IFinancialHistoryDomain[];
    partialFinancialDomains: IFinancialHistoryDomain[];
    pendingBitcoinLocks?: number;
    complete: boolean;
    recoveryError?: string;
  };
  selection: {
    features: OperationalAccountFeature[];
    upstreamScenario?: string;
  };
  expected: {
    bitcoinLiquidIds: number[];
    archivedBitcoinLiquidIds: number[];
    bondLotIds: number[];
    flexibleBondLotIds: number[];
    stakeLotIds: number[];
    historicalBondLotIds: number[];
    historicalStakeLotIds: number[];
    vaultBitcoinMapItemCount?: number;
    vaultBondMapItemCount?: number;
    configuredServer: boolean;
    operations: boolean;
    treasury: boolean;
    upstream: boolean;
  };
}

export interface StartingDatabaseRegistry {
  formatVersion: 4;
  sourceApp: {
    version: string;
    gitHead: string;
    runtimeQueriesSha256: string;
    historicalEventsSha256: string;
  };
  environment: {
    network: 'mainnet';
    blockNumber: number;
    blockHash: string;
    deployedSpecVersion: number;
  };
  throughBlock: number;
  selection: {
    kind: 'operational-account-graph';
    accountLimit: number;
    graphAccounts: number;
    selectedAccounts: number;
    features: OperationalAccountFeature[];
  };
  coverage: {
    completeHistoryAccounts: number;
    complete: boolean;
  };
  accounts: CapturedStartingDatabase[];
  failures: Array<{
    label: string;
    error: string;
  }>;
}

export class StartingDatabaseCapture {
  private readonly registry: StartingDatabaseRegistry;
  private readonly vaultBitcoinMapItemCounts = new Map<number, number>();

  private constructor(
    private readonly mainnet: LocalMainnet,
    private readonly previousAppsDirectory: string,
    private readonly outputDirectory: string,
    private readonly accountLimit: number,
  ) {
    const packageJson = JSON.parse(readFileSync(Path.join(previousAppsDirectory, 'package.json'), 'utf8')) as {
      version?: string;
    };
    this.registry = {
      formatVersion: 4,
      sourceApp: {
        version: packageJson.version ?? 'unknown',
        gitHead: execFileSync('git', ['-C', previousAppsDirectory, 'rev-parse', 'HEAD'], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        }).trim(),
        runtimeQueriesSha256: createHash('sha256')
          .update(readFileSync(Path.join(previousAppsDirectory, 'runtime-client/src/RuntimeQueries.generated.ts')))
          .digest('hex'),
        historicalEventsSha256: createHash('sha256')
          .update(readFileSync(Path.join(previousAppsDirectory, 'runtime-client/src/HistoricalEvents.generated.ts')))
          .digest('hex'),
      },
      environment: {
        network: 'mainnet',
        blockNumber: mainnet.deployedBlock.number,
        blockHash: mainnet.deployedBlock.hash,
        deployedSpecVersion: mainnet.deployedBlock.runtimeSpecVersion,
      },
      throughBlock: mainnet.deployedBlock.number,
      selection: {
        kind: 'operational-account-graph',
        accountLimit,
        graphAccounts: 0,
        selectedAccounts: 0,
        features: [],
      },
      coverage: {
        completeHistoryAccounts: 0,
        complete: false,
      },
      accounts: [],
      failures: [],
    };
  }

  public static async runFromCommandLine(): Promise<void> {
    const { values } = parseArgs({
      options: {
        'account-limit': { type: 'string', default: '12' },
        manifest: { type: 'string' },
        output: { type: 'string' },
        'previous-app-ref': { type: 'string' },
        'previous-apps': { type: 'string' },
      },
      strict: true,
    });
    if (!values.manifest || !values.output || !values['previous-apps'] || !values['previous-app-ref']) {
      throw new Error(
        'Usage: yarn local-mainnet:capture --manifest <manifest.json> --previous-apps <previous-apps-checkout> --previous-app-ref <release-tag-or-commit> --output <new-output-directory> [--account-limit <count>]',
      );
    }

    const manifestPath = realpathSync(values.manifest);
    const previousAppsDirectory = realpathSync(values['previous-apps']);
    const outputDirectory = Path.resolve(values.output);
    try {
      if (!statSync(previousAppsDirectory).isDirectory()) throw new Error();
      if (!statSync(Path.join(previousAppsDirectory, 'package.json')).isFile()) throw new Error();
    } catch {
      throw new Error(`Previous Apps checkout is not a repository root: ${previousAppsDirectory}`);
    }
    const previousAppsHead = execFileSync('git', ['-C', previousAppsDirectory, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    const expectedPreviousAppsHead = execFileSync(
      'git',
      ['-C', previousAppsDirectory, 'rev-parse', `${values['previous-app-ref']}^{commit}`],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    ).trim();
    if (previousAppsHead !== expectedPreviousAppsHead) {
      throw new Error(
        `Previous Apps checkout is at ${previousAppsHead}, but ${values['previous-app-ref']} resolves to ${expectedPreviousAppsHead}`,
      );
    }
    const previousAppsChanges = execFileSync(
      'git',
      ['-C', previousAppsDirectory, 'status', '--porcelain=v1', '--untracked-files=no'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    ).trim();
    if (previousAppsChanges) {
      throw new Error(`Previous Apps checkout has tracked changes and cannot be used as a release source`);
    }
    execFileSync('yarn', ['generate:runtime-client'], {
      cwd: previousAppsDirectory,
      stdio: 'inherit',
    });
    const accountLimit = Number(values['account-limit']);
    if (!Number.isSafeInteger(accountLimit) || accountLimit < 1) {
      throw new Error(`--account-limit must be a positive safe integer, got ${values['account-limit']}`);
    }

    const manifest = loadLocalMainnetManifest(manifestPath);
    mkdirSync(Path.dirname(outputDirectory), { recursive: true });
    try {
      mkdirSync(outputDirectory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new Error(`Capture output directory already exists: ${outputDirectory}`);
      }
      throw error;
    }

    const mainnet = await LocalMainnet.start({
      manifest,
      runDirectory: Path.join(outputDirectory, 'environment'),
    });
    const capture = new StartingDatabaseCapture(mainnet, previousAppsDirectory, outputDirectory, accountLimit);
    try {
      await capture.run();
    } finally {
      await mainnet.close();
    }
  }

  private async run(): Promise<void> {
    this.writeRegistry();
    const client = createArgonClient(await getClient(this.mainnet.archiveUrl));
    try {
      const graph = await OperationalAccountGraph.load(client);
      const scenarios = graph.selectConnectedScenarios(this.accountLimit);
      const labelsByOperationalAccountId = new Map(
        scenarios.map((scenario, index) => [
          scenario.operationalAccountId,
          `scenario-${String(index + 1).padStart(3, '0')}`,
        ]),
      );
      this.registry.selection.graphAccounts = graph.nodes.length;
      this.registry.selection.selectedAccounts = scenarios.length;
      this.registry.selection.features = OPERATIONAL_ACCOUNT_FEATURES.filter(feature =>
        scenarios.some(scenario => scenario.features.includes(feature)),
      );
      if (scenarios.some(scenario => scenario.features.includes('vault'))) {
        const locksById = client.query.bitcoinLocks.locksById;
        if (!locksById) throw new Error('Deployed runtime does not expose Bitcoin lock storage');
        for (const [, lock] of (await locksById.entries()) ?? []) {
          if (!lock || lock.fundedSatoshis <= 0n) continue;
          this.vaultBitcoinMapItemCounts.set(lock.vaultId, (this.vaultBitcoinMapItemCounts.get(lock.vaultId) ?? 0) + 1);
        }
      }

      for (const [index, scenario] of scenarios.entries()) {
        const label = labelsByOperationalAccountId.get(scenario.operationalAccountId)!;
        const upstreamScenario = labelsByOperationalAccountId.get(scenario.upstreamOperationalAccountId ?? '');
        try {
          await this.captureAccount({ client, scenario, label, index, upstreamScenario });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.registry.failures.push({ label, error: message });
          console.error(`[local-mainnet] ${label}: ${message}`);
        }
        this.updateCoverage();
        this.writeRegistry();
      }
    } finally {
      await client.disconnect();
    }

    console.info(`Captured ${this.registry.accounts.length} starting database(s) in ${this.outputDirectory}.`);
    if (this.registry.failures.length) {
      console.warn(`${this.registry.failures.length} account(s) did not produce a database package.`);
    }
    if (!this.registry.coverage.complete) {
      throw new Error(
        `The capture did not qualify: ${this.registry.accounts.length}/${this.registry.selection.selectedAccounts} selected accounts produced packages and the selected feature coverage was ${this.registry.selection.features.length}/${OPERATIONAL_ACCOUNT_FEATURES.length}. Retained packages remain available for diagnosis, but the registry cannot be used for candidate review.`,
      );
    }
  }

  private async captureAccount(args: {
    client: ArgonClient;
    scenario: OperationalAccountGraphNode;
    label: string;
    index: number;
    upstreamScenario?: string;
  }): Promise<void> {
    const { client, scenario, label, index, upstreamScenario } = args;
    const { identity } = scenario;
    const instanceName = `mainnet-capture-${Date.now().toString(36)}-${index + 1}-${label}`.slice(0, 80);
    const instanceDirectory = AppSession.resolveInstanceDirectory({ networkName: 'mainnet', instanceName });
    if (existsSync(instanceDirectory)) throw new Error(`Capture instance already exists: ${instanceDirectory}`);
    writeReadonlyWallet(instanceDirectory, identity);

    const recoveryError = await this.recoverStartingDatabase(
      instanceName,
      Path.join(instanceDirectory, 'database.sqlite'),
    );

    const databasePath = Path.join(instanceDirectory, 'database.sqlite');
    if (!existsSync(databasePath)) {
      throw new Error('The previous app did not create a database');
    }

    const packageDirectory = Path.join(this.outputDirectory, 'starting-databases', label);
    mkdirSync(Path.dirname(packageDirectory), { recursive: true });
    cpSync(instanceDirectory, packageDirectory, { recursive: true, errorOnExist: true, force: false });

    const copiedDatabasePath = Path.join(packageDirectory, 'database.sqlite');
    const facts = inspectStartingDatabase(copiedDatabasePath, this.registry.throughBlock, identity.defaultAccountId);
    const walletHistoryThroughBlock = facts.walletHistoryThroughBlock;
    const complete = isStartingDatabaseComplete(facts, this.registry.throughBlock);
    if (facts.quickCheck !== 'ok') {
      throw new Error(`The copied database for ${label} failed its integrity check: ${facts.quickCheck}`);
    }
    if (!recoveryError && !complete) {
      throw new Error(`The copied database for ${label} lost its complete recovery checkpoint`);
    }
    const [activeFissions, activeBondLots, vault] = await Promise.all([
      client
        .at(this.mainnet.deployedBlock.hash)
        .then(at => BitcoinFission.getAllByOwner(at, identity.defaultAccountId)),
      TreasuryBonds.getBondLotsByAccount(client, identity.defaultAccountId),
      getVaultByOperator({ client, operatorAddress: identity.defaultAccountId }),
    ]);
    const vaultBondLots = vault
      ? await TreasuryBonds.getBondLots(client, vault.vaultId, identity.defaultAccountId)
      : [];
    const vaultBitcoinMapItemCount = vault ? (this.vaultBitcoinMapItemCounts.get(vault.vaultId) ?? 0) : undefined;

    this.registry.accounts.push({
      label,
      defaultArgonAccountId: identity.defaultAccountId,
      instancePackagePath: packageDirectory,
      databaseSha256: createHash('sha256').update(readFileSync(copiedDatabasePath)).digest('hex'),
      migration: facts.migration,
      quickCheck: facts.quickCheck,
      history: {
        throughBlock: this.registry.throughBlock,
        walletHistoryThroughBlock,
        financialDomains: facts.financialDomains,
        partialFinancialDomains: facts.partialFinancialDomains,
        pendingBitcoinLocks: facts.pendingBitcoinLocks,
        complete,
        ...(recoveryError ? { recoveryError } : {}),
      },
      selection: {
        features: scenario.features,
        ...(upstreamScenario ? { upstreamScenario } : {}),
      },
      expected: {
        bitcoinLiquidIds: [
          ...new Set([...activeFissions.map(fission => fission.liquidId), ...facts.bitcoinLiquidIds]),
        ].sort((a, b) => a - b),
        archivedBitcoinLiquidIds: facts.archivedBitcoinLiquidIds,
        bondLotIds: activeBondLots
          .filter(lot => lot.programType === 'Vault')
          .map(lot => lot.id)
          .sort((a, b) => a - b),
        flexibleBondLotIds: activeBondLots
          .filter(lot => lot.programType === 'Vault' && lot.isFlexible)
          .map(lot => lot.id)
          .sort((a, b) => a - b),
        stakeLotIds: activeBondLots
          .filter(lot => lot.programType === 'Argonot')
          .map(lot => lot.id)
          .sort((a, b) => a - b),
        historicalBondLotIds: facts.bondLotIds,
        historicalStakeLotIds: facts.stakeLotIds,
        ...(vaultBitcoinMapItemCount === undefined ? {} : { vaultBitcoinMapItemCount }),
        ...(vault ? { vaultBondMapItemCount: vaultBondLots.filter(lot => lot.activeBonds > 0).length } : {}),
        configuredServer: facts.configuredServer,
        operations: facts.operations,
        treasury: facts.treasury,
        upstream: facts.upstream,
      },
    });
    console.info(
      `[local-mainnet] ${label}: captured ${complete ? 'complete history' : 'incomplete history for candidate repair'}`,
    );
  }

  private async recoverStartingDatabase(instanceName: string, databasePath: string): Promise<string | undefined> {
    const timeoutAt = Date.now() + CAPTURE_HISTORY_TIMEOUT_MS;
    let recoveryProgress: StartingDatabaseRecoveryProgress | undefined;
    let progressKey: string | undefined;
    let inspectionError: string | undefined;
    let shutdownError: string | undefined;

    for (let appStart = 1; appStart <= CAPTURE_HISTORY_MAX_APP_STARTS && Date.now() < timeoutAt; appStart += 1) {
      const session = await this.mainnet.launchApp({
        appsDirectory: this.previousAppsDirectory,
        instanceName,
        tauriDevConfig: {
          capabilities: ['default', 'dev'],
          beforeDevCommand: 'yarn vite',
        },
        appLogsMode: 'quiet',
        autoEnableOperations: false,
      });

      let stalledAt = Date.now() + CAPTURE_HISTORY_STALL_TIMEOUT_MS;
      let completedProgress: StartingDatabaseRecoveryProgress | undefined;
      let restartReason = 'recovery stalled';
      let shutdownComplete = true;
      let permanentHistoryError: string | undefined;
      try {
        while (Date.now() < timeoutAt && Date.now() < stalledAt) {
          // These structural failures cannot change on the pinned fork by restarting the same release.
          permanentHistoryError = session.frontendErrors.find(
            error =>
              error.includes('[FinancialHistory] Unable to initialize recovery') &&
              /missing (?:its )?creation event|does not match recovered history|has \d+ signatures for \d+ inputs/.test(
                error,
              ),
          );
          if (permanentHistoryError) break;
          try {
            const nextProgress = inspectStartingDatabaseRecovery(databasePath, this.registry.throughBlock);
            const nextProgressKey = JSON.stringify(nextProgress);
            recoveryProgress = nextProgress;
            inspectionError = undefined;
            if (isStartingDatabaseHistoryRecovered(nextProgress, this.registry.throughBlock)) {
              completedProgress = nextProgress;
              break;
            }
            if (nextProgressKey !== progressKey) {
              progressKey = nextProgressKey;
              stalledAt = Date.now() + CAPTURE_HISTORY_STALL_TIMEOUT_MS;
            }
          } catch (error) {
            inspectionError = error instanceof Error ? error.message : String(error);
          }
          await delay(CAPTURE_HISTORY_POLL_MS);
        }
      } finally {
        await this.mainnet.closeApp().catch(error => {
          shutdownComplete = false;
          restartReason = 'checkpoint or shutdown failed';
          shutdownError = error instanceof Error ? error.message : String(error);
        });
      }
      if (!shutdownComplete) {
        throw new Error(`The previous app could not checkpoint and close: ${shutdownError}`);
      }
      if (completedProgress) return;
      if (permanentHistoryError) return permanentHistoryError;

      if (appStart < CAPTURE_HISTORY_MAX_APP_STARTS && Date.now() < timeoutAt) {
        console.warn(`[local-mainnet] ${restartReason}; restarting previous app (${appStart + 1})`);
      }
    }

    const progress = recoveryProgress
      ? `wallet=${recoveryProgress.walletHistoryThroughBlock}, domains=${recoveryProgress.financialDomains.join(',') || 'none'}, partial=${recoveryProgress.partialFinancialDomains.join(',') || 'none'}, pendingBitcoin=${recoveryProgress.pendingBitcoinLocks ?? 'unknown'}`
      : (inspectionError ?? 'database unavailable');
    return `The previous app did not complete account history through block ${this.registry.throughBlock}: ${progress}`;
  }

  private writeRegistry(): void {
    const registryPath = Path.join(this.outputDirectory, 'starting-databases.json');
    const pendingPath = `${registryPath}.tmp`;
    writeFileSync(pendingPath, `${JSON.stringify(this.registry, null, 2)}\n`);
    renameSync(pendingPath, registryPath);
  }

  private updateCoverage(): void {
    this.registry.coverage.completeHistoryAccounts = this.registry.accounts.filter(
      account => account.history.complete,
    ).length;
    this.registry.coverage.complete =
      this.registry.accounts.length === this.registry.selection.selectedAccounts &&
      this.registry.failures.length === 0 &&
      this.registry.selection.features.length === OPERATIONAL_ACCOUNT_FEATURES.length;
  }
}

if (process.argv[1] && Path.resolve(process.argv[1]) === Path.resolve(import.meta.filename)) {
  void StartingDatabaseCapture.runFromCommandLine().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
