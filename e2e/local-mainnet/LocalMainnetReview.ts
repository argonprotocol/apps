import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import Path from 'node:path';
import process from 'node:process';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { AccountActivityKind, BondLot, type IIndexerSpec } from '@argonprotocol/apps-core';
import { getClient } from '@argonprotocol/mainchain';
import { runtimeClient } from '@argonprotocol/runtime-client';
import { toHistoricalEvent } from '@argonprotocol/runtime-client/events';
import type { IFinancialAggregate } from 'src-vue/interfaces/IFinancialPosition.ts';
import { FlowSession } from '../FlowSession.ts';
import { AccountRecoverySnapshot, type AccountRecoverySnapshotResult } from './AccountRecoverySnapshot.ts';
import { LocalMainnet } from './LocalMainnet.ts';
import { loadLocalMainnetManifest } from './manifest.ts';
import type { CapturedStartingDatabase, StartingDatabaseRegistry } from './StartingDatabaseCapture.ts';
import { RuntimeCandidate, type CandidateRuntimeArtifact } from './RuntimeCandidate.ts';

export class LocalMainnetReview {
  private historyThroughBlock: number | undefined;
  private nextInstanceId = 1;
  private readonly instancePrefix = Date.now().toString(36);
  private readonly validationFailures: string[] = [];
  private readonly batchResults: Array<{ label: string; status: 'passed' | 'failed'; error?: string }> = [];

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
        manifest: { type: 'string' },
        'run-directory': { type: 'string' },
        'verify-recovery-idempotence': { type: 'boolean' },
      },
      strict: true,
    });
    if (!values.manifest || !values.candidate) {
      throw new Error(
        'Usage: yarn local-mainnet:review --manifest <manifest.json> --candidate <attestation.json> [--accounts <starting-databases.json>] [--account <label>] [--all] [--verify-recovery-idempotence] [--run-directory <path>]',
      );
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
    if (candidate.expectedSpecVersion <= manifest.archive.deployedSpecVersion) {
      throw new Error(
        `Candidate runtime spec ${candidate.expectedSpecVersion} must be newer than deployed spec ${manifest.archive.deployedSpecVersion}`,
      );
    }
    const registry = LocalMainnetReview.loadRegistry(accountsPath);
    const accounts = registry.accounts;
    const firstAccount = values.account
      ? LocalMainnetReview.findAccount(accounts, values.account)
      : (accounts.find(account => account.legacyBitcoin?.releasedIds.length) ?? accounts[0]);
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
    } finally {
      await mainnet.close();
    }
  }

  private async reviewAll(runDirectory: string, accounts: readonly CapturedStartingDatabase[]): Promise<void> {
    const resultsPath = Path.join(runDirectory, 'account-results.json');
    for (const account of accounts) {
      try {
        await this.open(account, false);
        this.batchResults.push({ label: account.label, status: 'passed' });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.validationFailures.push(account.label);
        this.batchResults.push({ label: account.label, status: 'failed', error: message });
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
    const deployment = await this.mainnet.deployRuntime(readFileSync(this.candidate.wasmPath));
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

  private async open(account: CapturedStartingDatabase, focusAppWindow = true): Promise<void> {
    await this.mainnet.closeApp();

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
      const expectedReleasedBondLotIds = await this.loadReleasedBondLotIds(account.defaultArgonAccountId);
      const releasedLotIds = new Set(expectedReleasedBondLotIds);
      const reviewInput = {
        expectedDefaultArgonAddress: account.defaultArgonAccountId,
        expectedBitcoinLiquidIds: [...account.legacyBitcoin.chainFundedIds, ...account.legacyBitcoin.releasedIds],
        expectedMigratableBitcoinLiquidIds: account.legacyBitcoin.migratableIds,
        expectedArchivedBitcoinLiquidIds: account.legacyBitcoin.releasedIds,
        expectedBondLotIds: account.expected.bondLotIds.filter(id => !releasedLotIds.has(id)),
        expectedFlexibleBondLotIds: account.expected.flexibleBondLotIds.filter(id => !releasedLotIds.has(id)),
        expectedStakeLotIds: account.expected.stakeLotIds.filter(id => !releasedLotIds.has(id)),
        expectedHistoricalBondLotIds: account.expected.historicalBondLotIds,
        expectedHistoricalStakeLotIds: account.expected.historicalStakeLotIds,
        expectedReleasedBondLotIds,
        expectedVaultBitcoinMapItemCount: account.expected.vaultBitcoinMapItemCount,
        expectedVaultBondMapItemCount: account.expected.vaultBondMapItemCount,
        expectsBitcoinLiquid: account.selection.features.includes('bitcoin'),
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
      console.info(`Recovered ${account.label} history through block ${this.historyThroughBlock.toLocaleString()}.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`History recovery for ${account.label} failed; the account remains open for review: ${message}`);
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
        const events = await atBlock.query.system.events();
        const releaseEvents = events.flatMap(({ event }) => {
          if (
            event.section !== 'treasury' ||
            (event.method !== 'BondLotReleased' && event.method !== 'CouldNotReleaseBondLot')
          ) {
            return [];
          }
          const historical = toHistoricalEvent(event);
          if (
            historical?.section !== 'treasury' ||
            (historical.method !== 'BondLotReleased' && historical.method !== 'CouldNotReleaseBondLot')
          ) {
            return [];
          }
          return historical.data.accountId === address ? [historical] : [];
        });
        for (const { event } of events) {
          if (
            event.section !== 'treasury' ||
            (event.method !== 'BondLotReleased' && event.method !== 'CouldNotReleaseBondLot')
          ) {
            continue;
          }
          const historical = toHistoricalEvent(event);
          if (
            historical?.section !== 'treasury' ||
            (historical.method !== 'BondLotReleased' && historical.method !== 'CouldNotReleaseBondLot') ||
            historical.data.accountId !== address
          ) {
            continue;
          }
          if (historical.method === 'BondLotReleased') {
            released.add(historical.data.bondLotId);
            continue;
          }
          if (
            historical.method !== 'CouldNotReleaseBondLot' ||
            events.some(({ event: other }) => {
              const purchase = toHistoricalEvent(other);
              return (
                purchase?.section === 'treasury' &&
                purchase.method === 'BondLotPurchased' &&
                purchase.data.accountId === address
              );
            })
          ) {
            continue;
          }
          const parentHash = await client.rpc.chain.getBlockHash(block.blockNumber - 1);
          const parent = runtimeClient(await client.at(parentHash.toHex()));
          const atBlockQuery = runtimeClient(atBlock);
          const failedStoredLot = await parent.query.treasury.bondLotById(historical.data.bondLotId);
          if (!failedStoredLot) continue;
          const failedLot = BondLot.fromRuntime(historical.data.bondLotId, failedStoredLot, address);
          let expectedReleasedPrincipal = 0n;
          let releaseGroupIsValid = true;
          for (const release of releaseEvents) {
            const storedLot = await parent.query.treasury.bondLotById(release.data.bondLotId);
            if (!storedLot) {
              releaseGroupIsValid = false;
              break;
            }
            const lot = BondLot.fromRuntime(release.data.bondLotId, storedLot, address);
            if (lot.programType !== failedLot.programType) continue;
            const principal = lot.principalMicrogons ?? lot.principalMicronots ?? 0n;
            if (
              lot.accountId !== address ||
              principal <= 0n ||
              (release.method === 'CouldNotReleaseBondLot'
                ? release.data.amount !== principal
                : release.data.bonds !== lot.bonds)
            ) {
              releaseGroupIsValid = false;
              break;
            }
            expectedReleasedPrincipal += principal;
          }
          if (!releaseGroupIsValid) continue;
          const [priorHolds, currentHolds] =
            failedLot.programType === 'Argonot'
              ? await Promise.all([parent.query.ownership.holds(address), atBlockQuery.query.ownership.holds(address)])
              : await Promise.all([parent.query.balances.holds(address), atBlockQuery.query.balances.holds(address)]);
          const treasuryTotal = (holds: typeof priorHolds): bigint =>
            holds.filter(hold => hold.id.type === 'Treasury').reduce((total, hold) => total + hold.amount, 0n);
          if (treasuryTotal(priorHolds) - treasuryTotal(currentHolds) === expectedReleasedPrincipal) {
            released.add(historical.data.bondLotId);
          }
        }
      }
      return [...released].sort((left, right) => left - right);
    } finally {
      await client.disconnect();
    }
  }

  private static loadRegistry(path: string): StartingDatabaseRegistry {
    const registry = JSON.parse(readFileSync(path, 'utf8')) as StartingDatabaseRegistry;
    if (registry.formatVersion !== 3 || !Array.isArray(registry.accounts)) {
      throw new Error(`Invalid starting database registry: ${path}`);
    }
    const qualificationFailures: string[] = [];
    if (!registry.coverage?.complete) qualificationFailures.push('coverage is incomplete');
    if (!Array.isArray(registry.failures)) qualificationFailures.push('capture failures are missing');
    else if (registry.failures.length) qualificationFailures.push(`${registry.failures.length} capture(s) failed`);
    if (registry.accounts.length !== registry.selection?.selectedAccounts) {
      qualificationFailures.push('captured account count does not match selection');
    }
    if (registry.coverage?.completeHistoryAccounts !== registry.selection?.selectedAccounts) {
      qualificationFailures.push('history coverage does not include every selected account');
    }
    if (registry.accounts.some(account => !account.history?.complete)) {
      qualificationFailures.push('one or more account histories are incomplete');
    }
    if (qualificationFailures.length) {
      throw new Error(`Starting database registry is not qualified: ${qualificationFailures.join('; ')}: ${path}`);
    }
    for (const account of registry.accounts) {
      const packagePath = realpathSync(account.instancePackagePath);
      if (!statSync(packagePath).isDirectory()) throw new Error(`Account package is not a directory: ${packagePath}`);
      const databasePath = Path.join(packagePath, 'database.sqlite');
      const sha256 = createHash('sha256').update(readFileSync(databasePath)).digest('hex');
      if (sha256 !== account.databaseSha256) {
        throw new Error(`Account database checksum mismatch for ${account.label}`);
      }
      account.instancePackagePath = packagePath;
    }
    if (!registry.environment) throw new Error(`Starting database registry has no environment provenance: ${path}`);
    return registry;
  }

  private static findAccount(accounts: CapturedStartingDatabase[], requested: string): CapturedStartingDatabase {
    const account = accounts.find(candidate => candidate.label.toLowerCase() === requested.toLowerCase());
    if (!account)
      throw new Error(`Unknown account '${requested}'. Available: ${accounts.map(x => x.label).join(', ')}`);
    return account;
  }

  private static describeAccount(account: CapturedStartingDatabase): string {
    const features = account.selection?.features ?? [];
    const reviewTraits = [...features, ...(account.legacyBitcoin?.releasedIds.length ? ['archived-bitcoin'] : [])];
    return reviewTraits.length ? `${account.label} [${reviewTraits.join(', ')}]` : account.label;
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void LocalMainnetReview.runFromCommandLine().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
