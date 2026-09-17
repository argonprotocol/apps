import { cpSync, existsSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import Path from 'node:path';
import { AppSession, type AppSessionOptions } from '../AppSession.ts';
import type { AppLogsMode } from '../AppProcessOutput.ts';
import { LocalMainnetFork, type ProducedBlock } from './LocalMainnetFork.ts';
import { LocalMainnetIndexer, type LocalMainnetIndexerFacts } from './LocalMainnetIndexer.ts';
import type { RuntimeMigrationManifest } from './manifest.ts';

export interface LocalMainnetDeployment {
  upgradeTransactionHash: string;
  upgradeBlock: ProducedBlock;
  migrationBlock: ProducedBlock;
  candidateBlock: ProducedBlock;
  indexer: LocalMainnetIndexerFacts;
  preUpgradeAppSnapshotPath?: string;
}

export interface LocalMainnetAppOptions {
  appsDirectory: string;
  instanceName: string;
  appLogsMode?: AppLogsMode;
  sourceInstancePackagePath?: string;
}

export class LocalMainnet {
  public readonly archiveUrl: string;
  public readonly deployedBlock: ProducedBlock;
  private activeApp: AppSession | undefined;
  private preUpgradeAppInstanceDirectory: string | undefined;
  private deployment: LocalMainnetDeployment | undefined;
  private closed = false;

  private constructor(
    private readonly manifest: RuntimeMigrationManifest,
    private readonly runDirectory: string,
    private readonly fork: LocalMainnetFork,
    private indexer: LocalMainnetIndexer,
    deployedBlock: ProducedBlock,
  ) {
    this.archiveUrl = fork.archiveUrl;
    this.deployedBlock = deployedBlock;
  }

  public static async start(args: { manifest: RuntimeMigrationManifest; runDirectory: string }): Promise<LocalMainnet> {
    const { manifest, runDirectory } = args;
    if (!Path.isAbsolute(runDirectory)) {
      throw new Error('Local mainnet runDirectory must be an absolute path');
    }

    let fork: LocalMainnetFork | undefined;
    let indexer: LocalMainnetIndexer | undefined;
    try {
      fork = await LocalMainnetFork.start({
        manifest,
        runDirectory: Path.join(runDirectory, 'fork'),
      });
      indexer = await LocalMainnetIndexer.start({
        manifest,
        forkArchiveUrl: fork.archiveUrl,
        runDirectory: Path.join(runDirectory, 'indexer'),
      });
      const deployedBlock = await fork.produceBlock('deployed');
      await indexer.waitForBlock(deployedBlock.number);
      return new LocalMainnet(manifest, runDirectory, fork, indexer, deployedBlock);
    } catch (error) {
      await indexer?.stop().catch(() => undefined);
      await fork?.close().catch(() => undefined);
      throw error;
    }
  }

  public get indexerUrl(): string {
    if (this.closed) throw new Error('Local mainnet is closed');
    return this.indexer.url;
  }

  public async launchApp(options: LocalMainnetAppOptions): Promise<AppSession>;
  public async launchApp<Session extends AppSession>(
    options: LocalMainnetAppOptions,
    startSession: (options: AppSessionOptions) => Promise<Session>,
  ): Promise<Session>;
  public async launchApp(
    options: LocalMainnetAppOptions,
    startSession: (options: AppSessionOptions) => Promise<AppSession> = AppSession.start,
  ): Promise<AppSession> {
    if (this.closed) throw new Error('Local mainnet is closed');
    if (this.activeApp) throw new Error('Close or deploy the active app before launching another Apps checkout');
    const { appsDirectory, instanceName, appLogsMode = 'inherit', sourceInstancePackagePath } = options;
    const canonicalAppsDirectory = realpathSync(appsDirectory);
    if (
      !statSync(canonicalAppsDirectory).isDirectory() ||
      !existsSync(Path.join(canonicalAppsDirectory, 'package.json'))
    ) {
      throw new Error(`Apps checkout is not a repository root: ${canonicalAppsDirectory}`);
    }
    const canonicalSourceInstancePackagePath = sourceInstancePackagePath
      ? realpathSync(sourceInstancePackagePath)
      : undefined;
    if (canonicalSourceInstancePackagePath && !statSync(canonicalSourceInstancePackagePath).isDirectory()) {
      throw new Error(`App instance package is not a directory: ${canonicalSourceInstancePackagePath}`);
    }

    const instanceDirectory = AppSession.resolveInstanceDirectory({
      networkName: this.manifest.network,
      instanceName,
    });
    if (canonicalSourceInstancePackagePath) {
      mkdirSync(Path.dirname(instanceDirectory), { recursive: true });
      cpSync(canonicalSourceInstancePackagePath, instanceDirectory, {
        recursive: true,
        errorOnExist: true,
        force: false,
      });
    }
    if (!this.deployment) this.preUpgradeAppInstanceDirectory = instanceDirectory;

    try {
      const session = await startSession({
        repoRoot: canonicalAppsDirectory,
        sessionName: instanceName,
        sessionMode: 'stateful',
        useTestNetwork: false,
        appLogsMode,
        appEnv: {
          ARGON_NETWORK_NAME: this.manifest.network,
          ARGON_NETWORK_CONFIG_OVERRIDE: JSON.stringify({
            archiveUrl: this.fork.archiveUrl,
            indexerHost: this.indexer.url,
          }),
        },
      });
      this.activeApp = session;
      if (session.appInstanceDirectory !== instanceDirectory) {
        throw new Error('App resolved a different instance directory');
      }
      return session;
    } catch (error) {
      if (this.activeApp) {
        const app = this.activeApp;
        await app.close().catch(closeError => {
          throw new AggregateError([error, closeError], 'Failed to launch and close the app');
        });
        this.activeApp = undefined;
      }
      throw error;
    }
  }

  public async closeApp(): Promise<void> {
    if (!this.activeApp) return;
    const app = this.activeApp;
    await app.checkpointDatabase();
    await app.close();
    this.activeApp = undefined;
  }

  public async deployRuntime(wasm: Uint8Array): Promise<LocalMainnetDeployment> {
    if (this.closed) throw new Error('Local mainnet is closed');
    if (this.deployment) throw new Error('The candidate runtime has already been deployed');

    let preUpgradeAppSnapshotPath: string | undefined;
    if (this.activeApp) {
      const app = this.activeApp;
      await app.checkpointDatabase().catch(error => {
        console.warn(`Unable to checkpoint the previous app database before shutdown: ${(error as Error).message}`);
      });
      await app.close();
      this.activeApp = undefined;
    }
    if (this.preUpgradeAppInstanceDirectory && existsSync(this.preUpgradeAppInstanceDirectory)) {
      preUpgradeAppSnapshotPath = Path.join(this.runDirectory, 'pre-upgrade-app');
      cpSync(this.preUpgradeAppInstanceDirectory, preUpgradeAppSnapshotPath, {
        recursive: true,
        errorOnExist: true,
        force: false,
      });
    }

    const upgradeTransactionHash = await this.fork.submitRuntimeUpgrade(wasm);
    const upgradeBlock = await this.fork.produceBlock('upgrade');
    const migrationBlock = await this.fork.produceBlock('migration');
    const candidateBlock = await this.fork.produceBlock('candidate');
    await this.indexer.waitForBlock(candidateBlock.number);

    this.deployment = {
      upgradeTransactionHash,
      upgradeBlock,
      migrationBlock,
      candidateBlock,
      indexer: this.indexer.inspect(),
      preUpgradeAppSnapshotPath,
    };
    await this.restartIndexer();
    this.deployment.indexer = this.indexer.inspect();
    return this.deployment;
  }

  private async restartIndexer(): Promise<void> {
    if (this.closed) throw new Error('Local mainnet is closed');
    await this.indexer.stop();
    this.indexer = await LocalMainnetIndexer.start({
      manifest: this.manifest,
      forkArchiveUrl: this.fork.archiveUrl,
      runDirectory: Path.join(this.runDirectory, 'indexer'),
    });
    const latestBlock = this.deployment?.candidateBlock.number ?? this.deployedBlock.number;
    await this.indexer.waitForBlock(latestBlock);
  }

  public async close(): Promise<void> {
    if (this.closed) return;
    const errors: unknown[] = [];
    if (this.activeApp) {
      const app = this.activeApp;
      try {
        await app.close();
        this.activeApp = undefined;
      } catch (error) {
        errors.push(error);
      }
    }
    await this.indexer.stop().catch(error => errors.push(error));
    await this.fork.close().catch(error => errors.push(error));
    if (errors.length) throw new AggregateError(errors, 'Failed to close the local mainnet environment');
    this.closed = true;
  }
}
