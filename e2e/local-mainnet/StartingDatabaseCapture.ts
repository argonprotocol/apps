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
import { createArgonClient, getVaultByOperator, TreasuryBonds, type ArgonQueryClient } from '@argonprotocol/apps-core';
import { getClient } from '@argonprotocol/mainchain';
import { DatabaseSync } from 'node:sqlite';
import { AppSession } from '../AppSession.ts';
import { SyncStateKeys, type IFinancialHistoryDomain, type ISyncSchemas } from 'src-vue/lib/db/SyncStateTable.ts';
import { writeReadonlyWallet } from '../../scripts/troubleshootAccount.ts';
import { CapturedDatabaseScenario } from './CapturedDatabaseScenario.ts';
import { LocalMainnet } from './LocalMainnet.ts';
import { loadLocalMainnetManifest } from './manifest.ts';
import {
  OPERATIONAL_ACCOUNT_FEATURES,
  OperationalAccountGraph,
  type OperationalAccountFeature,
  type OperationalAccountGraphNode,
} from './OperationalAccountGraph.ts';

const FINANCIAL_HISTORY_DOMAINS = [
  'bitcoin',
  'bonds',
  'vaulting',
] as const satisfies readonly IFinancialHistoryDomain[];

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
  };
  selection: {
    features: OperationalAccountFeature[];
    upstreamScenario?: string;
  };
  legacyBitcoin: {
    migratableIds: number[];
    fundedIds: number[];
    releasedIds: number[];
  };
  expected: {
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
  captureError?: string;
}

