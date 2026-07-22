import './helpers/mocks.ts';
import { beforeEach, expect, it, vi } from 'vitest';
import * as Vue from 'vue';
import { Config } from '../lib/Config';
import Installer, { ReasonsToSkipInstall, resetInstaller } from '../lib/Installer';
import { createMockedDbPromise } from './helpers/db';
import { IInstallStepStatuses, InstallStepStatusType } from '../lib/ServerAdmin';
import {
  type IConfigInstallStep,
  InstallStepErrorType,
  InstallStepKey,
  InstallStepStatus,
  MiningSetupStatus,
  ServerType,
} from '../interfaces/IConfig';
import { InstallerCheck } from '../lib/InstallerCheck.ts';
import * as MiningAccount from '../lib/MiningAccount.ts';
import { MiningMachine } from '../lib/MiningMachine.ts';
import { WalletKeys } from '../lib/WalletKeys.ts';
import { getTransactionTracker } from '../stores/transactions.ts';
import { createMockWalletKeys, createTestWallet } from './helpers/wallet.ts';
import { TICK_MILLIS } from '../lib/Env.ts';
import { ServerApiClient } from '../lib/ServerApiClient.ts';

vi.mock('../stores/transactions.ts', () => ({
  getTransactionTracker: vi.fn(),
}));

beforeEach(() => {
  vi.restoreAllMocks();
  resetInstaller();
  WalletKeys.prototype.didWalletHavePreviousLife = vi.fn().mockResolvedValue(false);
});

it('should skip install if server is not connected', async () => {
  const dbPromise = createMockedDbPromise({ miningSetupStatus: `"${MiningSetupStatus.None}"` });

  const { walletKeys } = createTestWallet('//Alice');
  const config = new Config(dbPromise, walletKeys);
  await config.load();

  const installer = new Installer(config, walletKeys);
  await installer.load();
  // @ts-expect-error - test private method
  const didRun = await installer.calculateIsReadyToRun();

  expect(didRun).toBe(false);
  expect(installer.reasonToSkipInstall).toBe('ServerNotConnected');
});

it('keeps the installer loadable when a server check fails and clears the error after reconnecting', async () => {
  const { walletKeys } = createTestWallet('//Alice');
  const config = new Config(
    createMockedDbPromise({
      isServerInstalled: 'true',
      serverDetails: JSON.stringify({
        ipAddress: '143.198.226.10',
        sshPort: 22,
        sshUser: 'root',
        type: ServerType.DigitalOcean,
        workDir: '~',
      }),
    }),
    walletKeys,
  );
  await config.load();

  const installer = new Installer(config, walletKeys);
  const getServer = vi
    .spyOn(installer as any, 'getServer')
    .mockRejectedValueOnce(new Error('SSH authentication failed'));

  await expect(installer.load()).resolves.toBeUndefined();
  await expect(installer.isLoadedPromise).resolves.toBeUndefined();
  expect(installer.isLoaded).toBe(true);
  expect(config.serverInstaller).toMatchObject({
    errorType: InstallStepErrorType.ServerConnect,
    errorMessage: 'SSH authentication failed',
  });

  getServer.mockResolvedValue({
    downloadAccountAddress: vi.fn().mockResolvedValue(walletKeys.miningBotAddress),
  });
  vi.spyOn(installer as any, 'calculateIsReadyToRun').mockResolvedValue(false);
  vi.spyOn(installer as any, 'calculateIsRunning').mockResolvedValue(false);

  await installer.load();

  expect(config.serverInstaller.errorType).toBeNull();
  expect(config.serverInstaller.errorMessage).toBeNull();
});

it('should skip install if install is already running', async () => {
  const dbPromise = createMockedDbPromise({ miningSetupStatus: `"${MiningSetupStatus.Installing}"` });
  const { walletKeys } = createTestWallet('//Alice');
  const config = new Config(dbPromise, walletKeys);
  await config.load();

  const installer = new Installer(config, walletKeys);
  const runSpy = vi.spyOn(installer, 'run');
  installer.isRunning = true;
  await installer.load();

  expect(runSpy).not.toHaveBeenCalled();
  expect(installer.reasonToSkipInstall).toBe('');
});

it('installs a fresh server without treating it as an abandoned install', async () => {
  const dbPromise = createMockedDbPromise({});
  const { walletKeys } = createTestWallet('//Alice');
  const config = new Config(dbPromise, walletKeys);
  await config.load();

  const installer = new Installer(config, walletKeys);
  await installer.load();

  config.miningSetupStatus = MiningSetupStatus.None;
  config.isServerInstalling = false;
  config.serverDetails = {
    ...config.serverDetails,
    ipAddress: '127.0.0.1',
  };
  config.serverAdd = {
    localComputer: undefined,
  };
  await config.save();

  // @ts-ignore
  installer.isRemoteVersionLatest = vi.fn().mockResolvedValue(true);
  // @ts-ignore
  installer.calculateIsRunning = vi.fn().mockResolvedValue(false);
  // @ts-ignore
  installer.startInstallSteps = vi.fn().mockResolvedValue();
  const clearStepFiles = vi.spyOn(installer as any, 'clearStepFiles').mockResolvedValue(undefined);

  installer.isRunning = false;

  // @ts-expect-error - test private method
  const didRun = await installer.calculateIsReadyToRun();

  expect(didRun).toBe(true);
  expect(clearStepFiles).not.toHaveBeenCalled();
});

