import './helpers/mocks.ts';
import { beforeEach, expect, it, vi } from 'vitest';
import * as Vue from 'vue';
import { Config } from '../lib/Config';
import Installer, { resetInstaller } from '../lib/Installer';
import { createMockedDbPromise } from './helpers/db';
import { IInstallStepStatuses, InstallStepStatusType } from '../lib/ServerAdmin';
import { InstallStepKey, MiningSetupStatus, ServerType } from '../interfaces/IConfig';
import { InstallerCheck } from '../lib/InstallerCheck.ts';
import * as MiningAccount from '../lib/MiningAccount.ts';
import { MiningMachine } from '../lib/MiningMachine.ts';
import { WalletKeys } from '../lib/WalletKeys.ts';
import { getTransactionTracker } from '../stores/transactions.ts';
import { createMockWalletKeys, createTestWallet } from './helpers/wallet.ts';
import { TICK_MILLIS } from '../lib/Env.ts';

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

it('should install if all conditions are met', async () => {
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

  installer.isRunning = false;

  // @ts-expect-error - test private method
  const didRun = await installer.calculateIsReadyToRun();

  expect(didRun).toBe(true);
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
