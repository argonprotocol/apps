import { SSH } from './SSH';
import {
  type IConfigInstallStep,
  InstallStepErrorType,
  InstallStepKey,
  InstallStepStatus,
  ServerType,
} from '../interfaces/IConfig';
import { Config } from './Config';
import { InstallerCheck } from './InstallerCheck';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import { ensureOnlyOneInstance, resetOnlyOneInstance } from './Utils';
import { createDeferred, getErrorDiagnostics, getRuntimeDiagnostics, type IDeferred } from '@argonprotocol/apps-core';
import { ask as tauriAsk, message as tauriMessage } from '@tauri-apps/plugin-dialog';
import { exit as tauriExit } from '@tauri-apps/plugin-process';
import { ServerAdmin } from './ServerAdmin';
import { invokeWithTimeout } from './tauriApi.ts';
import { MiningMachine } from './MiningMachine.ts';
import { WalletKeys } from './WalletKeys.ts';
import { IS_LOCAL_BUILD, NETWORK_NAME, TICK_MILLIS } from './Env.ts';
import * as semver from 'semver';
import { getEthereumBeaconApiUrl, getEthereumExecutionRpcUrl } from './EthereumClient.ts';
import { MyVault } from './MyVault.ts';
import { ensureMiningBidProxySetup } from './MiningAccount.ts';
import { getTransactionTracker } from '../stores/transactions.ts';
import { MiningSetupStatus } from '../interfaces/IConfig.ts';

dayjs.extend(utc);

export function resetInstaller(): void {
  resetOnlyOneInstance(Installer);
}

export enum ReasonsToSkipInstall {
  ServerNotConnected = 'ServerNotConnected',
  InstallAlreadyRunning = 'InstallAlreadyRunning',
  ServerUpToDate = 'ServerUpToDate',
  UpgradeRequiresApproval = 'UpgradeRequiresApproval',
  ServerError = 'ServerError',
  MinersAreSyncing = 'MinersAreSyncing',
}

type InstallerFns = {
  refreshPrunedClient?: () => void;
};

export default class Installer {
  public isLoaded: boolean = false;
  public isLoadedPromise: Promise<void>;
  public isReadyToRun: boolean = false;

  public isRunning: boolean;
  public isRunningInBackground: boolean;
  public fileUploadProgress: number = 0;
  public serverConnectProgress: number = 0;

  public reasonToSkipInstall: string;
  public reasonToSkipInstallData: any;

  public get isDockerHostProxy(): boolean {
    return this.config.serverDetails.type === ServerType.LocalComputer;
  }

  private isFreshInstall: boolean = true;
  private remoteFilesNeedUpdating: boolean = false;

  private isLoadedDeferred!: IDeferred<void>;
  private installerCheck: InstallerCheck;
  private disableWrites = false;

  private readonly config: Config;
  private readonly walletKeys: WalletKeys;

  private _server?: ServerAdmin;

  constructor(
    config: Config,
    walletKeys: WalletKeys,
    private readonly fns: InstallerFns = {},
  ) {
    ensureOnlyOneInstance(this.constructor);

    this.isRunning = false;
    this.isRunningInBackground = false;

    this.config = config;
    this.walletKeys = walletKeys;
    this.installerCheck = new InstallerCheck(this, config);
    this.reasonToSkipInstall = '';
    this.reasonToSkipInstallData = null;

    this.isLoadedDeferred = createDeferred<void>();
    this.isLoadedPromise = this.isLoadedDeferred.promise;
  }