it('clears abandoned install steps when cached progress says the install completed', async () => {
  const dbPromise = createMockedDbPromise({});
  const walletKeys = createMockWalletKeys();
  const config = new Config(dbPromise, walletKeys);
  await config.load();

  const installer = new Installer(config, walletKeys);
  await installer.load();

  config.serverDetails = {
    ...config.serverDetails,
    ipAddress: '127.0.0.1',
  };
  for (const stepKey of [
    InstallStepKey.FileUpload,
    InstallStepKey.UbuntuCheck,
    InstallStepKey.DockerInstall,
    InstallStepKey.BitcoinInstall,
    InstallStepKey.ArgonInstall,
    InstallStepKey.MiningLaunch,
  ]) {
    config.serverInstaller[stepKey].progress = 100;
  }
  await config.save();

  const server = {
    downloadAccountAddress: vi.fn().mockResolvedValue(walletKeys.miningBotAddress),
    isInstallerScriptRunning: vi.fn().mockResolvedValue(false),
  };
  const installerCheck = (installer as any).installerCheck;
  const clearStepFiles = vi.spyOn(installer as any, 'clearStepFiles').mockResolvedValue(undefined);

  // @ts-ignore - keep the server surface focused in this unit test
  installer.getServer = vi.fn().mockResolvedValue(server);
  // @ts-ignore - exercise the up-to-date server path directly
  installer.isRemoteVersionLatest = vi.fn().mockResolvedValue(true);
  installerCheck.getIncompleteSteps = vi.fn().mockReturnValue([InstallStepKey.ArgonInstall]);
  installerCheck.updateInstallStatus = vi.fn().mockResolvedValue(undefined);

  // @ts-expect-error - test private method
  const didRun = await installer.calculateIsReadyToRun(false);

  expect(clearStepFiles).toHaveBeenCalledWith([InstallStepKey.FileUpload, InstallStepKey.ArgonInstall], {
    setFirstStepToWorking: true,
  });
  expect(didRun).toBe(true);
});

it('reruns an installed server when all remote step markers are missing', async () => {
  const dbPromise = createMockedDbPromise({});
  const walletKeys = createMockWalletKeys();
  const config = new Config(dbPromise, walletKeys);
  await config.load();

  const installer = new Installer(config, walletKeys);
  await installer.load();

  config.serverDetails = {
    ...config.serverDetails,
    ipAddress: '127.0.0.1',
  };
  for (const stepKey of [
    InstallStepKey.FileUpload,
    InstallStepKey.UbuntuCheck,
    InstallStepKey.DockerInstall,
    InstallStepKey.BitcoinInstall,
    InstallStepKey.ArgonInstall,
    InstallStepKey.MiningLaunch,
  ]) {
    config.serverInstaller[stepKey].progress = 100;
  }
  await config.save();

  const server = {
    downloadAccountAddress: vi.fn().mockResolvedValue(walletKeys.miningBotAddress),
    downloadInstallStepStatuses: vi.fn().mockResolvedValue({}),
    isInstallerScriptRunning: vi.fn().mockResolvedValue(false),
  };
  const clearStepFiles = vi.spyOn(installer as any, 'clearStepFiles').mockResolvedValue(undefined);

  // @ts-ignore - keep the server surface focused in this unit test
  installer.getServer = vi.fn().mockResolvedValue(server);
  // @ts-ignore - exercise the up-to-date server path directly
  installer.isRemoteVersionLatest = vi.fn().mockResolvedValue(true);

  // @ts-expect-error - test private method
  const didRun = await installer.calculateIsReadyToRun(false);

  expect(clearStepFiles).toHaveBeenCalledWith(
    [
      InstallStepKey.FileUpload,
      InstallStepKey.UbuntuCheck,
      InstallStepKey.DockerInstall,
      InstallStepKey.BitcoinInstall,
      InstallStepKey.ArgonInstall,
      InstallStepKey.MiningLaunch,
    ],
    { setFirstStepToWorking: true },
  );
  expect(didRun).toBe(true);
});

