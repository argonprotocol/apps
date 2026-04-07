import dayjs, { Dayjs } from 'dayjs';
import utc from 'dayjs/plugin/utc';
import {
  IConfigInstallStep,
  IConfigServerInstallDetails,
  InstallStepErrorType,
  InstallStepKey,
  InstallStepStatus,
  MiningSetupStatus,
  VaultingSetupStatus,
} from '../interfaces/IConfig';
import { Config } from './Config';
import Installer from './Installer';
import { IInstallStepStatuses, InstallStepStatusType, ServerAdmin } from './ServerAdmin';
import { ServerApiClient } from './ServerApiClient.ts';

dayjs.extend(utc);

export class InstallerCheck {
  public shouldUseCachedInstallSteps = false;

  private hasCachedInstallSteps = false;

  private server!: ServerAdmin;
  private installer: Installer;
  private config: Config;
  private cachedInstallStepStatuses: IInstallStepStatuses = {};
  private noThrowIsCompletedPromise: Promise<void> | null = null;
  private shouldContinue = true;
  private checkInterval = 1000;

  constructor(installer: Installer, config: Config) {
    this.installer = installer;
    this.config = config;
  }

  public start(): void {
    this.noThrowIsCompletedPromise = new Promise(async resolve => {
      while (true) {
        await this.updateInstallStatus().catch(() => null);
        if (this.hasError) {
          console.log('InstallerCheck has error', this.config.serverInstaller.errorMessage);
          resolve();
          return;
        }

        if (this.isServerInstallComplete) {
          resolve();
          return;
        }

        await new Promise(resolve => setTimeout(resolve, this.checkInterval));
        if (!this.shouldContinue) {
          resolve();
          return;
        }
      }
    });
  }

  public activateServer(server: ServerAdmin): void {
    this.server = server;
  }

  public stop(): void {
    this.shouldContinue = false;
  }

  public async noThrowWaitForInstallToComplete(): Promise<void> {
    await this.noThrowIsCompletedPromise;
  }

  public get hasError(): boolean {
    return this.config.serverInstaller.errorType !== null;
  }

  public get isServerInstallComplete(): boolean {
    return (
      this.config.serverInstaller.UbuntuCheck.progress >= 100 &&
      this.config.serverInstaller.FileUpload.progress >= 100 &&
      this.config.serverInstaller.DockerInstall.progress >= 100 &&
      this.config.serverInstaller.BitcoinInstall.progress >= 100 &&
      this.config.serverInstaller.ArgonInstall.progress >= 100 &&
      this.config.serverInstaller.MiningLaunch.progress >= 100
    );
  }

  public getIncompleteSteps(): InstallStepKey[] {
    const failedSteps: InstallStepKey[] = [];
    for (const [stepKey, status] of Object.entries(this.cachedInstallStepStatuses)) {
      if (status !== InstallStepStatusType.Finished) {
        failedSteps.push(stepKey as unknown as InstallStepKey);
      }
    }
    return failedSteps;
  }

  public async updateInstallStatus(bypassSimulatedProgressIfFinished = false): Promise<void> {
    const serverInstallStepStatuses = await this.fetchInstallStepStatuses();
    console.log('serverInstallStepStatuses', serverInstallStepStatuses);
    const serverInstallerPending = Config.getDefault('serverInstaller') as IConfigServerInstallDetails;

    const stepsToProcess: Record<InstallStepKey, number> = {
      [InstallStepKey.ServerConnect]: 1,
      [InstallStepKey.FileUpload]: 1,
      [InstallStepKey.UbuntuCheck]: 1,
      [InstallStepKey.DockerInstall]: 5,
      [InstallStepKey.BitcoinInstall]: 10,
      [InstallStepKey.ArgonInstall]: 10,
      [InstallStepKey.MiningLaunch]: 0.2,
    };

    let prevStep: IConfigInstallStep | null = null;

    for (const [stepKey, estimatedMinutes] of Object.entries(stepsToProcess) as [InstallStepKey, number][]) {
      const stepNewData = serverInstallerPending[stepKey];
      const stepOldData = this.config.serverInstaller[stepKey];
      const prevStepHasCompleted = !prevStep || prevStep.status === InstallStepStatus.Completed;
      const filenameStatus = this.extractFilenameStatus(stepKey, serverInstallStepStatuses);
      if (prevStep?.status === InstallStepStatus.Failed) {
        stepNewData.status = InstallStepStatus.Hidden;
      } else if (prevStepHasCompleted && filenameStatus === InstallStepStatusType.Finished) {
        stepNewData.startDate = stepOldData.startDate || dayjs.utc().toDate();
        stepNewData.progress = stepOldData.progress;
        if (bypassSimulatedProgressIfFinished) {
          stepNewData.progress = 100;
          stepNewData.status = InstallStepStatus.Completed;
          continue;
        }

        if (this.installer.isRunning || stepKey === InstallStepKey.MiningLaunch) {
          stepNewData.progress = await InstallerCheck.calculateFinishedStepProgress(stepNewData);
        }
        if (stepNewData.progress >= 100 && stepOldData.status === InstallStepStatus.Working) {
          stepNewData.status = InstallStepStatus.Completing;
        } else if (stepNewData.progress >= 100) {
          stepNewData.status = InstallStepStatus.Completed;
        } else {
          stepNewData.status = InstallStepStatus.Working;
        }
      } else if (prevStepHasCompleted && filenameStatus === InstallStepStatusType.Failed) {
        stepNewData.status = InstallStepStatus.Failed;
        stepNewData.progress = stepOldData.progress;
        serverInstallerPending.errorType = stepKey as unknown as InstallStepErrorType;
        if (stepKey === InstallStepKey.ServerConnect || stepKey === InstallStepKey.FileUpload) {
          serverInstallerPending.errorMessage = this.config.serverInstaller.errorMessage;
        } else {
          serverInstallerPending.errorMessage = this.server
            ? await this.server.extractInstallStepFailureMessage(stepKey)
            : 'An unknown error occurred during installation.';
        }
      } else if (prevStepHasCompleted && this.installer.isRunning) {
        stepNewData.status = InstallStepStatus.Working;
        stepNewData.startDate = stepOldData.startDate || dayjs.utc().toDate();
        stepNewData.progress = stepOldData.progress;
        stepNewData.progress = await this.calculateWorkingStepProgress(stepKey, stepNewData, estimatedMinutes);
      } else if (prevStepHasCompleted) {
        Object.assign(stepNewData, stepOldData);
      } else {
        stepNewData.status = InstallStepStatus.Pending;
        stepNewData.progress = 0;
      }

      if (stepNewData.progress >= 100 && stepNewData.status !== InstallStepStatus.Completed) {
        stepNewData.status = InstallStepStatus.Completing;
      }

      prevStep = stepNewData;
    }

    this.config.serverInstaller = serverInstallerPending;
    if (this.isServerInstallComplete) {
      this.config.isServerInstalling = false;
      this.config.isServerInstalled = true;
      this.config.walletAccountsHadPreviousLife = false;
      this.config.walletPreviousLifeRecovered = false;
      this.config.miningBotAccountPreviousHistory = null;
    }
    await this.config.save();
  }