  public async load(): Promise<void> {
    const loadStartedAt = Date.now();
    let stage = 'config.isLoadedPromise';

    await this.config.isLoadedPromise;

    try {
      if (this.config.isServerAdded && !this.isRunning) {
        const hasServerDetails = !!this.config.serverDetails.ipAddress;
        if (hasServerDetails) {
          stage = 'downloadAccountAddress';
          const server = await this.getServer();
          const accountAddressOnServer = await server.downloadAccountAddress();
          if (accountAddressOnServer && accountAddressOnServer !== this.walletKeys.miningBotAddress) {
            await tauriMessage(
              'The wallet address on the server does not match the wallet address in the local database. This app will shutdown.',
              {
                title: 'Wallet Address Mismatch',
                kind: 'error',
              },
            );
            await tauriExit(0);
          }

          stage = 'calculateIsReadyToRun';
          const isReadyToRun = await this.calculateIsReadyToRun(false, accountAddressOnServer);

          stage = 'calculateIsRunning';
          let isRunning = await this.calculateIsRunning();
          if (isRunning && this.remoteFilesNeedUpdating) {
            console.log('Need to kill existing installer process');
            await server.killInstallerScript();
            await this.clearStepFiles(['all']);
            isRunning = false;
            this.isRunning = false;
            this.isRunningInBackground = false;
          }
          if (isReadyToRun && !isRunning) {
            let isAllowedToRun = true;
            if (IS_LOCAL_BUILD && ['testnet', 'mainnet'].includes(NETWORK_NAME)) {
              stage = 'upgradeApprovalPrompt';
              isAllowedToRun = await tauriAsk(
                'Argon is about to push a software upgrade to your mining server. Would you like us to continue?',
                {
                  title: 'Preparing to Upgrade Server',
                  kind: 'warning',
                },
              );
            }
            if (isAllowedToRun) {
              stage = 'run';
              await this.run(false);
            } else {
              this.config.isServerInstalling = false;
            }
          } else {
            stage = 'activateInstallerCheck';
            await this.activateInstallerCheck(false);
          }
        } else {
          stage = 'runWithoutServerDetails';
          await this.run(false);
        }
      }
    } catch (error) {
      console.error(`[Installer] Load failed at ${stage} after ${Date.now() - loadStartedAt}ms`, error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.config.serverInstaller.errorType = InstallStepErrorType.ServerConnect;
      this.config.serverInstaller.errorMessage = errorMessage;
      this.config.serverInstaller = this.config.serverInstaller;
      this.reasonToSkipInstall = ReasonsToSkipInstall.ServerError;
      this.reasonToSkipInstallData = { errorMessage };
      this.isReadyToRun = false;
      await this.config.save().catch(() => undefined);
    }

    this.isLoaded = true;
    this.isLoadedDeferred.resolve();
  }

  public stop(disableWrites = true) {
    if (!this.isRunning) return;
    this.installerCheck.stop();
    this.isRunning = false;
    this.isRunningInBackground = false;
    this.isReadyToRun = false;
    this.disableWrites = disableWrites;
  }

  public async run(waitForLoaded: boolean = true): Promise<void> {
    console.log('RUNNING INSTALLER');
    if (waitForLoaded) {
      await this.isLoadedPromise;
    }

    const hasServerDetails = !!this.config.serverDetails.ipAddress;
    if (hasServerDetails) {
      if ((this.isRunning ||= await this.calculateIsRunning())) {
        console.log('CANNOT run because Installer is already running');
        return;
      }

      if (!(this.isReadyToRun ||= await this.calculateIsReadyToRun(waitForLoaded))) {
        console.log(
          'CANNOT run because Installer is not runnable',
          this.reasonToSkipInstall,
          this.reasonToSkipInstallData,
        );
        this.isRunning = false;
        return;
      }
    }

    console.log('RUNNING ACTUAL INSTALL');
    this.isRunning = true;
    this.isRunningInBackground = false;
    this.config.isServerInstalling = true;

    if (this.remoteFilesNeedUpdating) {
      const stepsToClear = [
        InstallStepKey.FileUpload,
        InstallStepKey.UbuntuCheck,
        InstallStepKey.DockerInstall,
        InstallStepKey.BitcoinInstall,
        InstallStepKey.ArgonInstall,
        InstallStepKey.MiningLaunch,
      ];
      console.info('Clearing step files');
      await this.clearStepFiles(stepsToClear);
    } else {
      this.config.serverInstaller.errorMessage = null;
      this.config.serverInstaller.errorType = null;
    }
    await this.config.save();

    this.installerCheck.shouldUseCachedInstallSteps = true;
    this.fileUploadProgress = 0;
    this.serverConnectProgress = 0;
    this.installerCheck.start();

    let installPhase: InstallStepErrorType | undefined = InstallStepErrorType.ServerConnect;
    try {
      console.info('Setting up mining machine');

      if (!this.config.serverDetails.ipAddress) {
        this.config.serverDetails = await MiningMachine.setup(this.config, this.walletKeys, pct => {
          this.serverConnectProgress = pct * 0.5;
        });
        this.remoteFilesNeedUpdating = true;
        await this.config.save();
      }

      this.serverConnectProgress = 60;
      const server = await this.getServer(5);
      this.serverConnectProgress = 90;
      this.installerCheck.activateServer(server);
      const uploadedWalletAddress = await server.downloadAccountAddress();
      if (!uploadedWalletAddress) {
        await server.deleteBotStorageFiles();
      }
      this.serverConnectProgress = 100;

      installPhase = InstallStepErrorType.FileUpload;
      if (this.remoteFilesNeedUpdating) {
        console.info('Uploading account address');
        await server.uploadAccountAddress(this.walletKeys.miningBotAddress);
        this.fileUploadProgress = 2;

        console.info('Uploading core files');
        await this.uploadCoreFiles((totalCount, uploadedCount) => {
          this.fileUploadProgress = 2 + (uploadedCount / totalCount) * 88;
        });
      }
      if (!this.isFreshInstall && this.config.miningSetupStatus === MiningSetupStatus.Finished) {
        const transactionTracker = getTransactionTracker();
        await transactionTracker.load();

        const proxySetup = await ensureMiningBidProxySetup({
          transactionTracker,
          walletKeys: this.walletKeys,
        });

        if (proxySetup.kind === 'insufficientFunds') {
          console.warn(
            '[Installer] Skipping mining bid proxy migration until the mining funding account is topped up',
            {
              error: proxySetup.error,
            },
          );
        } else if (proxySetup.kind === 'submitted' || proxySetup.kind === 'trackingExisting') {
          let uploadProgressInterval: ReturnType<typeof setInterval> | undefined;
          if (this.remoteFilesNeedUpdating) {
            const waitForBlockStartedAt = Date.now();
            const updateWaitProgress = () => {
              const elapsed = Date.now() - waitForBlockStartedAt;
              const progressRatio = Math.min(1, Math.max(0, elapsed / (TICK_MILLIS * 2)));
              this.fileUploadProgress = Math.max(this.fileUploadProgress, 90 + progressRatio * 5);
            };

            updateWaitProgress();
            uploadProgressInterval = setInterval(
              updateWaitProgress,
              Math.min(1000, Math.max(100, Math.ceil(TICK_MILLIS / 60))),
            );
          }

          // The bot already holds off bidding until the mining bid proxy is ready, so first inclusion is
          // enough to let the installer continue without waiting for full finality here.
          try {
            await proxySetup.txInfo.txResult.waitForInFirstBlock;
          } finally {
            if (uploadProgressInterval) clearInterval(uploadProgressInterval);
            if (this.remoteFilesNeedUpdating) {
              this.fileUploadProgress = Math.max(this.fileUploadProgress, 96);
            }
          }

          void proxySetup.txInfo.waitForPostProcessing.catch(error => {
            console.warn('[Installer] Mining bid proxy setup is still pending finalization', {
              error: getErrorDiagnostics(error),
            });
          });
        }
      }

      console.info('Uploading bot config files');
      await this.uploadBotConfigFiles((totalCount, uploadedCount) => {
        const startProgress = this.remoteFilesNeedUpdating ? Math.max(90, this.fileUploadProgress) : 0;
        this.fileUploadProgress = startProgress + (uploadedCount / totalCount) * (99 - startProgress);
      });

      console.info('Starting remote script');
      await server.createLogsDir();
      await server.startInstallerScript();
      installPhase = undefined;
      this.fileUploadProgress = 99;
      this.isRunningInBackground = true;
      this.installerCheck.shouldUseCachedInstallSteps = false;

      void this.saveLocalGatewayPortWhenReady(server, { updateExisting: true })
        .then(() => this.fns.refreshPrunedClient?.())
        .catch(error => {
          console.warn('Unable to save local gateway port', error);
        });

      console.info('Waiting for install to complete');
      await this.installerCheck.noThrowWaitForInstallToComplete();
      await this.saveLocalGatewayPortWhenReady(server, { timeoutMs: 30e3, updateExisting: true });
      this.fns.refreshPrunedClient?.();

      console.info('Confirming all install flags');
      this.remoteFilesNeedUpdating = false;
      console.info('Installer finished');
    } catch (e: any) {
      console.error('Installation failed', {
        installPhase,
        serverType: this.config.serverDetails.type,
        hasServerIpAddress: Boolean(this.config.serverDetails.ipAddress),
        remoteFilesNeedUpdating: this.remoteFilesNeedUpdating,
        runtime: getRuntimeDiagnostics(),
        error: getErrorDiagnostics(e),
      });
      this.config.serverInstaller.errorType = installPhase ?? InstallStepErrorType.Unknown;
      this.config.serverInstaller.errorMessage = e.message ?? `Installation failed - ${String(e)}`;
      this.config.serverInstaller = this.config.serverInstaller;
    }

    if (!this.disableWrites) {
      await this.config.save().catch(() => null);
    }

    this.isRunning = false;
    this.isRunningInBackground = false;
    this.isReadyToRun = false;
  }

  public async runFailedStep(stepKey: InstallStepKey | 'all'): Promise<void> {
    await this.isLoadedPromise;

    if ((this.isRunning ||= await this.calculateIsRunning())) {
      console.log('CANNOT runFailedStep because install is already running');
      return;
    }

    await this.clearStepFiles([stepKey], { setFirstStepToWorking: true });

    for (const step of Object.values(this.config.serverInstaller) as any) {
      if (!step?.status) continue;
      if (step.status === InstallStepStatus.Hidden) {
        step.status = InstallStepStatus.Pending;
        step.startDate = dayjs.utc().toDate();
      }
    }
    this.config.serverInstaller = this.config.serverInstaller;
    await this.config.save();

    this.installerCheck.clearCachedFilenames();
    this.installerCheck.shouldUseCachedInstallSteps = true;

    this.removeReasonsToSkipInstall();
    void this.run();
  }

  public async refreshLocalGatewayPort(timeoutMs = 5e3): Promise<void> {
    if (this.config.serverDetails.type !== ServerType.LocalComputer) return;

    const server = await this.getServer();
    await this.saveLocalGatewayPortWhenReady(server, { timeoutMs, updateExisting: true });
    this.fns.refreshPrunedClient?.();
  }

  public async updateServerConfig(
    options: { progressFn?: (totalCount: number, uploadedCount: number) => void; restartBot?: boolean } = {},
  ): Promise<void> {
    await this.isLoadedPromise;

    await this.uploadBotConfigFiles(options.progressFn, {
      restartBot: options.restartBot ?? this.config.isServerInstalled,
    });
  }

  private async getServer(retries?: number): Promise<ServerAdmin> {
    // We were getting into issues where server hadn't been created yet. I decided to just force
    // getting it in every function that needs it.
    if (!this._server) {
      const connection = await SSH.getOrCreateConnection(retries);
      this._server = new ServerAdmin(connection, this.config.serverDetails);
    }
    return this._server;
  }

  private async saveLocalGatewayPortWhenReady(
    server: ServerAdmin,
    options: { timeoutMs?: number; updateExisting?: boolean } = {},
  ): Promise<void> {
    if (this.config.serverDetails.type !== ServerType.LocalComputer) return;
    if (this.config.serverDetails.gatewayPort && !options.updateExisting) return;

    const gatewayPort = await server.waitForGatewayPort(options.timeoutMs).catch(() => undefined);
    if (gatewayPort && gatewayPort !== this.config.serverDetails.gatewayPort) {
      this.config.serverDetails = {
        ...this.config.serverDetails,
        gatewayPort,
      };
      await this.config.save();
    }
  }

  private async calculateIsReadyToRun(
    waitForLoaded: boolean = true,
    existingAccountAddress?: string,
  ): Promise<boolean> {
    if (waitForLoaded) {
      await this.isLoadedPromise;
    }
    this.reasonToSkipInstall = '';
    this.reasonToSkipInstallData = {};

    // We will begin by running through a series of checks to determine if the install process
    // should be started. We don't use serverDetails.isInstalling because the local value could
    // be out of date with the server.

    if (!this.config.isServerAdded) {
      this.reasonToSkipInstall = ReasonsToSkipInstall.ServerNotConnected;
      return false;
    }

    const tmpInstallChecks = await this.extractTmpInstallChecks(existingAccountAddress);
    const isFreshInstall = tmpInstallChecks.isFreshInstall;
    const isServerInstallComplete = tmpInstallChecks.isServerInstallComplete;
    const remoteFilesNeedUpdating = tmpInstallChecks.remoteFilesNeedUpdating;

    this.isFreshInstall = isFreshInstall;
    this.remoteFilesNeedUpdating = remoteFilesNeedUpdating;

    if (isServerInstallComplete && !remoteFilesNeedUpdating) {
      const server = await this.getServer();
      await this.saveLocalGatewayPortWhenReady(server, { timeoutMs: 5e3, updateExisting: true });
      this.fns.refreshPrunedClient?.();

      console.info('Remote files ARE up to date');
      this.isReadyToRun = false;
      this.reasonToSkipInstall = ReasonsToSkipInstall.ServerUpToDate;
      this.reasonToSkipInstallData = { isServerInstallComplete, remoteFilesNeedUpdating };
      this.config.isServerInstalling = false;
      await this.config.save();
      return false;
    }

    if (remoteFilesNeedUpdating) {
      const incompleteSteps = this.installerCheck.getIncompleteSteps();
      // clear out any abandoned steps only if we're not currently running
      if (!this.isRunning && incompleteSteps.length > 0) {
        console.info('Clearing stalled step files');
        const stepsToClear = [InstallStepKey.FileUpload, ...incompleteSteps];
        await this.clearStepFiles(stepsToClear, { setFirstStepToWorking: true });
      }
    }

    if (isFreshInstall || remoteFilesNeedUpdating) {
      // If the server is fresh, we need to reset the install details, and we can't skip the install process
      // even if next two conditions are met.
      this.isReadyToRun = true;
      this.removeReasonsToSkipInstall();
      this.config.resetField('serverInstaller');
      this.installerCheck.clearCachedFilenames();
      this.installerCheck.shouldUseCachedInstallSteps = true;
      this.config.isServerInstalling = true;
      await this.config.save();
      return true;
    }

    if (this.installerCheck.hasError) {
      this.isReadyToRun = false;
      this.reasonToSkipInstall = ReasonsToSkipInstall.ServerError;
      this.reasonToSkipInstallData = { hasInstallError: this.installerCheck.hasError };
      this.config.isServerInstalling = true;
      await this.config.save();
      return false;
    }

    const isWaitingForMinersToSync = this.config.serverInstaller.MiningLaunch.progress > 0.0;
    if (isWaitingForMinersToSync && !remoteFilesNeedUpdating) {
      this.isReadyToRun = false;
      this.reasonToSkipInstall = ReasonsToSkipInstall.MinersAreSyncing;
      this.reasonToSkipInstallData = { isWaitingForMinersToSync, remoteFilesNeedUpdating };
      await this.config.save();
      return false;
    }

    this.config.isServerInstalling = remoteFilesNeedUpdating;
    this.isReadyToRun = true;
    return true;
  }

  private async calculateIsRunning(): Promise<boolean> {
    if (this.isRunning) {
      console.log('Install process IS running');
      return true;
    }

    const server = await this.getServer();
    this.isRunning = await server.isInstallerScriptRunning();
    if (this.isRunning) {
      this.isRunningInBackground = true;
      this.config.isServerInstalling = true;
      console.log('Install process IS running remotely');
    }

    return this.isRunning;
  }

  private async activateInstallerCheck(waitForLoaded: boolean = true): Promise<void> {
    if (waitForLoaded) {
      await this.isLoadedPromise;
    }

    const hasProgress = this.config.serverInstaller.ServerConnect.progress > 0.0;
    const isComplete = this.config.serverInstaller.MiningLaunch.progress >= 100;
    if (!hasProgress || isComplete) return;

    this.isRunning = true;
    this.config.isServerInstalling = true;
    this.fns.refreshPrunedClient?.();

    const server = await this.getServer();
    this.installerCheck.activateServer(server);
    this.installerCheck.start();
    this.installerCheck.shouldUseCachedInstallSteps = false;

    console.info('Waiting for install to complete');
    await this.installerCheck.noThrowWaitForInstallToComplete();
    if (!this.installerCheck.hasError) {
      await this.saveLocalGatewayPortWhenReady(server, { timeoutMs: 30e3, updateExisting: true });
      this.fns.refreshPrunedClient?.();
    }

    this.isRunning = false;
    this.remoteFilesNeedUpdating = false;
  }

  private removeReasonsToSkipInstall(): void {
    this.reasonToSkipInstall = '';
    this.reasonToSkipInstallData = {};
  }

  private async extractTmpInstallChecks(existingAccountAddress?: string): Promise<TmpInstallChecks> {
    const server = await this.getServer();
    const existingAddress = existingAccountAddress ?? (await server.downloadAccountAddress());
    const isFreshInstall = !existingAddress;
    console.log('IS FRESH INSTALL', isFreshInstall, { existingAddress });

    if (isFreshInstall) {
      return {
        isFreshInstall,
        isServerInstallComplete: false,
        remoteFilesNeedUpdating: true,
      };
    }

    this.installerCheck.activateServer(server);
    this.installerCheck.shouldUseCachedInstallSteps = false;
    const remoteFilesNeedUpdating = !(await this.isRemoteVersionLatest());
    if (!remoteFilesNeedUpdating) {
      this.fileUploadProgress = 100;
    }
    // Resume the installer based on whether remote files need updating
    await this.installerCheck.updateInstallStatus(!remoteFilesNeedUpdating);
    const isServerInstallComplete = this.installerCheck.isServerInstallComplete;
    console.log('REMOTE FILES NEED UPDATING', {
      remoteFilesNeedUpdating,
      isServerInstallComplete,
    });

    return {
      isFreshInstall,
      isServerInstallComplete,
      remoteFilesNeedUpdating,
    };
  }

  private async isRemoteVersionLatest(): Promise<boolean> {
    const server = await this.getServer();
    const remoteShasum = await server.downloadRemoteShasum();
    const localShasum = await this.getLocalShasum();
    const remoteFilesMatchLocalShasum = localShasum === remoteShasum;

    console.info(`Remote files ${remoteFilesMatchLocalShasum ? 'DO' : 'do NOT'} match local shasum`);

    if (!remoteFilesMatchLocalShasum && !!remoteShasum.trim()) {
      const clean = (v: string) =>
        semver.parse(v.replace('server-', '').replace('.tar.gz', '')) ?? semver.parse('0.0.0')!;

      const remoteVersion = clean(remoteShasum.split(' ').pop()?.trim() ?? '0.0.0');
      const localVersion = clean(localShasum.split(' ').pop()?.trim() ?? '0.0.0');

      console.info(`Remote shasum: \n${remoteShasum}. ${remoteVersion.format()}`);
      console.info(`Local shasum: \n${localShasum}. ${localVersion.format()}`);

      // If the remote version is newer, we don't need to update the files
      if (semver.gt(remoteVersion, localVersion)) {
        console.info('Remote version is newer than local version - skipping update of remote files');
        return true;
      }
    }

    return remoteFilesMatchLocalShasum;
  }

  private async uploadCoreFiles(progressFn?: (totalCount: number, uploadedCount: number) => void): Promise<void> {
    const expectedSha = await this.getLocalShasum();

    const serverTar = expectedSha.split(' ').pop()?.trim();
    if (!serverTar) {
      throw new Error('Failed to extract server tar name from SHASUM256 file');
    }

    const workDir = this.config.serverDetails.workDir;
    const localServerTar = `resources/${serverTar}`;
    const remoteDir = `${this.config.serverDetails.workDir}/server`;
    let totalProgress = 0;
    const totalCount = 120;
    try {
      console.log(`Removing ${remoteDir}`);
      await SSH.runCommand(`rm -rf ${remoteDir} && mkdir -p ${remoteDir}`);
      totalProgress += 10;
      progressFn?.(totalCount, totalProgress);
    } catch (e) {
      // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
      console.error(`Failed to remove remote directory ${remoteDir}: ${e}`);
      throw e;
    }

    try {
      console.log(`Uploading server to ${remoteDir}`);
      const uploadStart = totalProgress;
      await SSH.uploadEmbeddedFile(localServerTar, `${workDir}/${serverTar}`, progress => {
        totalProgress = uploadStart + progress;
        progressFn?.(totalCount, totalProgress);
      });

      const [remoteSha256] = await SSH.runCommand(`cd ${workDir} && sha256sum ${serverTar}`);
      if (remoteSha256.replace(/\s+/, ' ').trim() !== expectedSha.replace(/\s+/, ' ').trim()) {
        console.log(`Remote SHA256: ${remoteSha256}`);
        console.log(`Embedded SHA256: ${expectedSha}`);
        throw new Error(`SHA256 mismatch: expected ${expectedSha}, got ${remoteSha256}`);
      }
      console.log(`FINISHED Uploading server to ${remoteDir}`);
    } catch (e) {
      // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
      console.error(`Failed to upload server to ${remoteDir}: ${e}`);
      throw e;
    }

    try {
      console.log(`Extracting server files to ${remoteDir}`);
      const [result, status] = await SSH.runCommand(`tar -xzf ${workDir}/${serverTar} -C ${remoteDir}`);
      if (status !== 0) {
        throw new Error(`Failed to extract server files: ${result}`);
      }
      await SSH.uploadFile(expectedSha, `${workDir}/server/SHASUM256`);
      console.log(`FINISHED Extracting server files to ${remoteDir} - ${result}`);
      totalProgress += 10;
      progressFn?.(totalCount, totalProgress);
    } catch (e) {
      // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
      console.error(`Failed to extract server files to ${remoteDir}: ${e}`);
      throw e;
    }

    progressFn?.(totalCount, totalCount);
  }

  private async uploadBotConfigFiles(
    progressFn?: (totalCount: number, uploadedCount: number) => void,
    options: { restartBot?: boolean } = {},
  ): Promise<void> {
    const server = await this.getServer();
    const delegateKeypair = await this.walletKeys.getVaultDelegateKeypair();
    const ethereumBeaconApiUrl =
      this.config.ethereumBeaconApiUrl === '' ? '' : getEthereumBeaconApiUrl(this.config.ethereumBeaconApiUrl);
    const ethereumExecutionRpcUrl = getEthereumExecutionRpcUrl(this.config.ethereumExecutionRpcUrl);

    await server.createConfigDir();

    const totalCount = 5;

    // Enable this when we're ready to upload the proxy wallet to the bot.
    // const miningBidProxyAccount = await this.walletKeys.exportMiningBidProxyAccountJson('');
    // await server.uploadMiningBotWallet(miningBidProxyAccount);
    const miningBotKeypair = await this.walletKeys.getMiningBotKeypair();
    await server.uploadMiningBotWallet(miningBotKeypair.toJson(''));
    progressFn?.(totalCount, 1);

    await server.uploadVaultDelegateWallet(delegateKeypair.toJson(''));
    progressFn?.(totalCount, 2);

    await server.uploadBiddingRules(this.config.biddingRules);
    progressFn?.(totalCount, 3);

    await server.uploadEnvState({
      oldestFrameIdToSync: this.config.oldestFrameIdToSync,
      miningFundingAccountId: this.walletKeys.miningBotAddress,
      vaultOperatorAddress: this.walletKeys.vaultingAddress,
      operatorAccountId: this.walletKeys.operationalAddress,
      ethereumBeaconApiUrl,
      ethereumExecutionRpcUrl,
    });
    progressFn?.(totalCount, 4);

    await server.uploadEnvSecurity({
      sessionMiniSecret: await this.walletKeys.getMiningSessionMiniSecret(),
    });
    progressFn?.(totalCount, 5);

    if (options.restartBot) {
      await server.startBotDocker();
    }
  }

  private async clearStepFiles(
    stepKeys: (InstallStepKey | 'all')[],
    options: { setFirstStepToWorking?: boolean } = {},
  ): Promise<void> {
    const server = await this.getServer();
    if (stepKeys.includes('all')) {
      this.config.resetField('serverInstaller');
      await this.config.save();
      await server.removeAllLogFiles();
      return;
    }

    const serverInstaller = this.config.serverInstaller;

    serverInstaller.errorType = null;
    serverInstaller.errorMessage = null;
    const defaultStepObj: IConfigInstallStep = {
      status: InstallStepStatus.Pending,
      progress: 0,
      startDate: null,
    };

    for (const stepKey of stepKeys as InstallStepKey[]) {
      const stepObj = { ...defaultStepObj };
      if (stepKey === stepKeys[0] && options.setFirstStepToWorking) {
        console.log('SETTING SERVER STEP TO WORKING', stepKey);
        stepObj.status = InstallStepStatus.Working;
        stepObj.startDate = dayjs.utc().toDate();
      }
      serverInstaller[stepKey] = { ...stepObj };
      await server.removeLogStep(stepKey);
    }
    this.config.serverInstaller = serverInstaller;
    await this.config.save();
  }

  private async getLocalShasum(): Promise<string> {
    const embeddedFiles = await invokeWithTimeout(
      'read_embedded_file',
      { localRelativePath: 'resources/SHASUM256' },
      10e3,
    );
    if (typeof embeddedFiles !== 'string') {
      throw new Error('Failed to read local version file');
    }
    return embeddedFiles.trim();
  }
}

interface TmpInstallChecks {
  isFreshInstall: boolean;
  isServerInstallComplete: boolean;
  remoteFilesNeedUpdating: boolean;
}
