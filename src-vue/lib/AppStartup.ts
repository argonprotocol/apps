import { BootstrapRecovery, BootstrapRecoveryContext } from './BootstrapRecovery.ts';
import { decryptBootstrapRecovery } from '@argonprotocol/apps-core';
import { hexToU8a, u8aToHex } from '@argonprotocol/mainchain';
import { UpstreamOperatorClient } from './UpstreamOperatorClient.ts';
import { SSHConnection } from './SSHConnection.ts';
import { ServerAdmin, type ServerInstallManifest } from './ServerAdmin.ts';
import { createDeferred, type MainchainClients } from '@argonprotocol/apps-core';
import { Config } from './Config.ts';
import { LocalMachine } from './LocalMachine.ts';
import type { WalletKeys } from './WalletKeys.ts';
import type { WalletRecovery } from './WalletRecovery.ts';
import { walletKeyPaths } from './WalletKeyPaths.ts';
import { BootstrapType, MiningSetupStatus, ServerType, VaultingSetupStatus } from '../interfaces/IConfig.ts';
import { IS_STABLE_BUILD, IS_TEST } from './Env.ts';
import { invokeWithTimeout } from './tauriApi.ts';
import { getUserJurisdiction } from './Countries.ts';
import { readArgonWalletBalanceValues, type WalletsForArgon } from './WalletsForArgon.ts';
import type { TransactionTracker } from './TransactionTracker.ts';
import { hasArgonWalletValue } from './WalletForArgon.ts';

export class AppStartup {
  public isReady = false;
  public isRecoveringHistory = false;
  public historyLoadPct = 100;

  private readonly ready = createDeferred<void>(false);
  private initialization?: Promise<void>;
  private upstreamEnrollment?: Promise<void>;
  private stopWatchingUpstreamFunds?: VoidFunction;

  constructor(
    private readonly config: Config,
    private readonly walletKeys: WalletKeys,
    private readonly clients: MainchainClients,
  ) {}

  public get isReadyPromise(): Promise<void> {
    return this.ready.promise;
  }

  public initialize(): Promise<void> {
    this.initialization ??= this.initializeConfiguration();
    return this.initialization;
  }

  public get needsWalletHistoryRecovery(): boolean {
    return this.config.walletAccountsHadPreviousLife && !this.config.walletPreviousLifeRecovered;
  }

  public async recoverOwnServerConnection(): Promise<void> {
    if (
      !this.walletKeys.canAccessServer ||
      this.config.serverDetails.ipAddress ||
      !this.config.walletAccountsHadPreviousLife
    )
      return;
    try {
      await this.restoreOwnServer();
    } catch (error) {
      console.warn('Unable to recover the imported account server endpoint', error);
    }
  }

  public enrollUpstreamRecovery(wallets: WalletsForArgon, tracker: TransactionTracker): Promise<void> {
    const encryptedRecovery = this.config.upstreamOperator?.encryptedBootstrapRecovery;
    if (!encryptedRecovery) return Promise.resolve();
    if (this.upstreamEnrollment) return this.upstreamEnrollment;
    this.stopWatchingUpstreamFunds ??= wallets.events.on('balance-change', (balance, type) => {
      if (type !== 'argon' || balance.availableMicrogons <= 0n) return;
      void this.enrollUpstreamRecovery(wallets, tracker).catch(error =>
        console.warn('Unable to enroll upstream endpoint recovery', error),
      );
    });
    this.upstreamEnrollment = (async () => {
      let connectionTimeout: ReturnType<typeof setTimeout> | undefined;
      try {
        // Do not hold startup readiness while the network is offline.
        const client = await Promise.race([
          this.clients.get(false),
          new Promise<undefined>(resolve => {
            connectionTimeout = setTimeout(() => resolve(undefined), 5e3);
          }),
        ]);
        if (!client) return;
        const account = await client.query.system.account(this.walletKeys.defaultArgonAddress);
        if (account.data.free <= 0n) return;
        await new BootstrapRecovery(this.walletKeys).publishRecovery({
          client,
          transactionTracker: tracker,
          context: BootstrapRecoveryContext.Upstream,
          encryptedRecovery: hexToU8a(encryptedRecovery),
        });
        this.stopWatchingUpstreamFunds?.();
        this.stopWatchingUpstreamFunds = undefined;
      } finally {
        clearTimeout(connectionTimeout);
      }
    })().finally(() => {
      this.upstreamEnrollment = undefined;
    });
    return this.upstreamEnrollment;
  }