it('preserves failed install steps when the remote installer is no longer running', async () => {
  const dbPromise = createMockedDbPromise({});
  const walletKeys = createMockWalletKeys();
  const config = new Config(dbPromise, walletKeys);
  await config.load();

  const installer = new Installer(config, walletKeys);
  await installer.load();

  config.serverDetails = {
    ...config.serverDetails,
    ipAddress: '127.0.0.1',
  };
  for (const stepKey of [
    InstallStepKey.FileUpload,
    InstallStepKey.UbuntuCheck,
    InstallStepKey.DockerInstall,
    InstallStepKey.BitcoinInstall,
    InstallStepKey.ArgonInstall,
    InstallStepKey.MiningLaunch,
  ]) {
    config.serverInstaller[stepKey].progress = 100;
  }
  await config.save();

  const server = {
    downloadAccountAddress: vi.fn().mockResolvedValue(walletKeys.miningBotAddress),
    downloadInstallStepStatuses: vi.fn().mockResolvedValue({
      [InstallStepKey.ServerConnect]: InstallStepStatusType.Finished,
      [InstallStepKey.FileUpload]: InstallStepStatusType.Finished,
      [InstallStepKey.UbuntuCheck]: InstallStepStatusType.Finished,
      [InstallStepKey.DockerInstall]: InstallStepStatusType.Finished,
      [InstallStepKey.BitcoinInstall]: InstallStepStatusType.Finished,
      [InstallStepKey.ArgonInstall]: InstallStepStatusType.Finished,
      [InstallStepKey.MiningLaunch]: InstallStepStatusType.Failed,
    }),
    extractInstallStepFailureMessage: vi
      .fn()
      .mockResolvedValue('Server gateway did not become ready after 120 seconds'),
    isInstallerScriptRunning: vi.fn().mockResolvedValue(false),
  };
  const clearStepFiles = vi.spyOn(installer as any, 'clearStepFiles').mockResolvedValue(undefined);

  // @ts-ignore - keep the server surface focused in this unit test
  installer.getServer = vi.fn().mockResolvedValue(server);
  // @ts-ignore - exercise the up-to-date server path directly
  installer.isRemoteVersionLatest = vi.fn().mockResolvedValue(true);

  // @ts-expect-error - test private method
  const didRun = await installer.calculateIsReadyToRun(false);

  expect(clearStepFiles).not.toHaveBeenCalled();
  expect(didRun).toBe(false);
  expect(installer.reasonToSkipInstall).toBe(ReasonsToSkipInstall.ServerError);
  expect(config.serverInstaller.errorType).toBe(InstallStepErrorType.MiningLaunch);
  expect(config.serverInstaller.MiningLaunch.status).toBe(InstallStepStatus.Failed);
});

it('only uploads bot config files when updating server config', async () => {
  const dbPromise = createMockedDbPromise({});
  const walletKeys = createMockWalletKeys();
  const config = new Config(dbPromise, walletKeys);
  await config.load();

  const installer = new Installer(config, walletKeys);
  await installer.load();

  const uploadBotConfigFiles = vi.spyOn(installer as any, 'uploadBotConfigFiles').mockResolvedValue(undefined);

  await installer.updateServerConfig();

  expect(uploadBotConfigFiles).toHaveBeenCalledOnce();
});

it('uploads the mining bid proxy wallet while keeping the mining bot as the funding account', async () => {
  const dbPromise = createMockedDbPromise({});
  const walletKeys = createMockWalletKeys();
  const config = new Config(dbPromise, walletKeys);
  await config.load();

  const installer = new Installer(config, walletKeys);
  await installer.load();

  const miningBidProxyWalletJson = await walletKeys.exportMiningBidProxyAccountJson('');
  const server = {
    createConfigDir: vi.fn().mockResolvedValue(undefined),
    uploadMiningBotWallet: vi.fn().mockResolvedValue(undefined),
    uploadVaultDelegateWallet: vi.fn().mockResolvedValue(undefined),
    uploadBiddingRules: vi.fn().mockResolvedValue(undefined),
    uploadEnvState: vi.fn().mockResolvedValue(undefined),
    uploadEnvSecurity: vi.fn().mockResolvedValue(undefined),
  };
  // @ts-ignore - keep the test focused on upload payloads
  installer.getServer = vi.fn().mockResolvedValue(server);

  // @ts-ignore - exercise the upload path directly
  await installer.uploadBotConfigFiles();

  expect(server.uploadMiningBotWallet).toHaveBeenCalledWith(miningBidProxyWalletJson);
  expect(server.uploadEnvState).toHaveBeenCalledWith(
    expect.objectContaining({
      miningFundingAccountId: walletKeys.miningBotAddress,
    }),
  );
});

it('should run through entire install process', async () => {
  const dbPromise = createMockedDbPromise({ serverAdd: '{ "localComputer": {} }' });
  const walletKeys = createMockWalletKeys();
  const config = Vue.reactive(new Config(dbPromise, walletKeys)) as Config;
  await config.load();

  MiningMachine.setupLocalComputer = vi.fn().mockResolvedValue({
    type: ServerType.LocalComputer,
    ipAddress: `127.0.0.1`,
    sshPort: 25,
    sshUser: 'root',
    workDir: '/app',
  });

  const installer = new Installer(config, walletKeys);

  // @ts-ignore
  installer.isRemoteVersionLatest = vi.fn().mockResolvedValue(true);
  // @ts-ignore
  const installStepStatusPending: [InstallStepKey, InstallStepStatusType][] = [
    [InstallStepKey.ServerConnect, InstallStepStatusType.Finished],
    [InstallStepKey.FileUpload, InstallStepStatusType.Finished],
    [InstallStepKey.UbuntuCheck, InstallStepStatusType.Finished],
    [InstallStepKey.DockerInstall, InstallStepStatusType.Finished],
    [InstallStepKey.ArgonInstall, InstallStepStatusType.Finished],
    [InstallStepKey.BitcoinInstall, InstallStepStatusType.Finished],
    [InstallStepKey.MiningLaunch, InstallStepStatusType.Finished],
  ];
  const installStepStatusCompleted: IInstallStepStatuses = {};

  // @ts-ignore
  installer.installerCheck.fetchInstallStepStatuses = vi.fn(() => {
    if (installStepStatusPending.length) {
      const nextFiles = installStepStatusPending.splice(0, 2);
      for (const [key, status] of nextFiles) {
        installStepStatusCompleted[key] = status;
      }
    }
    return installStepStatusCompleted;
  });
  // @ts-ignore
  InstallerCheck.calculateFinishedStepProgress = vi.fn().mockResolvedValue(100);
  // @ts-ignore
  installer.installerCheck.checkInterval = 1;
  // @ts-ignore
  installer.getLocalShasum = vi.fn().mockResolvedValue('dummy-sha256');
  // @ts-ignore
  installer.uploadCoreFiles = vi.fn().mockResolvedValue();
  vi.spyOn(installer as any, 'uploadBotConfigFiles').mockResolvedValue(undefined);

  // should call run
  await installer.load();

  expect(config.serverInstaller.ServerConnect.status).toBe('Completed');
});