export interface StartingDatabaseRegistry {
  formatVersion: 1;
  sourceApp: {
    version: string;
    gitHead: string;
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
    releasedLegacyBitcoinAccounts: number;
    releasedLegacyBitcoinIds: number;
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
      formatVersion: 1,
      sourceApp: {
        version: packageJson.version ?? 'unknown',
        gitHead: execFileSync('git', ['-C', previousAppsDirectory, 'rev-parse', 'HEAD'], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        }).trim(),
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
        releasedLegacyBitcoinAccounts: 0,
        releasedLegacyBitcoinIds: 0,
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
        'previous-apps': { type: 'string' },
      },
      strict: true,
    });
    if (!values.manifest || !values.output || !values['previous-apps']) {
      throw new Error(
        'Usage: yarn local-mainnet:capture --manifest <manifest.json> --previous-apps <previous-apps-checkout> --output <new-output-directory> [--account-limit <count>]',
      );
    }

    const manifestPath = realpathSync(values.manifest);
    const previousAppsDirectory = realpathSync(values['previous-apps']);
    const outputDirectory = Path.resolve(values.output);
    if (
      !statSync(previousAppsDirectory).isDirectory() ||
      !existsSync(Path.join(previousAppsDirectory, 'package.json'))
    ) {
      throw new Error(`Previous Apps checkout is not a repository root: ${previousAppsDirectory}`);
    }
    const accountLimit = Number(values['account-limit']);
    if (!Number.isSafeInteger(accountLimit) || accountLimit < 1) {
      throw new Error(`--account-limit must be a positive safe integer, got ${values['account-limit']}`);
    }
    if (existsSync(outputDirectory)) throw new Error(`Capture output directory already exists: ${outputDirectory}`);

    const manifest = loadLocalMainnetManifest(manifestPath);
    mkdirSync(outputDirectory, { recursive: true });

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
        try {
          await this.captureAccount(
            client,
            label,
            scenario,
            labelsByOperationalAccountId.get(scenario.upstreamOperationalAccountId ?? ''),
            index,
          );
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
    if (!this.registry.coverage.releasedLegacyBitcoinAccounts) {
      throw new Error(
        'The captured operational-account graph contains no released legacy Bitcoin record to verify in the candidate app.',
      );
    }
    if (!this.registry.coverage.complete) {
      throw new Error(
        `The capture did not qualify: ${this.registry.accounts.length}/${this.registry.selection.selectedAccounts} selected accounts produced packages and the selected feature coverage was ${this.registry.selection.features.length}/${OPERATIONAL_ACCOUNT_FEATURES.length}. All retained packages remain available for candidate-app review.`,
      );
    }
  }

  private async captureAccount(
    client: ArgonQueryClient,
    label: string,
    scenario: OperationalAccountGraphNode,
    upstreamScenario: string | undefined,
    index: number,
  ): Promise<void> {
    const instanceName = `mainnet-capture-${Date.now().toString(36)}-${index + 1}-${label}`.slice(0, 80);
    const instanceDirectory = AppSession.resolveInstanceDirectory({ networkName: 'mainnet', instanceName });
    if (existsSync(instanceDirectory)) throw new Error(`Capture instance already exists: ${instanceDirectory}`);
    writeReadonlyWallet(instanceDirectory, scenario.identity);

    const activeBondLots = await TreasuryBonds.getBondLotsByAccount(client, scenario.identity.defaultAccountId);
    const vault = await getVaultByOperator({
      client,
      operatorAddress: scenario.identity.defaultAccountId,
    });
    const vaultBondLots = vault
      ? await TreasuryBonds.getBondLots(client, vault.vaultId, scenario.identity.defaultAccountId)
      : [];
    const vaultBitcoinMapItemCount = vault ? (this.vaultBitcoinMapItemCounts.get(vault.vaultId) ?? 0) : undefined;

    let captureError: string | undefined;
    try {
      await this.mainnet.launchApp({
        appsDirectory: this.previousAppsDirectory,
        instanceName,
        appLogsMode: 'quiet',
        autoEnableOperations: false,
      });
    } catch (error) {
      captureError = error instanceof Error ? error.message : String(error);
    } finally {
      await this.mainnet.closeApp().catch(error => {
        const closeError = error instanceof Error ? error.message : String(error);
        captureError = captureError ? `${captureError}; shutdown: ${closeError}` : closeError;
      });
    }

    const databasePath = Path.join(instanceDirectory, 'database.sqlite');
    if (!existsSync(databasePath)) {
      throw new Error(captureError ?? 'The previous app did not create a database');
    }

    const packageDirectory = Path.join(this.outputDirectory, 'starting-databases', label);
    mkdirSync(Path.dirname(packageDirectory), { recursive: true });
    cpSync(instanceDirectory, packageDirectory, { recursive: true, errorOnExist: true, force: false });

    const copiedDatabasePath = Path.join(packageDirectory, 'database.sqlite');
    let facts: ReturnType<typeof StartingDatabaseCapture.inspectDatabase> = {
      quickCheck: 'inspection failed',
      walletHistoryThroughBlock: 0,
      financialDomains: [],
      partialFinancialDomains: [],
      bondLotIds: [],
      stakeLotIds: [],
      configuredServer: false,
      operations: false,
      treasury: false,
      upstream: false,
    };
    let legacyBitcoin: ReturnType<typeof CapturedDatabaseScenario.inspectLegacyBitcoinLocks> = {
      all: [],
      funded: [],
      released: [],
    };
    try {
      facts = StartingDatabaseCapture.inspectDatabase(
        copiedDatabasePath,
        this.registry.throughBlock,
        scenario.identity.defaultAccountId,
      );
    } catch (error) {
      const inspectionError = error instanceof Error ? error.message : String(error);
      captureError = captureError
        ? `${captureError}; inspection: ${inspectionError}`
        : `inspection: ${inspectionError}`;
    }
    try {
      legacyBitcoin = CapturedDatabaseScenario.inspectLegacyBitcoinLocks(copiedDatabasePath);
    } catch (error) {
      const inspectionError = error instanceof Error ? error.message : String(error);
      captureError = captureError
        ? `${captureError}; legacy Bitcoin inspection: ${inspectionError}`
        : `legacy Bitcoin inspection: ${inspectionError}`;
    }
    const walletHistoryThroughBlock = facts.walletHistoryThroughBlock;
    const complete =
      facts.quickCheck === 'ok' &&
      walletHistoryThroughBlock >= this.registry.throughBlock &&
      FINANCIAL_HISTORY_DOMAINS.every(domain => facts.financialDomains.includes(domain)) &&
      facts.partialFinancialDomains.length === 0 &&
      facts.pendingBitcoinLocks === 0;

    this.registry.accounts.push({
      label,
      defaultArgonAccountId: scenario.identity.defaultAccountId,
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
      },
      selection: {
        features: scenario.features,
        ...(upstreamScenario ? { upstreamScenario } : {}),
      },
      legacyBitcoin: {
        migratableIds: legacyBitcoin.all,
        fundedIds: legacyBitcoin.funded,
        releasedIds: legacyBitcoin.released,
      },
      expected: {
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
      ...(captureError ? { captureError } : {}),
    });
    console.info(`[local-mainnet] ${label}: captured${complete ? ' with complete history' : ' as incomplete'}`);
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
    const releasedAccounts = this.registry.accounts.filter(account => account.legacyBitcoin.releasedIds.length);
    this.registry.coverage.releasedLegacyBitcoinAccounts = releasedAccounts.length;
    this.registry.coverage.releasedLegacyBitcoinIds = releasedAccounts.reduce(
      (total, account) => total + account.legacyBitcoin.releasedIds.length,
      0,
    );
    this.registry.coverage.complete =
      this.registry.accounts.length === this.registry.selection.selectedAccounts &&
      this.registry.selection.features.length === OPERATIONAL_ACCOUNT_FEATURES.length &&
      this.registry.coverage.releasedLegacyBitcoinAccounts > 0;
  }

  private static inspectDatabase(
    path: string,
    throughBlock: number,
    accountId: string,
  ): {
    migration?: number;
    quickCheck: string;
    walletHistoryThroughBlock: number;
    financialDomains: IFinancialHistoryDomain[];
    partialFinancialDomains: IFinancialHistoryDomain[];
    pendingBitcoinLocks?: number;
    bondLotIds: number[];
    stakeLotIds: number[];
    configuredServer: boolean;
    operations: boolean;
    treasury: boolean;
    upstream: boolean;
  } {
    const database = new DatabaseSync(path, { open: true, readOnly: true });
    try {
      const quickCheck = database.prepare('PRAGMA quick_check').get() as { quick_check: string };
      let migration: number | undefined;
      try {
        migration = (
          database.prepare('SELECT MAX(version) AS version FROM _sqlx_migrations').get() as {
            version?: number;
          }
        ).version;
      } catch {
        // A database created before its first migration is still useful candidate-app input.
      }

      let states: Array<{
        key: SyncStateKeys.WalletHistory | SyncStateKeys.FinancialHistory;
        state: string;
      }> = [];
      try {
        states = database
          .prepare('SELECT key, state FROM SyncState WHERE key IN (?, ?)')
          .all(SyncStateKeys.WalletHistory, SyncStateKeys.FinancialHistory) as unknown as typeof states;
      } catch {
        // Missing recovery tables make the package incomplete, not disposable.
      }
      let walletHistory: Partial<ISyncSchemas[SyncStateKeys.WalletHistory]> = {};
      let financialHistory: Partial<ISyncSchemas[SyncStateKeys.FinancialHistory]> = {};
      try {
        walletHistory = JSON.parse(
          states.find(state => state.key === SyncStateKeys.WalletHistory)?.state ?? '{}',
        ) as typeof walletHistory;
        financialHistory = JSON.parse(
          states.find(state => state.key === SyncStateKeys.FinancialHistory)?.state ?? '{}',
        ) as typeof financialHistory;
      } catch {
        // Invalid recovery state makes the package incomplete, not disposable.
      }
      const domainCheckpoints = financialHistory.domainCheckpoints ?? {};
      const financialDomains = FINANCIAL_HISTORY_DOMAINS.filter(
        domain => (domainCheckpoints[domain]?.asOfBlock ?? 0) >= throughBlock,
      );
      const partialFinancialDomains = FINANCIAL_HISTORY_DOMAINS.filter(
        domain => domainCheckpoints[domain]?.partialRecovery,
      );
      let pendingBitcoinLocks: number | undefined;
      try {
        pendingBitcoinLocks = (
          database.prepare('SELECT COUNT(*) AS count FROM BitcoinLocks WHERE isHistoryRecoveryPending = 1').get() as {
            count: number;
          }
        ).count;
      } catch {
        // Missing Bitcoin recovery state cannot be claimed complete.
      }
      let bondLots: Array<{ programType: 'Vault' | 'Argonot'; bondLotId: number }> = [];
      try {
        bondLots = database
          .prepare(
            'SELECT programType, bondLotId FROM BondLotHistory WHERE accountId = ? AND releaseBlockHash IS NOT NULL ORDER BY bondLotId',
          )
          .all(accountId) as unknown as typeof bondLots;
      } catch {
        // The previous release may not have created bond history yet; current chain expectations still apply.
      }
      const config = new Map<string, string>();
      try {
        const rows = database
          .prepare(
            `SELECT key, value FROM Config
             WHERE key IN ('hasExtensionOperations', 'hasExtensionTreasury', 'serverAdd', 'upstreamOperator')`,
          )
          .all() as unknown as Array<{ key: string; value: string }>;
        for (const row of rows) config.set(row.key, row.value);
      } catch {
        // A missing Config table means the expected optional features remain disabled.
      }
      const hasConfigValue = (key: string): boolean => {
        const value = config.get(key);
        if (!value) return false;
        try {
          return Boolean(JSON.parse(value));
        } catch {
          return false;
        }
      };

      return {
        migration,
        quickCheck: quickCheck.quick_check,
        walletHistoryThroughBlock: walletHistory.asOfBlock ?? 0,
        financialDomains,
        partialFinancialDomains,
        pendingBitcoinLocks,
        bondLotIds: bondLots.filter(lot => lot.programType === 'Vault').map(lot => lot.bondLotId),
        stakeLotIds: bondLots.filter(lot => lot.programType === 'Argonot').map(lot => lot.bondLotId),
        configuredServer: hasConfigValue('serverAdd'),
        operations: hasConfigValue('hasExtensionOperations'),
        treasury: hasConfigValue('hasExtensionTreasury'),
        upstream: hasConfigValue('upstreamOperator'),
      };
    } finally {
      database.close();
    }
  }
}

if (process.argv[1] && Path.resolve(process.argv[1]) === Path.resolve(import.meta.filename)) {
  void StartingDatabaseCapture.runFromCommandLine().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
