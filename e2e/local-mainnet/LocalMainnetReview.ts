import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import Path from 'node:path';
import process from 'node:process';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  ACCOUNT_ACTIVITY_DEFINITION_VERSION,
  AccountActivityKind,
  BondLot,
  TreasuryBonds,
  type IIndexerSpec,
  type ArgonApi,
} from '@argonprotocol/apps-core';
import { getClient } from '@argonprotocol/mainchain';
import { runtimeClient } from '@argonprotocol/runtime-client';
import type { IFinancialAggregate } from 'src-vue/interfaces/IFinancialPosition.ts';
import { FlowSession } from '../FlowSession.ts';
import { AccountRecoverySnapshot, type AccountRecoverySnapshotResult } from './AccountRecoverySnapshot.ts';
import { LocalMainnet } from './LocalMainnet.ts';
import { loadLocalMainnetManifest } from './manifest.ts';
import type { CapturedStartingDatabase, StartingDatabaseRegistry } from './StartingDatabaseCapture.ts';
import { RuntimeCandidate, type CandidateRuntimeArtifact } from './RuntimeCandidate.ts';
import {
  inspectStartingDatabase,
  isStartingDatabaseComplete,
  type StartingDatabaseRecoveryProgress,
  type StartingDatabaseInspection,
} from './StartingDatabaseInspection.ts';

export interface AccountReviewResult {
  label: string;
  status: 'passed' | 'failed';
  error?: string;
  durationMs: number;
  history?: StartingDatabaseRecoveryProgress &
    Pick<StartingDatabaseInspection, 'quickCheck' | 'bitcoinFissionIds'> & {
      throughBlock: number;
      expectedBitcoinFissionIds: number[];
    };
}

export class LocalMainnetReview {
  private historyThroughBlock: number | undefined;
  private nextInstanceId = 1;
  private readonly instancePrefix = Date.now().toString(36);
  private readonly validationFailures: string[] = [];
  private readonly batchResults: AccountReviewResult[] = [];

  private constructor(
    private readonly mainnet: LocalMainnet,
    private readonly appsDirectory: string,
    private readonly candidate: CandidateRuntimeArtifact,
    private readonly registry: StartingDatabaseRegistry,
    private readonly verifyRecoveryIdempotence: boolean,
  ) {}

  private get accounts(): CapturedStartingDatabase[] {
    return this.registry.accounts;
  }

