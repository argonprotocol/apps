import './helpers/mocks.ts';
import { beforeEach, expect, it, vi } from 'vitest';
import * as Vue from 'vue';
import { TxSubmitter } from '@argonprotocol/mainchain';
import { Config } from '../lib/Config';
import Installer, { resetInstaller } from '../lib/Installer';
import { createMockedDbPromise } from './helpers/db';
import { IInstallStepStatuses, InstallStepStatusType } from '../lib/ServerAdmin';
import { InstallStepKey, MiningSetupStatus, ServerType } from '../interfaces/IConfig';
import { InstallerCheck } from '../lib/InstallerCheck.ts';
import * as MiningAccount from '../lib/MiningAccount.ts';
import { MiningMachine } from '../lib/MiningMachine.ts';
import { WalletKeys } from '../lib/WalletKeys.ts';
import { getMainchainClient } from '../stores/mainchain.ts';
import { createMockWalletKeys, createTestWallet } from './helpers/wallet.ts';

vi.mock('../stores/mainchain.ts', () => ({
  getMainchainClient: vi.fn(),
}));

beforeEach(() => {
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

it('sets up the mining bid proxy during non-fresh installs before uploading bot config files', async () => {
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
  const proxyKeypair = await walletKeys.getMiningBidProxyKeypair();
  const fundingAccount = await walletKeys.getMiningBotKeypair();
  const proxySetupSpy = vi.spyOn(MiningAccount, 'planMiningBidProxySetup').mockResolvedValue({
    fundingAccount,
    proxySetup: {
      kind: 'tx',
      tx: 'proxy-setup-tx' as any,
      metadata: {
        fundingAccountId: walletKeys.miningBotAddress,
        proxyAccountId: proxyKeypair.address,
      },
    },
  });
  const submitSpy = vi.spyOn(TxSubmitter.prototype, 'submit').mockResolvedValue({
    waitForInFirstBlock: Promise.resolve(undefined),
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
  vi.mocked(getMainchainClient).mockResolvedValue({} as any);

  await installer.run(false);

  expect(proxySetupSpy).toHaveBeenCalledOnce();
  expect(submitSpy).toHaveBeenCalledWith({ useLatestNonce: true });
  expect(uploadBotConfigFiles).toHaveBeenCalledOnce();
  expect(submitSpy.mock.invocationCallOrder[0]).toBeLessThan(uploadBotConfigFiles.mock.invocationCallOrder[0]);
});
