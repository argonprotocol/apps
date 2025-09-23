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
import { createDeferred, ensureOnlyOneInstance, resetOnlyOneInstance } from './Utils';
import IDeferred from '../interfaces/IDeferred';
import { message as tauriMessage } from '@tauri-apps/plugin-dialog';
import { exit as tauriExit } from '@tauri-apps/plugin-process';
import { Server } from './Server';
import { invokeWithTimeout } from './tauriApi.ts';

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

export default class Installer {
  public isFreshInstall: boolean = false;
  public remoteFilesNeedUpdating: boolean = false;

  public isLoaded: boolean = false;
  public isLoadedPromise: Promise<void>;
  public isReadyToRun: boolean = false;

  public isRunning: boolean;
  public isRunningInBackground: boolean;
  public fileUploadProgress: number = 0;

  public reasonToSkipInstall: string;
  public reasonToSkipInstallData: any;

  public get isDockerHostProxy(): boolean {
    return this.config.serverDetails.type === ServerType.Docker;
  }

  private hasApprovedUpgrade = false;

  private isLoadedDeferred!: IDeferred<void>;
  private config: Config;
  private installerCheck: InstallerCheck;
  private disableWrites = false;

  private _server?: Server;

  constructor(config: Config) {
    ensureOnlyOneInstance(this.constructor);

    this.isRunning = false;
    this.isRunningInBackground = false;

    this.config = config;
    this.installerCheck = new InstallerCheck(this, config);
    this.reasonToSkipInstall = '';
    this.reasonToSkipInstallData = null;

    this.isLoadedDeferred = createDeferred<void>();
    this.isLoadedPromise = this.isLoadedDeferred.promise;
  }

