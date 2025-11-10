import './helpers/mocks.ts';
import { beforeEach, expect, it, vi } from 'vitest';
import * as Vue from 'vue';
import { Config } from '../lib/Config';
import Installer, { resetInstaller } from '../lib/Installer';
import { createMockedDbPromise } from './helpers/db';
import { IInstallStepStatuses, InstallStepStatusType } from '../lib/Server';
import { InstallStepKey, ServerType } from '../interfaces/IConfig';
import { InstallerCheck } from '../lib/InstallerCheck.ts';
import { MiningMachine } from '../lib/MiningMachine.ts';
import { WalletKeys } from '../lib/WalletKeys.ts';

beforeEach(() => {
  resetInstaller();
  WalletKeys.prototype.didWalletHavePreviousLife = vi.fn().mockResolvedValue(false);
});

it('should skip install if server is not connected', async () => {
  const dbPromise = createMockedDbPromise({ isMinerReadyToInstall: 'false' });

  const walletKeys = new WalletKeys({ sshPublicKey: '', masterMnemonic: '//Alice' });
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
  const dbPromise = createMockedDbPromise({ isMinerReadyToInstall: 'true' });
  const walletKeys = new WalletKeys({ sshPublicKey: '', masterMnemonic: '//Alice' });
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
  const walletKeys = new WalletKeys({ sshPublicKey: '', masterMnemonic: '//Alice' });
  const config = new Config(dbPromise, walletKeys);
  await config.load();

  const installer = new Installer(config, walletKeys);
  await installer.load();

  config.isMinerReadyToInstall = true;
  config.isMinerInstalled = false;
  config.isMinerUpToDate = false;
  config.serverDetails = {
    ...config.serverDetails,
    ipAddress: '127.0.0.1',
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

it('should run through entire install process', async () => {
  const dbPromise = createMockedDbPromise({ isMinerReadyToInstall: 'true', serverCreation: '{ "localComputer": {} }' });
  const walletKeys = new WalletKeys({ sshPublicKey: '', masterMnemonic: '//Alice' });
  const config = Vue.reactive(new Config(dbPromise, walletKeys)) as Config;
  await config.load();

  MiningMachine.setupLocalComputer = vi.fn().mockResolvedValue({
    type: ServerType.LocalComputer,
    ipAddress: `127.0.0.1`,
    port: 25,
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

  // should call run
  await installer.load();

  expect(config.installDetails.ServerConnect.status).toBe('Completed');
});