it('preserves the remote Docker Compose project name across a core file replacement', async () => {
  const dbPromise = createMockedDbPromise({});
  const walletKeys = createMockWalletKeys();
  const config = new Config(dbPromise, walletKeys);
  await config.load();

  config.serverDetails = {
    ...config.serverDetails,
    ipAddress: '127.0.0.1',
  };

  const installer = new Installer(config, walletKeys);
  await installer.load();

  const server = {
    downloadAccountAddress: vi.fn().mockResolvedValue(walletKeys.miningBotAddress),
    getComposeProjectName: vi.fn().mockResolvedValue('mainnet-default'),
    uploadAccountAddress: vi.fn().mockResolvedValue(undefined),
    createLogsDir: vi.fn().mockResolvedValue(undefined),
    startInstallerScript: vi.fn().mockResolvedValue(undefined),
  };
  const uploadCoreFiles = vi.spyOn(installer as any, 'uploadCoreFiles').mockResolvedValue(undefined);

  // @ts-ignore - exercise the upgrade path directly
  installer.calculateIsRunning = vi.fn().mockResolvedValue(false);
  // @ts-ignore - exercise the upgrade path directly
  installer.calculateIsReadyToRun = vi.fn().mockResolvedValue(true);
  // @ts-ignore - avoid real server setup in this unit test
  installer.getServer = vi.fn().mockResolvedValue(server);
  // @ts-ignore - avoid remote config uploads in this unit test
  installer.uploadBotConfigFiles = vi.fn().mockResolvedValue(undefined);
  // @ts-ignore - avoid port polling in this unit test
  installer.saveLocalGatewayPortWhenReady = vi.fn().mockResolvedValue(undefined);
  // @ts-ignore - drive the upload branch directly
  installer.remoteFilesNeedUpdating = true;
  // @ts-ignore - avoid log cleanup in this unit test
  installer.clearStepFiles = vi.fn().mockResolvedValue(undefined);
  // @ts-ignore - avoid background polling in this unit test
  installer.installerCheck.start = vi.fn();
  // @ts-ignore - avoid background polling in this unit test
  installer.installerCheck.activateServer = vi.fn();
  // @ts-ignore - avoid background polling in this unit test
  installer.installerCheck.noThrowWaitForInstallToComplete = vi.fn().mockResolvedValue(undefined);

  await installer.run(false);

  expect(server.getComposeProjectName).toHaveBeenCalledOnce();
  expect(server.getComposeProjectName.mock.invocationCallOrder[0]).toBeLessThan(
    uploadCoreFiles.mock.invocationCallOrder[0],
  );
  expect(server.startInstallerScript).toHaveBeenCalledWith({ composeProjectName: 'mainnet-default' });
});

it('uses a brief startup estimate until bot sync progress is available', async () => {
  const walletKeys = createMockWalletKeys();
  const config = new Config(createMockedDbPromise({}), walletKeys);
  await config.load();
  config.serverDetails = {
    ...config.serverDetails,
    ipAddress: '127.0.0.1',
  };
  config.serverInstaller.MiningLaunch.startDate = new Date(Date.now() - 60 * 60 * 1000);

  const installer = new Installer(config, walletKeys);
  const installerCheck = Reflect.get(installer, 'installerCheck') as InstallerCheck;
  const calculateWorkingStepProgress = Reflect.get(installerCheck, 'calculateWorkingStepProgress') as (
    stepName: InstallStepKey,
    stepPending: IConfigInstallStep,
    estimatedMinutes: number,
  ) => Promise<number>;
  vi.spyOn(ServerApiClient, 'getBotInstallProgress')
    .mockRejectedValueOnce(new Error('Bot gateway is starting'))
    .mockResolvedValue(37.5);
  vi.spyOn(installer, 'refreshLocalGatewayPort').mockResolvedValue(undefined);

  await expect(
    calculateWorkingStepProgress.call(
      installerCheck,
      InstallStepKey.MiningLaunch,
      config.serverInstaller.MiningLaunch,
      0.2,
    ),
  ).resolves.toBe(5);
  await expect(
    calculateWorkingStepProgress.call(
      installerCheck,
      InstallStepKey.MiningLaunch,
      config.serverInstaller.MiningLaunch,
      0.2,
    ),
  ).resolves.toBe(37.5);
});