  public async recoverPreviousWalletHistory(recovery: WalletRecovery): Promise<void> {
    const config = this.config;
    if (!this.needsWalletHistoryRecovery) return;

    this.isRecoveringHistory = true;
    this.historyLoadPct = 0;
    try {
      if (this.walletKeys.canSign) {
        await this.recoverUpstreamHost().catch(error =>
          console.warn('Unable to recover the imported account upstream endpoint', error),
        );
      }
      const { miningHistory, vault } = await recovery.findHistory(pct => {
        this.historyLoadPct = Math.max(this.historyLoadPct, pct * 0.95);
      });

      const hasPreviousOperations = !!miningHistory?.length || !!vault;
      if (hasPreviousOperations && miningHistory) {
        const oldestFrameId = miningHistory.length ? Math.min(...miningHistory.map(x => x.frameId)) : 0;
        if (miningHistory.length === 1 && !miningHistory[0].seats.length) {
          config.oldestFrameIdToSync = oldestFrameId;
          config.hasMiningBids = true;
        } else if (miningHistory.length) {
          // A seat in the oldest recovered frame was bid for in the preceding frame.
          config.oldestFrameIdToSync = oldestFrameId - 1;
          config.hasMiningBids = true;
          config.hasMiningSeats = true;
        }
        config.miningBotAccountPreviousHistory = miningHistory;
        if (config.miningSetupStatus === MiningSetupStatus.None) {
          config.miningSetupStatus = MiningSetupStatus.Checklist;
        }
        if (config.serverDetails.ipAddress) {
          config.miningSetupStatus = MiningSetupStatus.Finished;
          config.miningBotAccountPreviousHistory = null;
        }
      }

      if (hasPreviousOperations && config.serverDetails.ipAddress) {
        config.isServerInstalled = true;
        config.isServerInstalling = false;
        config.setCertificationDetails({ showBonusTooltip: false });
      }
      if (vault) config.vaultingSetupStatus = VaultingSetupStatus.Finished;

      config.walletPreviousLifeRecovered = true;
      try {
        await config.save();
      } catch (error) {
        config.walletPreviousLifeRecovered = false;
        throw error;
      }
      this.historyLoadPct = 100;
    } finally {
      this.isRecoveringHistory = false;
    }
  }

  public async recordLaunch(): Promise<void> {
    if (this.config.showWelcomeOverlay) return;
    this.config.postWelcomeLaunchCount += 1;
    await this.config.save();
  }

  public async recoverUpstreamHost(): Promise<string | undefined> {
    const config = this.config;
    const upstreamOperator = config.upstreamOperator;

    const walletKeys = this.walletKeys;
    const client = await this.clients.get(true);
    const recovery = new BootstrapRecovery(walletKeys);
    const encryptedBootstrapRecovery = upstreamOperator?.encryptedBootstrapRecovery;
    let endpoint;
    if (encryptedBootstrapRecovery) {
      const recoverySeed = await walletKeys.getUpstreamEndpointRecoverySeed();
      const recoveryPayload = await decryptBootstrapRecovery(hexToU8a(encryptedBootstrapRecovery), recoverySeed);
      endpoint = await recovery.resolveEndpoint(
        client,
        recoveryPayload.endpointSecret,
        upstreamOperator.bootstrapEndpointSequence,
      );
    } else {
      endpoint = await recovery.recoverEndpoint(
        client,
        BootstrapRecoveryContext.Upstream,
        upstreamOperator?.bootstrapEndpointSequence,
      );
    }
    if (!endpoint) return;

    const bootstrapDetails = UpstreamOperatorClient.getBootstrapDetails(
      `${endpoint.host}:${endpoint.port}`,
      BootstrapType.Private,
    );
    const recoveredHost = UpstreamOperatorClient.getBootstrapHost(bootstrapDetails);
    if (recoveredHost === UpstreamOperatorClient.getBootstrapHost(config.bootstrapDetails)) {
      return recoveredHost;
    }

    config.bootstrapDetails = bootstrapDetails;
    await config.save();

    return recoveredHost;
  }