  public static async runFromCommandLine(): Promise<void> {
    const { values } = parseArgs({
      options: {
        account: { type: 'string' },
        accounts: { type: 'string' },
        all: { type: 'boolean' },
        candidate: { type: 'string' },
        diagnostic: { type: 'boolean' },
        manifest: { type: 'string' },
        'run-directory': { type: 'string' },
        'verify-recovery-idempotence': { type: 'boolean' },
      },
      strict: true,
    });
    if (!values.manifest || !values.candidate) {
      throw new Error(
        'Usage: yarn local-mainnet:review --manifest <manifest.json> --candidate <attestation.json> [--accounts <starting-databases.json>] [--account <label>] [--all] [--diagnostic] [--verify-recovery-idempotence] [--run-directory <path>]',
      );
    }
    if (values.diagnostic && (!values.all || values.account)) {
      throw new Error('--diagnostic requires --all without --account; it cannot qualify a partial capture');
    }

    const manifestPath = realpathSync(values.manifest);
    const accountsPath = realpathSync(
      values.accounts ?? Path.join(Path.dirname(manifestPath), 'starting-databases.json'),
    );
    const appsDirectory = realpathSync(process.cwd());
    const runDirectory = Path.resolve(
      values['run-directory'] ??
        Path.join(Path.dirname(manifestPath), 'reviews', new Date().toISOString().replace(/[:.]/g, '-')),
    );
    if (existsSync(runDirectory)) throw new Error(`Review run directory already exists: ${runDirectory}`);
    mkdirSync(Path.dirname(runDirectory), { recursive: true });

    const manifest = loadLocalMainnetManifest(manifestPath);
    const candidate = RuntimeCandidate.load(values.candidate);
    if (candidate.expectedSpecVersion < manifest.archive.deployedSpecVersion) {
      throw new Error(
        `Candidate runtime spec ${candidate.expectedSpecVersion} is older than deployed spec ${manifest.archive.deployedSpecVersion}; update the Mainchain pin`,
      );
    }
    const { registry, captureQualified } = await LocalMainnetReview.loadRegistry(accountsPath, values.diagnostic);
    const accounts = registry.accounts;
    const firstAccount = values.account ? LocalMainnetReview.findAccount(accounts, values.account) : accounts[0];
    if (!firstAccount) throw new Error('Starting database registry contains no accounts');

    const mainnet = await LocalMainnet.start({ manifest, runDirectory });
    if (
      registry.environment.network !== manifest.network ||
      registry.environment.blockNumber !== mainnet.deployedBlock.number ||
      registry.environment.blockHash !== mainnet.deployedBlock.hash ||
      registry.environment.deployedSpecVersion !== mainnet.deployedBlock.runtimeSpecVersion
    ) {
      await mainnet.close();
      throw new Error('Starting database registry was captured from a different local mainnet environment');
    }
    const review = new LocalMainnetReview(
      mainnet,
      appsDirectory,
      candidate,
      registry,
      values['verify-recovery-idempotence'] ?? false,
    );
    try {
      await review.deploy();
      if (values.all) {
        // Batch app windows are not foregrounded; keep overlay visibility checks independent of animation frames.
        process.env.ARGON_E2E_HEADLESS = '1';
        await review.reviewAll(runDirectory, values.account ? [firstAccount] : accounts);
      } else {
        await review.open(firstAccount);
        await review.readCommands();
      }
      if (review.validationFailures.length) {
        throw new Error(`${review.validationFailures.length} account review(s) failed scripted validation`);
      }
      if (!captureQualified) {
        throw new Error(
          'Diagnostic review finished, but the starting database capture is incomplete; release is not qualified',
        );
      }
    } finally {
      await mainnet.close();
    }
  }

  private async reviewAll(runDirectory: string, accounts: readonly CapturedStartingDatabase[]): Promise<void> {
    const resultsPath = Path.join(runDirectory, 'account-results.json');
    for (const account of accounts) {
      const startedAt = Date.now();
      try {
        const history = await this.open(account, false);
        this.batchResults.push({ label: account.label, status: 'passed', durationMs: Date.now() - startedAt, history });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.validationFailures.push(account.label);
        this.batchResults.push({
          label: account.label,
          status: 'failed',
          error: message,
          durationMs: Date.now() - startedAt,
        });
        console.error(`${account.label} failed: ${message}`);
      }
      writeFileSync(resultsPath, `${JSON.stringify(this.batchResults, null, 2)}\n`);
    }
    await this.mainnet.closeApp();
    console.info(`Account results: ${resultsPath}`);
  }

  private async readCommands(): Promise<void> {
    console.info('\nThe candidate app is open against the candidate runtime.');
    console.info('Commands: open <account> | list | quit');
    const input = createInterface({ input: process.stdin, output: process.stdout });
    try {
      while (true) {
        const command = (await input.question('local-mainnet> ')).trim();
        if (!command) continue;
        if (command === 'quit' || command === 'exit') return;
        if (command === 'list') {
          console.info(this.accounts.map(account => LocalMainnetReview.describeAccount(account)).join('\n'));
          continue;
        }
        if (command.startsWith('open ')) {
          await this.open(LocalMainnetReview.findAccount(this.accounts, command.slice(5).trim()));
          continue;
        }
        console.warn(`Unknown command: ${command}`);
      }
    } finally {
      input.close();
    }
  }