it('persists SSH details before later installation work can fail', async () => {
  const dbPromise = createMockedDbPromise({ serverAdd: '{ "localComputer": {} }' });
  const db = await dbPromise;
  const insertOrReplace = vi.spyOn(db.configTable, 'insertOrReplace');
  const walletKeys = createMockWalletKeys();
  const config = new Config(dbPromise, walletKeys);
  await config.load();

  MiningMachine.setupLocalComputer = vi.fn().mockResolvedValue({
    type: ServerType.LocalComputer,
    ipAddress: '127.0.0.1',
    sshPort: 2222,
    sshUser: 'argon',
    workDir: '/app',
  });

  const installer = new Installer(config, walletKeys);
  let wereSshDetailsSavedBeforeFailure = false;
  // @ts-ignore - keep the failure after machine setup and before bot installation
  installer.getServer = vi.fn().mockImplementation(async () => {
    wereSshDetailsSavedBeforeFailure = insertOrReplace.mock.calls.some(([data]) =>
      data.serverDetails?.includes('"sshPort": 2222'),
    );
    throw new Error('SSH server unavailable');
  });
  // @ts-ignore - avoid background status polling in this focused persistence test
  installer.installerCheck.start = vi.fn();

  await installer.load();

  expect(wereSshDetailsSavedBeforeFailure).toBe(true);
  expect(config.serverDetails).toMatchObject({
    ipAddress: '127.0.0.1',
    sshPort: 2222,
    sshUser: 'argon',
  });
});

it('does not resume installer polling when the remote installer is no longer running', async () => {
  const dbPromise = createMockedDbPromise({});
  const walletKeys = createMockWalletKeys();
  const config = new Config(dbPromise, walletKeys);
  await config.load();

  const installer = new Installer(config, walletKeys);
  await installer.load();

  config.serverDetails = {
    ...config.serverDetails,
    ipAddress: '127.0.0.1',
  };
  config.serverInstaller.ServerConnect.progress = 100;
  config.serverInstaller.MiningLaunch.progress = 50;
  await config.save();

  const server = {
    isInstallerScriptRunning: vi.fn().mockResolvedValue(false),
  };
  const installerCheck = (installer as any).installerCheck;

  // @ts-ignore - keep the server surface focused in this unit test
  installer.getServer = vi.fn().mockResolvedValue(server);
  installerCheck.activateServer = vi.fn();
  installerCheck.start = vi.fn();

  // @ts-expect-error - test private method
  await installer.activateInstallerCheck(false);

  expect(installerCheck.activateServer).toHaveBeenCalledWith(server);
  expect(installerCheck.start).not.toHaveBeenCalled();
  expect(installer.isRunning).toBe(false);
  expect(config.isServerInstalling).toBe(false);
});

it('resumes installer polling when cached progress is 100 but the final step is still working', async () => {
  const walletKeys = createMockWalletKeys();
  const config = new Config(createMockedDbPromise({}), walletKeys);
  await config.load();

  const installer = new Installer(config, walletKeys);
  config.serverDetails = {
    ...config.serverDetails,
    ipAddress: '127.0.0.1',
  };
  config.serverInstaller.ServerConnect.progress = 100;
  config.serverInstaller.MiningLaunch.progress = 100;
  config.serverInstaller.MiningLaunch.status = InstallStepStatus.Working;
  config.isServerInstalling = true;

  const server = {
    isInstallerScriptRunning: vi.fn().mockResolvedValue(true),
  };
  const installerCheck = (installer as any).installerCheck as InstallerCheck;
  const start = vi.spyOn(installerCheck, 'start').mockImplementation(() => undefined);
  vi.spyOn(installerCheck, 'noThrowWaitForInstallToComplete').mockResolvedValue(undefined);
  vi.spyOn(installer as any, 'getServer').mockResolvedValue(server);
  vi.spyOn(installer as any, 'saveLocalGatewayPortWhenReady').mockResolvedValue(undefined);

  // @ts-expect-error - test private method
  await installer.activateInstallerCheck(false);

  expect(start).toHaveBeenCalledOnce();
});

it('keeps installer failures visible when the remote installer is no longer running', async () => {
  const dbPromise = createMockedDbPromise({});
  const walletKeys = createMockWalletKeys();
  const config = new Config(dbPromise, walletKeys);
  await config.load();

  const installer = new Installer(config, walletKeys);
  await installer.load();

  config.serverDetails = {
    ...config.serverDetails,
    ipAddress: '127.0.0.1',
  };
  config.serverInstaller.ServerConnect.progress = 100;
  config.serverInstaller.ArgonInstall.progress = 50;
  config.serverInstaller.errorType = InstallStepErrorType.ArgonInstall;
  config.serverInstaller.errorMessage = 'Server ran out of disk space while installing.';
  config.isServerInstalling = true;
  await config.save();

  const server = {
    isInstallerScriptRunning: vi.fn().mockResolvedValue(false),
  };
  const installerCheck = (installer as any).installerCheck;

  // @ts-ignore - keep the server surface focused in this unit test
  installer.getServer = vi.fn().mockResolvedValue(server);
  installerCheck.activateServer = vi.fn();
  installerCheck.start = vi.fn();

  // @ts-expect-error - test private method
  await installer.activateInstallerCheck(false);

  expect(installerCheck.start).not.toHaveBeenCalled();
  expect(installer.isRunning).toBe(false);
  expect(config.isServerInstalling).toBe(true);
  expect(config.serverInstaller.errorType).toBe(InstallStepErrorType.ArgonInstall);
});

