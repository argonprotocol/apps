import { decryptBootstrapRecovery } from '@argonprotocol/apps-core';
import { hexToU8a } from '@argonprotocol/mainchain';
import { BootstrapRecovery, BootstrapRecoveryContext } from '../lib/BootstrapRecovery.ts';
import { BootstrapType, ServerType } from '../interfaces/IConfig.ts';
import { UpstreamOperatorClient } from '../lib/UpstreamOperatorClient.ts';
import { getConfig } from './config.ts';
import { getMainchainClient, refreshPrunedClientFromConfig } from './mainchain.ts';
import { getTransactionTracker } from './transactions.ts';
import { getWalletKeys, getWalletsForArgon } from './wallets.ts';
import { SSHConnection } from '../lib/SSHConnection.ts';
import { ServerAdmin, type ServerInstallManifest } from '../lib/ServerAdmin.ts';

let upstreamEnrollmentPromise: Promise<void> | undefined;
let stopWatchingUpstreamRecoveryFunds: VoidFunction | undefined;
let stopWatchingOwnServerFunds: VoidFunction | undefined;
let serverRecoveryPublicationPromise: Promise<void> | undefined;
let serverPublicationPromise: Promise<void> | undefined;

export async function recoverUpstreamHost(): Promise<string | undefined> {
  const config = getConfig();
  const upstreamOperator = config.upstreamOperator;

  const walletKeys = getWalletKeys();
  const client = await getMainchainClient(true);
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
  refreshPrunedClientFromConfig();

  return recoveredHost;
}

export function enrollUpstreamRecovery(): Promise<void> {
  upstreamEnrollmentPromise ??= (async () => {
    const config = getConfig();
    const encryptedBootstrapRecovery = config.upstreamOperator?.encryptedBootstrapRecovery;
    if (!encryptedBootstrapRecovery) {
      stopWatchingUpstreamRecoveryFunds?.();
      stopWatchingUpstreamRecoveryFunds = undefined;
      return;
    }

    const wallets = getWalletsForArgon();
    stopWatchingUpstreamRecoveryFunds ??= wallets.events.on('balance-change', (balance, type) => {
      if (type !== 'defaultArgon' || balance.availableMicrogons <= 0n) return;

      void enrollUpstreamRecovery().catch(error => {
        console.warn('Unable to enroll upstream endpoint recovery', error);
      });
    });
    if (wallets.defaultArgonWallet.availableMicrogons <= 0n) return;

    const walletKeys = getWalletKeys();
    const client = await getMainchainClient(false);
    await new BootstrapRecovery(walletKeys).publishRecovery({
      client,
      transactionTracker: getTransactionTracker(),
      context: BootstrapRecoveryContext.Upstream,
      encryptedRecovery: hexToU8a(encryptedBootstrapRecovery),
    });
    stopWatchingUpstreamRecoveryFunds?.();
    stopWatchingUpstreamRecoveryFunds = undefined;
  })().finally(() => {
    upstreamEnrollmentPromise = undefined;
  });

  return upstreamEnrollmentPromise;
}

export function publishOwnServerEndpoint(): Promise<void> {
  if (serverPublicationPromise) return serverPublicationPromise;

  const config = getConfig();
  const host = config.serverDetails.ipAddress;
  if (!config.isServerInstalled || !host) return Promise.resolve();

  const wallets = getWalletsForArgon();
  if (wallets.defaultArgonWallet.availableMicrogons <= 0n) {
    watchOwnServerFunds(wallets);
    return Promise.resolve();
  }

  serverPublicationPromise = (async () => {
    const walletKeys = getWalletKeys();
    const client = await getMainchainClient(false);
    const recovery = new BootstrapRecovery(walletKeys);
    const bootstrapEndpointIndex = config.serverDetails.bootstrapEndpointIndex ?? 0;
    const bootstrapEndpointSecret = await walletKeys.getOwnServerBootstrapEndpointSecret(bootstrapEndpointIndex);
    const endpoint = await recovery.publishEndpoint({
      client,
      transactionTracker: getTransactionTracker(),
      host,
      port: config.serverDetails.gatewayPort ?? 443,
      bootstrapEndpointSecret,
    });
    if (!endpoint) return;

    config.serverDetails = {
      ...config.serverDetails,
      bootstrapEndpointIndex,
      bootstrapEndpointSequence: endpoint.sequence,
    };
    await config.save();
  })().finally(() => {
    serverPublicationPromise = undefined;
  });

  return serverPublicationPromise;
}

export function publishOwnServerRecovery(): Promise<void> {
  if (serverRecoveryPublicationPromise) return serverRecoveryPublicationPromise;

  const config = getConfig();
  const { ipAddress, sshPort, sshUser } = config.serverDetails;
  if (!ipAddress || !sshUser) return Promise.resolve();

  const wallets = getWalletsForArgon();
  if (wallets.defaultArgonWallet.availableMicrogons <= 0n) {
    watchOwnServerFunds(wallets);
    return Promise.resolve();
  }

  serverRecoveryPublicationPromise = (async () => {
    const bootstrapEndpointIndex = config.serverDetails.bootstrapEndpointIndex ?? 0;
    const walletKeys = getWalletKeys();
    const client = await getMainchainClient(false);
    await new BootstrapRecovery(walletKeys).publishRecovery({
      client,
      transactionTracker: getTransactionTracker(),
      context: BootstrapRecoveryContext.OwnServer,
      bootstrapEndpointSecret: await walletKeys.getOwnServerBootstrapEndpointSecret(bootstrapEndpointIndex),
      bootstrapEndpointIndex,
      ssh: {
        user: sshUser,
        port: sshPort ?? 22,
      },
    });

    if (config.serverDetails.bootstrapEndpointIndex !== bootstrapEndpointIndex) {
      config.serverDetails = {
        ...config.serverDetails,
        bootstrapEndpointIndex,
      };
      await config.save();
    }
  })().finally(() => {
    serverRecoveryPublicationPromise = undefined;
  });

  return serverRecoveryPublicationPromise;
}

export async function recoverOwnServer(): Promise<void> {
  const config = getConfig();
  if (config.serverDetails.ipAddress || !config.walletAccountsHadPreviousLife) return;

  const walletKeys = getWalletKeys();
  const client = await getMainchainClient(true);
  const endpoint = await new BootstrapRecovery(walletKeys).recoverEndpoint(client, BootstrapRecoveryContext.OwnServer);
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
  const connection = new SSHConnection(recoveredServerDetails);

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

function watchOwnServerFunds(wallets: ReturnType<typeof getWalletsForArgon>): void {
  stopWatchingOwnServerFunds ??= wallets.events.on('balance-change', (balance, type) => {
    if (type !== 'defaultArgon' || balance.availableMicrogons <= 0n) return;

    stopWatchingOwnServerFunds?.();
    stopWatchingOwnServerFunds = undefined;
    void Promise.all([publishOwnServerRecovery(), publishOwnServerEndpoint()]).catch(error => {
      watchOwnServerFunds(wallets);
      console.warn('[BootstrapRecovery] Unable to publish the configured server bootstrap records', error);
    });
  });
}