  private async deploy(): Promise<void> {
    const deployment = await this.mainnet.deployRuntime(
      readFileSync(this.candidate.wasmPath),
      this.candidate.expectedSpecVersion,
    );
    if (!deployment.upgradeBlock.includedTransactionHashes.includes(deployment.upgradeTransactionHash)) {
      throw new Error('Candidate runtime transaction was not included in the upgrade block');
    }
    if (!deployment.upgradeBlock.events.includes('system.CodeUpdated')) {
      throw new Error('Candidate runtime upgrade did not emit system.CodeUpdated');
    }
    if (deployment.upgradeBlock.metadataSpecVersion !== this.registry.environment.deployedSpecVersion) {
      throw new Error('Upgrade block metadata did not preserve the deployed runtime schema');
    }
    if (
      deployment.migrationBlock.runtimeSpecVersion !== this.candidate.expectedSpecVersion ||
      deployment.candidateBlock.runtimeSpecVersion !== this.candidate.expectedSpecVersion
    ) {
      throw new Error(
        `Candidate runtime activated spec ${deployment.candidateBlock.runtimeSpecVersion}; expected ${this.candidate.expectedSpecVersion}`,
      );
    }
    if (
      deployment.indexer.checkpoint.blockNumber !== deployment.candidateBlock.number ||
      deployment.indexer.checkpoint.blockHash !== deployment.candidateBlock.hash
    ) {
      throw new Error('Indexer did not commit the exact candidate-runtime block');
    }
    if (
      !deployment.indexer.runtimeMetadataSpecVersions.includes(this.registry.environment.deployedSpecVersion) ||
      !deployment.indexer.runtimeMetadataSpecVersions.includes(this.candidate.expectedSpecVersion)
    ) {
      throw new Error('Indexer did not retain metadata for both sides of the runtime transition');
    }
    this.historyThroughBlock = deployment.candidateBlock.number;
    console.info(
      `Runtime ${deployment.candidateBlock.runtimeSpecVersion} is active at block ${deployment.candidateBlock.number}.`,
    );
  }