it('waits for the first Argon block before uploading bot config files', async () => {
  const dbPromise = createMockedDbPromise({});
  const walletKeys = createMockWalletKeys();
  const config = new Config(dbPromise, walletKeys);
  await config.load();
  config.miningSetupStatus = MiningSetupStatus.Finished;

  const installer = new Installer(config, walletKeys);
  await installer.load();

  config.serverDetails = {
    ...config.serverDetails,
    ipAddress: '127.0.0.1',
  };

  const server = {
    downloadAccountAddress: vi.fn().mockResolvedValue(walletKeys.miningBotAddress),
    createLogsDir: vi.fn().mockResolvedValue(undefined),
    startInstallerScript: vi.fn().mockResolvedValue(undefined),
  };
  const uploadBotConfigFiles = vi.spyOn(installer as any, 'uploadBotConfigFiles').mockResolvedValue(undefined);
  const transactionTracker = {
    load: vi.fn().mockResolvedValue(undefined),
  };
  let resolveProxySetupInBlock: () => void = () => undefined;
  const proxySetupInBlock = new Promise<void>(resolve => {
    resolveProxySetupInBlock = resolve;
  });
  const proxySetupSpy = vi.spyOn(MiningAccount, 'ensureMiningBidProxySetup').mockResolvedValue({
    kind: 'trackingExisting',
    txInfo: {
      txResult: {
        waitForInFirstBlock: proxySetupInBlock,
      },
      waitForPostProcessing: new Promise<void>(() => undefined),
    },
  } as any);

  // @ts-ignore - exercise the upgrade path directly
  installer.calculateIsRunning = vi.fn().mockResolvedValue(false);
  // @ts-ignore - exercise the upgrade path directly
  installer.calculateIsReadyToRun = vi.fn().mockResolvedValue(true);
  // @ts-ignore - avoid real server setup in this unit test
  installer.getServer = vi.fn().mockResolvedValue(server);
  // @ts-ignore - avoid port polling in this unit test
  installer.saveLocalGatewayPortWhenReady = vi.fn().mockResolvedValue(undefined);
  // @ts-ignore - drive the non-fresh path directly
  installer.isFreshInstall = false;
  // @ts-ignore - skip core file upload in this unit test
  installer.remoteFilesNeedUpdating = false;
  // @ts-ignore - avoid background polling in this unit test
  installer.installerCheck.start = vi.fn();
  // @ts-ignore - avoid background polling in this unit test
  installer.installerCheck.activateServer = vi.fn();
  // @ts-ignore - avoid background polling in this unit test
  installer.installerCheck.noThrowWaitForInstallToComplete = vi.fn().mockResolvedValue(undefined);
  vi.mocked(getTransactionTracker).mockReturnValue(transactionTracker as any);

  const runPromise = installer.run(false);

  await vi.waitFor(() => expect(proxySetupSpy).toHaveBeenCalledOnce());
  expect(transactionTracker.load).toHaveBeenCalledOnce();
  expect(uploadBotConfigFiles).not.toHaveBeenCalled();

  resolveProxySetupInBlock();
  await runPromise;

  expect(uploadBotConfigFiles).toHaveBeenCalledOnce();
});