  public clearCachedFilenames(): void {
    this.cachedInstallStepStatuses = {};
  }

  private extractFilenameStatus(
    stepName: InstallStepKey,
    serverInstallStepStatuses: IInstallStepStatuses,
  ): InstallStepStatusType {
    if (
      [InstallStepKey.ServerConnect, InstallStepKey.FileUpload].includes(stepName) &&
      this.config.serverInstaller.errorType === (stepName as any) &&
      this.config.serverInstaller.errorMessage
    ) {
      return InstallStepStatusType.Failed;
    }

    if (stepName === InstallStepKey.ServerConnect) {
      if (!this.config.isServerAdded) {
        return InstallStepStatusType.Started;
      }
    }
    if (stepName === InstallStepKey.FileUpload) {
      if (this.installer.fileUploadProgress >= 100) {
        return InstallStepStatusType.Finished;
      }
    }

    return serverInstallStepStatuses[stepName] || InstallStepStatusType.Pending;
  }

  private async calculateWorkingStepProgress(
    stepName: InstallStepKey,
    stepPending: IConfigInstallStep,
    estimatedMinutes: number,
  ): Promise<number> {
    if (stepName === InstallStepKey.ServerConnect) {
      return this.installer.serverConnectProgress;
    } else if (stepName === InstallStepKey.FileUpload) {
      return this.installer.fileUploadProgress;
    } else if (stepName === InstallStepKey.BitcoinInstall) {
      const { ipAddress } = this.config.serverDetails;
      if (!ipAddress) return stepPending.progress;
      return await ServerApiClient.getBitcoinInstallProgress(ipAddress);
    } else if (stepName === InstallStepKey.ArgonInstall) {
      const { ipAddress } = this.config.serverDetails;
      if (!ipAddress) return stepPending.progress;
      return await ServerApiClient.getArgonInstallProgress(ipAddress);
    }

    const startDate = dayjs.utc(stepPending.startDate);
    return InstallerCheck.calculateStepProgress(startDate, estimatedMinutes);
  }

  private static async calculateFinishedStepProgress(stepPending: IConfigInstallStep): Promise<number> {
    const desiredMinutes = 0.0166; // 1 second
    const startDate = dayjs.utc(stepPending.startDate);

    return this.calculateStepProgress(startDate, desiredMinutes);
  }

  private static calculateStepProgress(startDate: Dayjs, desiredMinutes: number): number {
    const now = dayjs.utc();
    const desiredMilliseconds = desiredMinutes * 60 * 1000;
    const elapsedMilliseconds = now.diff(startDate, 'milliseconds');
    let progress = Math.round((elapsedMilliseconds / desiredMilliseconds) * 10_000) / 100;
    progress = Math.min(progress, 100);
    progress = Math.max(progress, 0.01);

    return progress;
  }

  private async fetchInstallStepStatuses(): Promise<IInstallStepStatuses> {
    if (!this.server || (this.hasCachedInstallSteps && this.shouldUseCachedInstallSteps)) {
      return this.cachedInstallStepStatuses;
    }

    try {
      this.cachedInstallStepStatuses = await this.server.downloadInstallStepStatuses();
      this.hasCachedInstallSteps = true;
      return this.cachedInstallStepStatuses;
    } catch {
      return {};
    }
  }
}