  public async load(): Promise<void> {
    await this.config.isLoadedPromise;

    if (this.config.isMinerReadyToInstall) {
      await this.ensureIpAddressIsWhitelisted();
      const server = await this.getServer();
      const accountAddressOnServer = await server.downloadAccountAddress();
      if (accountAddressOnServer && accountAddressOnServer !== this.config.miningAccount.address) {
        await tauriMessage(
          'The wallet address on the server does not match the wallet address in the local database. This app will shutdown.',
          {
            title: 'Wallet Address Mismatch',
            kind: 'error',
          },
        );
        await tauriExit(0);
      }

      const isRunning = await this.calculateIsRunning();
      const isReadyToRun = !isRunning && (await this.calculateIsReadyToRun(false));
      if (isReadyToRun && !isRunning) {
        await this.run(false);
      } else {
        await this.activateInstallerCheck(false);
      }
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
    if (waitForLoaded) {
      await this.isLoadedPromise;
    }

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

    console.log('RUNNING INSTALLER');
    this.isRunning = true;
    this.isRunningInBackground = false;
    this.config.isMinerWaitingForUpgradeApproval = false;
    this.config.isMinerUpToDate = false;
    await this.config.save();

    if (this.remoteFilesNeedUpdating) {
      const stepsToClear = [
        InstallStepErrorType.FileUpload,
        InstallStepErrorType.BitcoinInstall,
        InstallStepErrorType.ArgonInstall,
        InstallStepErrorType.MiningLaunch,
      ];
      console.info('Clearing step files');
      await this.clearStepFiles(stepsToClear);
    }
    await this.ensureIpAddressIsWhitelisted();
    this.installerCheck.shouldUseCachedInstallSteps = true;
    this.fileUploadProgress = 0;
    this.installerCheck.start();

    let errorMessage = '';

    try {
      console.info('Downloading account address');
      const server = await this.getServer();
      const uploadedWalletAddress = await server.downloadAccountAddress();
      if (!uploadedWalletAddress) {
        await server.deleteBotStorageFiles();
      }

      if (this.remoteFilesNeedUpdating) {
        console.info('Uploading account address');
        await server.uploadAccountAddress(this.config.miningAccount.address);

        console.info('Uploading core files');
        await this.uploadCoreFiles(t => (this.fileUploadProgress += (1 / t) * 49));
      }

      console.info('Uploading bot config files');
      await this.uploadBotConfigFiles(t => (this.fileUploadProgress += (1 / t) * 49));

      console.info('Starting remote script');
      await server.createLogsDir();
      await server.startInstallerScript();
      this.fileUploadProgress = 99;

      this.isRunningInBackground = true;
      this.installerCheck.shouldUseCachedInstallSteps = false;

      console.info('Waiting for install to complete');
      await this.installerCheck.waitForInstallToComplete();

      console.info('Confirming all install flags');
      this.isRunning = false;
      this.isRunningInBackground = false;
      this.isReadyToRun = false;
      this.remoteFilesNeedUpdating = false;
      console.info('Installer finished');
    } catch (e) {
      console.error(`Installation failed: `, e);
      // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
      errorMessage = `Installation failed: ${e}`;
    }

    if (errorMessage && !this.disableWrites) {
      try {
        this.config.installDetails.errorType = InstallStepErrorType.Unknown;
        this.config.installDetails.errorMessage = errorMessage;
        this.config.installDetails = this.config.installDetails;
        await this.config.save();
      } catch (e) {
        // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
        console.error(`Failed to save install status: ${e}`);
      }
    }

    this.isRunning = false;
    this.isRunningInBackground = false;
    this.isReadyToRun = false;
  }

  public async uploadBiddingRules() {
    const server = await this.getServer();

    await server.uploadBiddingRules(this.config.biddingRules);
  }

  public async ensureIpAddressIsWhitelisted(): Promise<void> {
    // we don't have anything to connect to yet!
    if (!this.config.serverDetails.ipAddress) return;
    const ipResponse = await fetch('https://api.ipify.org?format=json');
    const { ip: ipAddress } = await ipResponse.json();
    await SSH.runCommand(`ufw status | grep ${ipAddress} || ufw allow from ${ipAddress}`);
  }

  public async runFailedStep(stepKey: string): Promise<void> {
    await this.isLoadedPromise;

    if ((this.isRunning ||= await this.calculateIsRunning())) {
      console.log('CANNOT runFailedStep because install is already running');
      return;
    }

    await this.clearStepFiles([stepKey], { setFirstStepToWorking: true });

    for (const step of Object.values(this.config.installDetails) as any) {
      if (!step?.status) continue;
      if (step.status === InstallStepStatus.Hidden) {
        step.status = InstallStepStatus.Pending;
        step.startDate = dayjs.utc().toISOString();
      }
    }
    this.config.installDetails = this.config.installDetails;
    await this.config.save();

    this.installerCheck.clearCachedFilenames();
    this.installerCheck.shouldUseCachedInstallSteps = true;

    this.removeReasonsToSkipInstall();
    void this.run();
  }

  private async getServer(): Promise<Server> {
    // We were getting into issues where server hadn't been created yet. I decided to just force
    // getting it in every function that needs it.
    if (!this._server) {
      const connection = await SSH.getOrCreateConnection();
      this._server = new Server(connection);
    }
    return this._server;
  }

  private async calculateIsReadyToRun(waitForLoaded: boolean = true): Promise<boolean> {
    if (waitForLoaded) {
      await this.isLoadedPromise;
    }
    this.reasonToSkipInstall = '';
    this.reasonToSkipInstallData = {};

    if (!this.config.isMinerReadyToInstall) {
      this.isReadyToRun = false;
      this.reasonToSkipInstall = ReasonsToSkipInstall.ServerNotConnected;
      this.reasonToSkipInstallData = { isMinerReadyToInstall: this.config.isMinerReadyToInstall };
      this.config.isMinerUpToDate = false;
      this.config.isMinerWaitingForUpgradeApproval = false;
      await this.config.save();
      return false;
    }

    // We will begin by running through a series of checks to determine if the install process
    // should be started. We don't use serverDetails.isInstalling because the local value could
    // be out of date with the server.
    const tmpInstallChecks = await this.extractTmpInstallChecks();
    const isFreshInstall = tmpInstallChecks.isFreshInstall;
    const isServerInstallComplete = tmpInstallChecks.isServerInstallComplete;
    const remoteFilesNeedUpdating = tmpInstallChecks.remoteFilesNeedUpdating;

    this.isFreshInstall = isFreshInstall;
    this.remoteFilesNeedUpdating = remoteFilesNeedUpdating;

    if (isServerInstallComplete && !remoteFilesNeedUpdating) {
      console.info('Remote files ARE up to date');
      this.isReadyToRun = false;
      this.reasonToSkipInstall = ReasonsToSkipInstall.ServerUpToDate;
      this.reasonToSkipInstallData = { isServerInstallComplete, remoteFilesNeedUpdating };
      this.config.isMinerUpToDate = true;
      this.config.isMinerWaitingForUpgradeApproval = false;
      await this.config.save();
      return false;
    }

    if (remoteFilesNeedUpdating) {
      this.hasApprovedUpgrade = true;

      console.info('Clearing step files');
      const stepsToClear = [InstallStepErrorType.FileUpload, InstallStepErrorType.MiningLaunch];
      await this.clearStepFiles(stepsToClear, { setFirstStepToWorking: true });

      this.installerCheck.clearCachedFilenames();
      this.installerCheck.shouldUseCachedInstallSteps = true;
      this.config.isMinerInstalled = false;
      this.config.isMinerUpToDate = false;
    }

    if (isFreshInstall || remoteFilesNeedUpdating) {
      // If the server is fresh, we need to reset the install details, and we can't skip the install process
      // even if next two conditions are met.
      this.isReadyToRun = true;
      this.removeReasonsToSkipInstall();
      this.config.resetField('installDetails');
      this.config.isMinerWaitingForUpgradeApproval = false;
      await this.config.save();
      return true;
    }

    console.log('this.installerCheck.hasError', this.installerCheck.hasError);
    if (this.installerCheck.hasError) {
      this.isReadyToRun = false;
      this.reasonToSkipInstall = ReasonsToSkipInstall.ServerError;
      this.reasonToSkipInstallData = { hasInstallError: this.installerCheck.hasError };
      this.config.isMinerUpToDate = false;
      await this.config.save();
      return false;
    }

    const isWaitingForMinersToSync = this.config.installDetails.MiningLaunch.progress > 0.0;
    if (isWaitingForMinersToSync && !remoteFilesNeedUpdating) {
      this.isReadyToRun = false;
      this.reasonToSkipInstall = ReasonsToSkipInstall.MinersAreSyncing;
      this.reasonToSkipInstallData = { isWaitingForMinersToSync, remoteFilesNeedUpdating };
      await this.config.save();
      return false;
    }

    this.config.isMinerUpToDate = remoteFilesNeedUpdating;
    this.isReadyToRun = true;
    return true;
  }

  private async calculateIsRunning(): Promise<boolean> {
    if (this.isRunning) {
      console.log('Install process IS running');
      return true;
    }

    if (!this.config.isMinerReadyToInstall) {
      return false;
    }

    const server = await this.getServer();
    this.isRunning = await server.isInstallerScriptRunning();
    if (this.isRunning) {
      this.isRunningInBackground = true;
      console.log('Install process IS running remotely');
    }

    return this.isRunning;
  }

  private async activateInstallerCheck(waitForLoaded: boolean = true): Promise<void> {
    if (waitForLoaded) {
      await this.isLoadedPromise;
    }

    const hasProgress = this.config.installDetails.ServerConnect.progress > 0.0;
    const isComplete = this.config.installDetails.MiningLaunch.progress >= 100;
    if (!hasProgress || isComplete) return;

    this.isRunning = true;
    this.installerCheck.start();
    this.installerCheck.shouldUseCachedInstallSteps = false;

    console.info('Waiting for install to complete');
    await this.installerCheck.waitForInstallToComplete();

    this.isRunning = false;
    this.remoteFilesNeedUpdating = false;
  }

  private removeReasonsToSkipInstall(): void {
    this.reasonToSkipInstall = '';
    this.reasonToSkipInstallData = {};
  }

  private async extractTmpInstallChecks(): Promise<TmpInstallChecks> {
    const server = await this.getServer();
    const isFreshInstall = !(await server.downloadAccountAddress());
    console.log('IS FRESH INSTALL', isFreshInstall);

    if (isFreshInstall) {
      return {
        isFreshInstall,
        isServerInstallComplete: false,
        remoteFilesNeedUpdating: true,
      };
    }

    await this.installerCheck.updateInstallStatus();
    const isServerInstallComplete = this.installerCheck.isServerInstallComplete;
    const remoteFilesNeedUpdating = !(await this.isRemoteVersionLatest());

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

    if (!remoteFilesMatchLocalShasum) {
      console.info(`Remote shasum: \n${remoteShasum}`);
      console.info(`Local shasum: \n${localShasum}`);
    }

    return remoteFilesMatchLocalShasum;
  }

  private async uploadCoreFiles(progressFn?: (totalCount: number, uploadedCount: number) => void): Promise<void> {
    const expectedSha = await this.getLocalShasum();

    const serverTar = expectedSha.split(' ').pop()?.trim();
    if (!serverTar) {
      throw new Error('Failed to extract server tar name from SHASUM256 file');
    }

    const localServerTar = `resources/${serverTar}`;
    const remoteDir = `~/server`;
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
      await SSH.uploadEmbeddedFile(localServerTar, `~/${serverTar}`, (progress: number) => {
        totalProgress += progress;
        progressFn?.(totalCount, totalProgress);
      });

      const [remoteSha256] = await SSH.runCommand(`cd ~ && sha256sum ${serverTar}`);
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
      const [result, status] = await SSH.runCommand(`tar -xzf ~/${serverTar} -C ${remoteDir}`);
      if (status !== 0) {
        throw new Error(`Failed to extract server files: ${result}`);
      }
      await SSH.uploadFile(expectedSha, `~/server/SHASUM256`);
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

  private async uploadBotConfigFiles(progressFn?: (totalCount: number, uploadedCount: number) => void): Promise<void> {
    const server = await this.getServer();
    await server.createConfigDir();
    await server.uploadMiningWallet(this.config.miningAccount.toJson(''));
    progressFn?.(4, 1);
    await server.uploadBiddingRules(this.config.biddingRules);
    progressFn?.(4, 2);
    await server.uploadEnvState({ oldestFrameIdToSync: this.config.oldestFrameIdToSync });
    progressFn?.(4, 3);
    await server.uploadEnvSecurity({
      sessionMiniSecret: this.config.miningSessionMiniSecret,
      keypairPassphrase: '',
    });
    progressFn?.(4, 4);
  }

  private async clearStepFiles(stepKeys: string[], options: { setFirstStepToWorking?: boolean } = {}): Promise<void> {
    const server = await this.getServer();
    if (stepKeys.includes('all')) {
      this.config.resetField('installDetails');
      await this.config.save();
      await server.removeAllLogFiles();
      return;
    }

    const installDetails = this.config.installDetails;

    installDetails.errorType = null;
    installDetails.errorMessage = null;
    const defaultStepObj: IConfigInstallStep = {
      status: InstallStepStatus.Pending,
      progress: 0,
      startDate: null,
    };

    for (const stepKey of stepKeys as InstallStepKey[]) {
      const stepObj = { ...defaultStepObj };
      if (String(stepKey) === stepKeys[0] && options.setFirstStepToWorking) {
        console.log('SETTING SERVER STEP TO WORKING3', stepKey);
        stepObj.status = InstallStepStatus.Working;
        stepObj.startDate = dayjs.utc().toISOString();
      } else if (stepKey === InstallStepKey.ServerConnect) {
        console.log('CLEAR STEP', stepKey, installDetails[stepKey]?.progress, ' -> ', stepObj.progress);
      }
      installDetails[stepKey] = { ...stepObj };
      await server.removeLogStep(stepKey);
    }

    console.log('clearStepFiles', stepKeys, installDetails);
    this.config.installDetails = installDetails;
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