it('shows file-upload progress between 90 and 96 while waiting for proxy setup inclusion', async () => {
  const dbPromise = createMockedDbPromise({});
  const walletKeys = createMockWalletKeys();
  const config = new Config(dbPromise, walletKeys);
  await config.load();
  config.miningSetupStatus = MiningSetupStatus.Finished;

  const installer = new Installer(config, walletKeys);
  await installer.load();

  config.serverDetails = {
    ...config.serverDetails,
    ipAddress: '127.0.0.1',
  };

  const server = {
    downloadAccountAddress: vi.fn().mockResolvedValue(walletKeys.miningBotAddress),
    getComposeProjectName: vi.fn().mockResolvedValue('mainnet-default'),
    uploadAccountAddress: vi.fn().mockResolvedValue(undefined),
    createLogsDir: vi.fn().mockResolvedValue(undefined),
    startInstallerScript: vi.fn().mockResolvedValue(undefined),
  };
  let resolveUploadBotConfigFiles: () => void = () => undefined;
  const uploadBotConfigFilesPromise = new Promise<void>(resolve => {
    resolveUploadBotConfigFiles = resolve;
  });
  const uploadBotConfigFiles = vi
    .spyOn(installer as any, 'uploadBotConfigFiles')
    .mockImplementation(async () => await uploadBotConfigFilesPromise);
  let resolveUploadReachedNinety: () => void = () => undefined;
  const uploadReachedNinety = new Promise<void>(resolve => {
    resolveUploadReachedNinety = resolve;
  });
  vi.spyOn(installer as any, 'uploadCoreFiles').mockImplementation(async (...args: unknown[]) => {
    const progressFn = args[0] as ((totalCount: number, uploadedCount: number) => void) | undefined;
    progressFn?.(1, 1);
    resolveUploadReachedNinety();
  });

  const transactionTracker = {
    load: vi.fn().mockResolvedValue(undefined),
  };
  let resolveProxySetupInBlock: () => void = () => undefined;
  const proxySetupInBlock = new Promise<void>(resolve => {
    resolveProxySetupInBlock = resolve;
  });
  vi.spyOn(MiningAccount, 'ensureMiningBidProxySetup').mockResolvedValue({
    kind: 'trackingExisting',
    txInfo: {
      txResult: {
        waitForInFirstBlock: proxySetupInBlock,
      },
      waitForPostProcessing: new Promise<void>(() => undefined),
    },
  } as any);

  // @ts-ignore - exercise the upgrade path directly
  installer.calculateIsRunning = vi.fn().mockResolvedValue(false);
  // @ts-ignore - exercise the upgrade path directly
  installer.calculateIsReadyToRun = vi.fn().mockResolvedValue(true);
  // @ts-ignore - avoid real server setup in this unit test
  installer.getServer = vi.fn().mockResolvedValue(server);
  // @ts-ignore - avoid port polling in this unit test
  installer.saveLocalGatewayPortWhenReady = vi.fn().mockResolvedValue(undefined);
  // @ts-ignore - drive the non-fresh path directly
  installer.isFreshInstall = false;
  // @ts-ignore - drive the upload branch directly
  installer.remoteFilesNeedUpdating = true;
  // @ts-ignore - avoid log cleanup in this unit test
  installer.clearStepFiles = vi.fn().mockResolvedValue(undefined);
  // @ts-ignore - avoid background polling in this unit test
  installer.installerCheck.start = vi.fn();
  // @ts-ignore - avoid background polling in this unit test
  installer.installerCheck.activateServer = vi.fn();
  // @ts-ignore - avoid background polling in this unit test
  installer.installerCheck.noThrowWaitForInstallToComplete = vi.fn().mockResolvedValue(undefined);
  vi.mocked(getTransactionTracker).mockReturnValue(transactionTracker as any);

  vi.useFakeTimers();
  try {
    const runPromise = installer.run(false);

    await uploadReachedNinety;

    expect(installer.fileUploadProgress).toBe(90);
    expect(uploadBotConfigFiles).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(TICK_MILLIS);
    expect(installer.fileUploadProgress).toBeGreaterThan(90);
    expect(installer.fileUploadProgress).toBeLessThan(96);
    expect(uploadBotConfigFiles).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(TICK_MILLIS);
    expect(installer.fileUploadProgress).toBe(95);
    expect(uploadBotConfigFiles).not.toHaveBeenCalled();

    resolveProxySetupInBlock();
    await Promise.resolve();
    await Promise.resolve();

    expect(installer.fileUploadProgress).toBe(96);
    expect(uploadBotConfigFiles).toHaveBeenCalledOnce();

    resolveUploadBotConfigFiles();
    await runPromise;
  } finally {
    vi.useRealTimers();
  }
});

it('does not start the remote installer after an app update is installed', async () => {
  const dbPromise = createMockedDbPromise({});
  const walletKeys = createMockWalletKeys();
  const config = new Config(dbPromise, walletKeys);
  await config.load();

  let isAppUpdateBlockingInstall = false;
  const installer = new Installer(config, walletKeys, {
    isAppUpdateBlockingInstall: () => isAppUpdateBlockingInstall,
  });
  await installer.load();

  config.serverDetails = {
    ...config.serverDetails,
    ipAddress: '127.0.0.1',
  };

  const server = {
    downloadAccountAddress: vi.fn().mockResolvedValue(walletKeys.miningBotAddress),
    getComposeProjectName: vi.fn().mockResolvedValue('mainnet-default'),
    uploadAccountAddress: vi.fn().mockResolvedValue(undefined),
    createLogsDir: vi.fn().mockResolvedValue(undefined),
    startInstallerScript: vi.fn().mockResolvedValue(undefined),
  };
  let finishCoreUpload: () => void = () => undefined;
  const coreUploadFinished = new Promise<void>(resolve => {
    finishCoreUpload = resolve;
  });
  let coreUploadStarted: () => void = () => undefined;
  const coreUploadStartedPromise = new Promise<void>(resolve => {
    coreUploadStarted = resolve;
  });
  vi.spyOn(installer as any, 'uploadCoreFiles').mockImplementation(async () => {
    coreUploadStarted();
    await coreUploadFinished;
  });
  const uploadBotConfigFiles = vi.spyOn(installer as any, 'uploadBotConfigFiles').mockResolvedValue(undefined);

  // @ts-ignore - exercise the upgrade path directly
  installer.calculateIsRunning = vi.fn().mockResolvedValue(false);
  // @ts-ignore - exercise the upgrade path directly
  installer.calculateIsReadyToRun = vi.fn().mockResolvedValue(true);
  // @ts-ignore - avoid real server setup in this unit test
  installer.getServer = vi.fn().mockResolvedValue(server);
  // @ts-ignore - drive the upload branch directly
  installer.remoteFilesNeedUpdating = true;
  // @ts-ignore - avoid log cleanup in this unit test
  installer.clearStepFiles = vi.fn().mockResolvedValue(undefined);
  // @ts-ignore - avoid background polling in this unit test
  installer.installerCheck.start = vi.fn();

  const runPromise = installer.run(false);
  await coreUploadStartedPromise;

  isAppUpdateBlockingInstall = true;
  finishCoreUpload();
  await runPromise;

  expect(uploadBotConfigFiles).not.toHaveBeenCalled();
  expect(server.startInstallerScript).not.toHaveBeenCalled();
  expect(installer.reasonToSkipInstall).toBe(ReasonsToSkipInstall.AppUpdateRequiresRestart);
});