  private async restoreOwnServer(): Promise<void> {
    const config = this.config;
    if (config.serverDetails.ipAddress || !config.walletAccountsHadPreviousLife) return;

    const walletKeys = this.walletKeys;
    const client = await this.clients.get(true);
    const endpoint = await new BootstrapRecovery(walletKeys).recoverEndpoint(
      client,
      BootstrapRecoveryContext.OwnServer,
      0,
    );
    if (!endpoint) return;

    const recoveredServerDetails = {
      ...config.serverDetails,
      ipAddress: endpoint.host,
      gatewayPort: endpoint.port,
      bootstrapEndpointIndex: endpoint.bootstrapEndpointIndex,
      bootstrapEndpointSequence: endpoint.sequence,
      sshUser: endpoint.ssh?.user ?? config.serverDetails.sshUser,
      sshPort: endpoint.ssh?.port ?? config.serverDetails.sshPort,
    };
    const connection = new SSHConnection(recoveredServerDetails, walletKeys);

    let installManifest: ServerInstallManifest | undefined;
    try {
      await connection.connect();
      installManifest = await new ServerAdmin(connection, recoveredServerDetails).downloadInstallManifest();
    } catch (error) {
      console.warn('[BootstrapRecovery] Unable to inspect the recovered server install manifest', error);
    } finally {
      if (connection.isConnected) {
        await connection.close(true).catch(error => {
          console.warn('[BootstrapRecovery] Unable to close the recovered server connection', error);
        });
      }
    }

    config.serverDetails = {
      ...recoveredServerDetails,
      type: installManifest?.type ?? ServerType.DigitalOcean,
      workDir: installManifest?.workDir ?? '~',
    };
    config.hasExtensionTreasury = true;
    config.hasExtensionOperations = true;
    config.isServerInstalled = true;
    await config.save();
  }

  private async initializeConfiguration(): Promise<void> {
    const config = this.config;
    try {
      const walletKeys = this.walletKeys;
      await config.load();

      if (!config.userJurisdiction.countryCode) {
        try {
          config.userJurisdiction = await getUserJurisdiction();
        } catch (error) {
          console.error('Error getting user jurisdiction:', error);
        }
      }

      if (!config.hasStoredField('walletAccountsHadPreviousLife')) {
        const client = await this.clients.get(false);
        const balances = await readArgonWalletBalanceValues(client, [
          walletKeys.defaultArgonAddress,
          walletKeys.miningBotAddress,
          walletKeys.operationalAddress,
        ]);
        let hasPreviousActivity = balances.some(hasArgonWalletValue);
        if (!hasPreviousActivity) {
          hasPreviousActivity = !!(await client.query.operationalAccounts.operationalAccounts(
            walletKeys.operationalAddress,
          ));
        }
        config.walletAccountsHadPreviousLife = hasPreviousActivity;
        if (config.walletAccountsHadPreviousLife) config.showWelcomeOverlay = false;
      }

      const hasExistingOperations =
        config.isServerInstalled ||
        config.miningSetupStatus !== MiningSetupStatus.None ||
        config.vaultingSetupStatus !== VaultingSetupStatus.None;
      if (config.upstreamOperator) config.hasExtensionTreasury = true;
      if ((config.bootstrapDetails || hasExistingOperations) && !config.wasImportedFromLegacy) {
        config.showWelcomeOverlay = false;
      }
      if (
        config.miningSetupStatus === MiningSetupStatus.Finished ||
        config.vaultingSetupStatus === VaultingSetupStatus.Finished
      ) {
        config.hasExtensionTreasury = true;
        config.hasExtensionOperations = true;
      }

      if (
        walletKeys.canAccessServer &&
        config.serverDetails.type === ServerType.LocalComputer &&
        config.serverAdd?.localComputer
      ) {
        const localMachine = await LocalMachine.activate();
        if (localMachine) {
          if (!IS_TEST && IS_STABLE_BUILD) {
            await invokeWithTimeout('toggle_nosleep', { enable: true }, 5000);
          }
          config.serverDetails = { ...config.serverDetails, ipAddress: '127.0.0.1', sshPort: localMachine.sshPort };
        } else if (!config.isServerInstalling) {
          config.resetField('serverDetails');
          config.isServerInstalled = false;
        }
      }

      await config.save();
      this.isReady = true;
      this.ready.resolve();
    } catch (error) {
      this.ready.reject(error);
      throw error;
    }
  }
}