  private async open(
    account: CapturedStartingDatabase,
    focusAppWindow = true,
  ): Promise<AccountReviewResult['history']> {
    await this.mainnet.closeApp();
    await LocalMainnetReview.verifyStartingDatabase(account);

    const instanceName = `mainnet-review-${this.instancePrefix}-${this.nextInstanceId++}-${account.label}`
      .replace(/[^A-Za-z0-9._-]/g, '-')
      .slice(0, 80);
    let session = await this.mainnet.launchApp(
      {
        appsDirectory: this.appsDirectory,
        instanceName,
        sourceInstancePackagePath: account.instancePackagePath,
        autoEnableOperations: false,
        focusAppWindow,
        appLogsMode: focusAppWindow ? 'inherit' : 'quiet',
      },
      FlowSession.start,
    );
    await session.waitForReady(5 * 60_000);
    try {
      if (!this.historyThroughBlock) throw new Error('Candidate runtime block is not available');
      await session.recoverAccountHistory(this.historyThroughBlock, 600_000);
      const [expectedReleasedBondLotIds, expectedBitcoinFissionIds] = await Promise.all([
        this.loadReleasedBondLotIds(account.defaultArgonAccountId),
        this.loadBitcoinHistoryIds(account.defaultArgonAccountId),
      ]);
      const releasedLotIds = new Set(expectedReleasedBondLotIds);
      const reviewInput = {
        expectedDefaultArgonAddress: account.defaultArgonAccountId,
        expectedBitcoinLiquidIds: account.expected.bitcoinLiquidIds,
        expectedArchivedBitcoinLiquidIds: account.expected.archivedBitcoinLiquidIds,
        expectedBondLotIds: account.expected.bondLotIds.filter(id => !releasedLotIds.has(id)),
        expectedFlexibleBondLotIds: account.expected.flexibleBondLotIds.filter(id => !releasedLotIds.has(id)),
        expectedStakeLotIds: account.expected.stakeLotIds.filter(id => !releasedLotIds.has(id)),
        expectedHistoricalBondLotIds: account.expected.historicalBondLotIds,
        expectedHistoricalStakeLotIds: account.expected.historicalStakeLotIds,
        expectedReleasedBondLotIds,
        expectedVaultBitcoinMapItemCount: account.expected.vaultBitcoinMapItemCount,
        expectedVaultBondMapItemCount: account.expected.vaultBondMapItemCount,
        expectsConfiguredServer: account.expected.configuredServer,
        expectsOperations: account.expected.operations,
        expectsTreasury: account.expected.treasury,
        expectsUpstream: account.expected.upstream,
        expectsVault: account.selection.features.includes('vault'),
      };
      const recoveredFinancials = await this.runAccountReview(session, reviewInput);
      let recoveredSnapshot: AccountRecoverySnapshotResult | undefined;
      if (this.verifyRecoveryIdempotence) {
        recoveredSnapshot = await this.captureRecoverySnapshot(session, recoveredFinancials);
        await session.recoverAccountHistory(this.historyThroughBlock, 600_000);
        const repeatedFinancials = await this.runAccountReview(session, reviewInput);
        const repeatedSnapshot = await this.captureRecoverySnapshot(session, repeatedFinancials);
        AccountRecoverySnapshot.assertEquivalent(recoveredSnapshot, repeatedSnapshot, 'repeated forced recovery');
        recoveredSnapshot = repeatedSnapshot;
      }
      await this.mainnet.closeApp();
      session = await this.mainnet.launchApp(
        {
          appsDirectory: this.appsDirectory,
          instanceName,
          autoEnableOperations: false,
          focusAppWindow,
          appLogsMode: focusAppWindow ? 'inherit' : 'quiet',
        },
        FlowSession.start,
      );
      await session.waitForReady(5 * 60_000);
      const restartedFinancials = await this.runAccountReview(session, reviewInput);
      if (recoveredSnapshot) {
        const restartedSnapshot = await this.captureRecoverySnapshot(session, restartedFinancials);
        AccountRecoverySnapshot.assertEquivalent(recoveredSnapshot, restartedSnapshot, 'app restart');
        console.info(
          `Recovery idempotence verified (financial ${restartedSnapshot.financialHash.slice(0, 12)}, database ${restartedSnapshot.databaseHash.slice(0, 12)}).`,
        );
      }
      await session.checkpointDatabase();
      try {
        const inspection = inspectStartingDatabase(
          Path.join(session.appInstanceDirectory, 'database.sqlite'),
          this.historyThroughBlock,
          account.defaultArgonAccountId,
        );
        if (!isStartingDatabaseComplete(inspection, this.historyThroughBlock)) {
          throw new Error(`Candidate database has incomplete history after restart: ${JSON.stringify(inspection)}`);
        }
        const missingBitcoinFissionIds = expectedBitcoinFissionIds.filter(
          id => !inspection.bitcoinFissionIds.includes(id),
        );
        if (missingBitcoinFissionIds.length) {
          throw new Error(
            `Candidate database is missing Bitcoin history records: ${missingBitcoinFissionIds.join(', ')}`,
          );
        }
        console.info(`Recovered ${account.label} history through block ${this.historyThroughBlock.toLocaleString()}.`);
        console.info(`Opened ${LocalMainnetReview.describeAccount(account)} in ${session.appInstanceDirectory}`);
        return {
          ...inspection,
          throughBlock: this.historyThroughBlock,
          expectedBitcoinFissionIds,
        };
      } finally {
        if (focusAppWindow) await session.resumeDatabaseWrites();
        else await this.mainnet.closeApp();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(
        `History recovery for ${account.label} failed${focusAppWindow ? '; the account remains open for review' : ''}: ${message}`,
      );
      if (!focusAppWindow) throw error;
      this.validationFailures.push(account.label);
    }
    console.info(`Opened ${LocalMainnetReview.describeAccount(account)} in ${session.appInstanceDirectory}`);
  }

  private async runAccountReview(session: FlowSession, input: Record<string, unknown>): Promise<IFinancialAggregate> {
    const { data } = await session.run('App.flow.accountReview', input);
    const financials = data['App.flow.accountReview.snapshot'] as IFinancialAggregate | undefined;
    if (!financials) throw new Error('Account review did not publish a financial snapshot');
    return financials;
  }

  private async captureRecoverySnapshot(
    session: FlowSession,
    financials: IFinancialAggregate,
  ): Promise<AccountRecoverySnapshotResult> {
    await session.checkpointDatabase();
    try {
      return AccountRecoverySnapshot.capture({
        databasePath: Path.join(session.appInstanceDirectory, 'database.sqlite'),
        financials,
      });
    } finally {
      await session.resumeDatabaseWrites();
    }
  }

  private async loadBitcoinHistoryIds(address: string): Promise<number[]> {
    if (!this.historyThroughBlock) throw new Error('Candidate runtime block is not available');
    const url = new URL(`/v2/activity/${address}`, this.mainnet.indexerUrl);
    url.searchParams.set('toBlock', String(this.historyThroughBlock));
    url.searchParams.set('activityMask', String(AccountActivityKind.BitcoinLock | AccountActivityKind.BitcoinMint));
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Bitcoin-history inventory request failed: HTTP ${response.status}`);
    const activity = (await response.json()) as IIndexerSpec['/v2/activity/:address']['responseType'];
    if (
      activity.definitionVersion < ACCOUNT_ACTIVITY_DEFINITION_VERSION ||
      activity.asOfBlock < this.historyThroughBlock ||
      activity.coverage.toBlock < this.historyThroughBlock ||
      activity.coverage.fromBlock > 1 ||
      activity.coverage.gaps.length
    ) {
      throw new Error('Bitcoin-history inventory is not fully covered through the candidate runtime block');
    }
    const client = await getClient(this.mainnet.archiveUrl);
    try {
      const fissionIds = new Set<number>();
      for (const block of activity.blocks) {
        const api: ArgonApi = runtimeClient(await client.at(block.blockHash));
        const events = await api.query.system.events();
        const verifiedUtxoIds = new Set<number>();
        const historicalUtxoIds = new Set<number>();
        for (const { event } of events) {
          if (event.section === 'bitcoinFissions' && event.data.accountId === address) {
            fissionIds.add(event.data.fissionId);
          } else if (event.section === 'mint' && event.method === 'BitcoinMint' && event.data.accountId === address) {
            const id = event.data.fissionId ?? event.data.utxoId;
            if (id != null) fissionIds.add(id);
          } else if (
            (event.section === 'bitcoinLocks' ||
              (event.section === 'bitcoinUtxos' && event.method === 'UtxoVerified')) &&
            'utxoId' in event.data &&
            event.data.utxoId != null
          ) {
            historicalUtxoIds.add(event.data.utxoId);
            if (event.section === 'bitcoinUtxos' && event.method === 'UtxoVerified') {
              verifiedUtxoIds.add(event.data.utxoId);
            }
          }
        }
        let parentApi: ArgonApi | undefined;
        for (const utxoId of historicalUtxoIds) {
          let lock = await api.query.bitcoinLocks.locksByUtxoId(utxoId);
          if (!lock && verifiedUtxoIds.has(utxoId)) {
            // Funding and spending may occur in one inherent, removing the Lock from post-block state.
            const header = await client.rpc.chain.getHeader(block.blockHash);
            parentApi ??= runtimeClient(await client.at(header.parentHash));
            lock = await parentApi.query.bitcoinLocks.locksByUtxoId(utxoId);
            if (!lock) throw new Error(`Bitcoin funding history is unavailable at block ${block.blockNumber}`);
          }
          const fundedSatoshis = lock?.utxoSatoshis ?? (lock?.isVerified ? lock.satoshis : 0n);
          if (
            lock?.ownerAccount === address &&
            (fundedSatoshis > 0n || verifiedUtxoIds.has(utxoId)) &&
            (lock.liquidityPromised ?? 0n) > 0n
          ) {
            fissionIds.add(utxoId);
          }
        }
      }
      return [...fissionIds].sort((left, right) => left - right);
    } finally {
      await client.disconnect();
    }
  }

  private async loadReleasedBondLotIds(address: string): Promise<number[]> {
    if (!this.historyThroughBlock) throw new Error('Candidate runtime block is not available');
    const url = new URL(`/v2/activity/${address}`, this.mainnet.indexerUrl);
    url.searchParams.set('toBlock', String(this.historyThroughBlock));
    url.searchParams.set('activityMask', String(AccountActivityKind.BondPosition));
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Bond-history inventory request failed: HTTP ${response.status}`);
    const activity = (await response.json()) as IIndexerSpec['/v2/activity/:address']['responseType'];
    if (activity.asOfBlock < this.historyThroughBlock || activity.coverage.gaps.length) {
      throw new Error('Bond-history inventory is not covered through the candidate runtime block');
    }

    const client = await getClient(this.mainnet.archiveUrl);
    try {
      const released = new Set<number>();
      for (const block of activity.blocks) {
        const atBlock = await client.at(block.blockHash);
        const atBlockQuery = runtimeClient(atBlock);
        const events = await atBlockQuery.query.system.events();
        for (const { event } of events) {
          if (
            event.section !== 'treasury' ||
            (event.method !== 'BondLotReleased' && event.method !== 'CouldNotReleaseBondLot') ||
            event.data.accountId !== address
          ) {
            continue;
          }
          if (event.method === 'BondLotReleased') {
            released.add(event.data.bondLotId);
            continue;
          }
          const parentHash = await client.rpc.chain.getBlockHash(block.blockNumber - 1);
          const parent = runtimeClient(await client.at(parentHash.toHex()));
          const failedStoredLot = await parent.query.treasury.bondLotById(event.data.bondLotId);
          if (!failedStoredLot) continue;
          const failedLot = BondLot.fromRuntime(event.data.bondLotId, failedStoredLot, address);
          if (
            await TreasuryBonds.didFailedReleaseRemoveHold({
              accountId: address,
              lot: failedLot,
              events,
              parentApi: parent,
              api: atBlockQuery,
            })
          ) {
            released.add(event.data.bondLotId);
          }
        }
      }
      return [...released].sort((left, right) => left - right);
    } finally {
      await client.disconnect();
    }
  }