it('skips installer proxy setup before mining setup is finished', async () => {
  const dbPromise = createMockedDbPromise({});
  const walletKeys = createMockWalletKeys();
  const config = new Config(dbPromise, walletKeys);
  await config.load();

  const installer = new Installer(config, walletKeys);
  await installer.load();

  config.serverDetails = {
    ...config.serverDetails,
    ipAddress: '127.0.0.1',
  };

  const server = {
    downloadAccountAddress: vi.fn().mockResolvedValue(walletKeys.miningBotAddress),
    createLogsDir: vi.fn().mockResolvedValue(undefined),
    startInstallerScript: vi.fn().mockResolvedValue(undefined),
  };
  const uploadBotConfigFiles = vi.spyOn(installer as any, 'uploadBotConfigFiles').mockResolvedValue(undefined);
  const proxySetupSpy = vi.spyOn(MiningAccount, 'ensureMiningBidProxySetup');

  // @ts-ignore - exercise the upgrade path directly
  installer.calculateIsRunning = vi.fn().mockResolvedValue(false);
  // @ts-ignore - exercise the upgrade path directly
  installer.calculateIsReadyToRun = vi.fn().mockResolvedValue(true);
  // @ts-ignore - avoid real server setup in this unit test
  installer.getServer = vi.fn().mockResolvedValue(server);
  // @ts-ignore - avoid port polling in this unit test
  installer.saveLocalGatewayPortWhenReady = vi.fn().mockResolvedValue(undefined);
  // @ts-ignore - drive the non-fresh path directly
  installer.isFreshInstall = false;
  // @ts-ignore - skip core file upload in this unit test
  installer.remoteFilesNeedUpdating = false;
  // @ts-ignore - avoid background polling in this unit test
  installer.installerCheck.start = vi.fn();
  // @ts-ignore - avoid background polling in this unit test
  installer.installerCheck.activateServer = vi.fn();
  // @ts-ignore - avoid background polling in this unit test
  installer.installerCheck.noThrowWaitForInstallToComplete = vi.fn().mockResolvedValue(undefined);

  await installer.run(false);

  expect(proxySetupSpy).not.toHaveBeenCalled();
  expect(uploadBotConfigFiles).toHaveBeenCalledOnce();
});

it('does not fail installer proxy migration when the mining funding account is short on funds', async () => {
  const dbPromise = createMockedDbPromise({});
  const walletKeys = createMockWalletKeys();
  const config = new Config(dbPromise, walletKeys);
  await config.load();
  config.miningSetupStatus = MiningSetupStatus.Finished;

  const installer = new Installer(config, walletKeys);
  await installer.load();

  config.serverDetails = {
    ...config.serverDetails,
    ipAddress: '127.0.0.1',
  };

  const server = {
    downloadAccountAddress: vi.fn().mockResolvedValue(walletKeys.miningBotAddress),
    createLogsDir: vi.fn().mockResolvedValue(undefined),
    startInstallerScript: vi.fn().mockResolvedValue(undefined),
  };
  const uploadBotConfigFiles = vi.spyOn(installer as any, 'uploadBotConfigFiles').mockResolvedValue(undefined);
  const transactionTracker = {
    load: vi.fn().mockResolvedValue(undefined),
  };
  const proxySetupSpy = vi.spyOn(MiningAccount, 'ensureMiningBidProxySetup').mockResolvedValue({
    kind: 'insufficientFunds',
    error: 'Mining bid account needs 1 ARGN to seed its bid proxy.',
  });

  // @ts-ignore - exercise the upgrade path directly
  installer.calculateIsRunning = vi.fn().mockResolvedValue(false);
  // @ts-ignore - exercise the upgrade path directly
  installer.calculateIsReadyToRun = vi.fn().mockResolvedValue(true);
  // @ts-ignore - avoid real server setup in this unit test
  installer.getServer = vi.fn().mockResolvedValue(server);
  // @ts-ignore - avoid port polling in this unit test
  installer.saveLocalGatewayPortWhenReady = vi.fn().mockResolvedValue(undefined);
  // @ts-ignore - drive the non-fresh path directly
  installer.isFreshInstall = false;
  // @ts-ignore - skip core file upload in this unit test
  installer.remoteFilesNeedUpdating = false;
  // @ts-ignore - avoid background polling in this unit test
  installer.installerCheck.start = vi.fn();
  // @ts-ignore - avoid background polling in this unit test
  installer.installerCheck.activateServer = vi.fn();
  // @ts-ignore - avoid background polling in this unit test
  installer.installerCheck.noThrowWaitForInstallToComplete = vi.fn().mockResolvedValue(undefined);
  vi.mocked(getTransactionTracker).mockReturnValue(transactionTracker as any);

  await installer.run(false);

  expect(proxySetupSpy).toHaveBeenCalledOnce();
  expect(transactionTracker.load).toHaveBeenCalledOnce();
  expect(uploadBotConfigFiles).toHaveBeenCalledOnce();
});
