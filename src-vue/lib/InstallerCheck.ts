import { SSH } from './SSH';
import dayjs, { Dayjs } from 'dayjs';
import utc from 'dayjs/plugin/utc';
import {
  IConfigInstallDetails,
  IConfigInstallStep,
  InstallStepErrorType,
  InstallStepKey,
  InstallStepStatus,
} from '../interfaces/IConfig';
import { Config } from './Config';
import Installer from './Installer';
import { IInstallStepStatuses, InstallStepStatusType, Server } from './Server';

dayjs.extend(utc);

export class InstallerCheck {
  public shouldUseCachedInstallSteps = false;

  private hasCachedInstallSteps = false;

  private server!: Server;
  private installer: Installer;
  private config: Config;
  private cachedInstallStepStatuses: IInstallStepStatuses = {};
  private isCompletedPromise: Promise<void> | null = null;
  private shouldContinue = true;
  private checkInterval = 1000;

  constructor(installer: Installer, config: Config) {
    this.installer = installer;
    this.config = config;
  }

  public start(): void {
    this.isCompletedPromise = new Promise(async (resolve, reject) => {
      while (true) {
        await this.updateInstallStatus().catch(() => null);
        if (this.hasError) {
          console.log('InstallerCheck has error', this.config.installDetails.errorMessage);
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

  public async activateServer(): Promise<void> {
    const connection = await SSH.getOrCreateConnection();
    this.server = new Server(connection, this.config.serverDetails);
  }

  public stop(): void {
    this.shouldContinue = false;
  }

  public async waitForInstallToComplete(): Promise<void> {
    await this.isCompletedPromise;
  }

  public get hasError(): boolean {
    return this.config.installDetails.errorType !== null;
  }

  public get isServerInstallComplete(): boolean {
    return (
      this.config.installDetails.UbuntuCheck.progress >= 100 &&
      this.config.installDetails.FileUpload.progress >= 100 &&
      this.config.installDetails.DockerInstall.progress >= 100 &&
      this.config.installDetails.BitcoinInstall.progress >= 100 &&
      this.config.installDetails.ArgonInstall.progress >= 100 &&
      this.config.installDetails.MiningLaunch.progress >= 100
    );
  }

  public async updateInstallStatus(): Promise<void> {
    const serverInstallStepStatuses = await this.fetchInstallStepStatuses();
    console.log('serverInstallStepStatuses', serverInstallStepStatuses);
    const installDetailsPending = Config.getDefault('installDetails') as IConfigInstallDetails;

    const stepsToProcess: Record<InstallStepKey, number> = {
      [InstallStepKey.ServerConnect]: 0.2,
      [InstallStepKey.FileUpload]: 1,
      [InstallStepKey.UbuntuCheck]: 1,
      [InstallStepKey.DockerInstall]: 5,
      [InstallStepKey.BitcoinInstall]: 10,
      [InstallStepKey.ArgonInstall]: 10,
      [InstallStepKey.MiningLaunch]: 0.2,
    };

    let prevStep: IConfigInstallStep | null = null;

    for (const [stepKey, estimatedMinutes] of Object.entries(stepsToProcess) as [InstallStepKey, number][]) {
      const stepNewData = installDetailsPending[stepKey];
      const stepOldData = this.config.installDetails[stepKey];
      const prevStepHasCompleted = !prevStep || prevStep.status === InstallStepStatus.Completed;
      const filenameStatus = this.extractFilenameStatus(stepKey, stepOldData, serverInstallStepStatuses);

      if (installDetailsPending.errorType) {
        stepNewData.status = InstallStepStatus.Hidden;
      } else if (prevStepHasCompleted && filenameStatus === InstallStepStatusType.Finished) {
        stepNewData.startDate = stepOldData.startDate || dayjs.utc().toISOString();
        stepNewData.progress = stepOldData.progress;
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
        installDetailsPending.errorType = stepKey as unknown as InstallStepErrorType;
        if (stepKey === InstallStepKey.ServerConnect) {
          installDetailsPending.errorMessage = this.installer.hasMiningMachineError;
        } else if (this.server) {
          installDetailsPending.errorMessage = await this.server.extractInstallStepFailureMessage(stepKey);
        }
      } else if (prevStepHasCompleted && this.installer.isRunning) {
        stepNewData.status = InstallStepStatus.Working;
        stepNewData.startDate = stepOldData.startDate || dayjs.utc().toISOString();
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

    this.config.installDetails = installDetailsPending;
    if (this.isServerInstallComplete) {
      this.config.isMinerInstalled = true;
      this.config.isMinerUpToDate = true;
      this.config.walletAccountsHadPreviousLife = false;
      this.config.walletPreviousLifeRecovered = false;
      this.config.miningAccountPreviousHistory = null;
    }
    await this.config.save();
  }

  public clearCachedFilenames(): void {
    this.cachedInstallStepStatuses = {};
  }

  private extractFilenameStatus(
    stepName: InstallStepKey,
    stepOldData: IConfigInstallStep,
    serverInstallStepStatuses: IInstallStepStatuses,
  ): InstallStepStatusType {
    const isServerConnectStep = stepName === InstallStepKey.ServerConnect;
    if (isServerConnectStep) {
      if (this.installer.hasMiningMachineError) {
        return InstallStepStatusType.Failed;
      }
      const nextStepHasStarted = this.installer.fileUploadProgress > 0;
      if (this.config.isMiningMachineCreated && (stepOldData.progress >= 100 || nextStepHasStarted)) {
        return InstallStepStatusType.Finished;
      } else {
        return InstallStepStatusType.Started;
      }
    }

    return serverInstallStepStatuses[stepName] || InstallStepStatusType.Pending;
  }

  private async calculateWorkingStepProgress(
    stepName: InstallStepKey,
    stepPending: IConfigInstallStep,
    estimatedMinutes: number,
  ): Promise<number> {
    if (stepName === InstallStepKey.FileUpload) {
      return this.installer.fileUploadProgress;
    } else if (stepName === InstallStepKey.BitcoinInstall) {
      return await this.server.fetchBitcoinInstallProgress();
    } else if (stepName === InstallStepKey.ArgonInstall) {
      return await this.server.fetchArgonInstallProgress();
    }

    const startDate = dayjs.utc(stepPending.startDate);
    return InstallerCheck.calculateStepProgress(startDate, estimatedMinutes);
  }

  private static async calculateFinishedStepProgress(stepPending: IConfigInstallStep): Promise<number> {
    const desiredMinutes = 0.0166; // 1 second
    const startDate = dayjs.utc(stepPending.startDate);
    const progress = this.calculateStepProgress(startDate, desiredMinutes);
    return progress;
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