  private static async loadRegistry(
    path: string,
    diagnostic = false,
  ): Promise<{ registry: StartingDatabaseRegistry; captureQualified: boolean }> {
    const registry = JSON.parse(readFileSync(path, 'utf8')) as StartingDatabaseRegistry;
    if (registry.formatVersion !== 4 || !Array.isArray(registry.accounts)) {
      throw new Error(`Invalid starting database registry: ${path}`);
    }
    const qualificationFailures: string[] = [];
    if (!registry.coverage?.complete) qualificationFailures.push('coverage is incomplete');
    if (!Array.isArray(registry.failures)) qualificationFailures.push('capture failures are missing');
    else if (registry.failures.length) qualificationFailures.push(`${registry.failures.length} capture(s) failed`);
    if (registry.accounts.length !== registry.selection?.selectedAccounts) {
      qualificationFailures.push('captured account count does not match selection');
    }
    const captureQualified = qualificationFailures.length === 0;
    if (!captureQualified) {
      const message = `Starting database registry is not qualified: ${qualificationFailures.join('; ')}: ${path}`;
      if (!diagnostic) throw new Error(message);
      console.warn(message);
    }
    if (!diagnostic) for (const account of registry.accounts) await LocalMainnetReview.verifyStartingDatabase(account);
    if (!registry.environment) throw new Error(`Starting database registry has no environment provenance: ${path}`);
    return { registry, captureQualified };
  }

  private static async verifyStartingDatabase(account: CapturedStartingDatabase): Promise<void> {
    const packagePath = realpathSync(account.instancePackagePath);
    if (!statSync(packagePath).isDirectory()) throw new Error(`Account package is not a directory: ${packagePath}`);
    const databasePath = Path.join(packagePath, 'database.sqlite');
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(databasePath)) hash.update(chunk);
    const sha256 = hash.digest('hex');
    if (sha256 !== account.databaseSha256) throw new Error(`Account database checksum mismatch for ${account.label}`);
    account.instancePackagePath = packagePath;
  }

  private static findAccount(accounts: CapturedStartingDatabase[], requested: string): CapturedStartingDatabase {
    const account = accounts.find(candidate => candidate.label.toLowerCase() === requested.toLowerCase());
    if (!account)
      throw new Error(`Unknown account '${requested}'. Available: ${accounts.map(x => x.label).join(', ')}`);
    return account;
  }

  private static describeAccount(account: CapturedStartingDatabase): string {
    const features = account.selection?.features ?? [];
    const reviewTraits = [
      ...features,
      ...(account.expected.archivedBitcoinLiquidIds.length ? ['archived-bitcoin'] : []),
    ];
    return reviewTraits.length ? `${account.label} [${reviewTraits.join(', ')}]` : account.label;
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void LocalMainnetReview.runFromCommandLine().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
