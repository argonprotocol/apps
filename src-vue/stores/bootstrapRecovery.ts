import { decryptBootstrapRecovery } from '@argonprotocol/apps-core';
import { hexToU8a } from '@argonprotocol/mainchain';
import { BootstrapRecovery, BootstrapRecoveryContext } from '../lib/BootstrapRecovery.ts';
import { BootstrapType } from '../interfaces/IConfig.ts';
import { UpstreamOperatorClient } from '../lib/UpstreamOperatorClient.ts';
import { getConfig } from './config.ts';
import { getMainchainClient, refreshPrunedClientFromConfig } from './mainchain.ts';
import { getTransactionTracker } from './transactions.ts';
import { getWalletKeys, getWalletsForArgon } from './wallets.ts';

let upstreamEnrollmentPromise: Promise<void> | undefined;
let stopWatchingUpstreamRecoveryFunds: VoidFunction | undefined;
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
      upstreamOperator.accountId,
      upstreamOperator.bootstrapEndpointSequence,
    );
  } else {
    endpoint = await recovery.recoverEndpoint(
      client,
      BootstrapRecoveryContext.Upstream,
      upstreamOperator?.accountId,
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
  serverPublicationPromise ??= (async () => {
    const config = getConfig();
    const host = config.serverDetails.ipAddress;
    if (!config.isServerInstalled || !host) return;

    const walletKeys = getWalletKeys();
    const client = await getMainchainClient(false);
    const recovery = new BootstrapRecovery(walletKeys);
    const endpoint = await recovery.publishServerEndpoint({
      client,
      transactionTracker: getTransactionTracker(),
      host,
      port: config.serverDetails.gatewayPort ?? 443,
      bootstrapEndpointIndex: config.serverDetails.bootstrapEndpointIndex,
      ssh: {
        user: config.serverDetails.sshUser,
        port: config.serverDetails.sshPort ?? 22,
      },
    });
    if (!endpoint) return;

    config.serverDetails = {
      ...config.serverDetails,
      bootstrapEndpointIndex: config.serverDetails.bootstrapEndpointIndex ?? 0,
      bootstrapEndpointSequence: endpoint.sequence,
    };
    await config.save();
  })().finally(() => {
    serverPublicationPromise = undefined;
  });

  return serverPublicationPromise;
}

export async function recoverOwnServer(): Promise<void> {
  const config = getConfig();
  if (config.serverDetails.ipAddress || !config.walletAccountsHadPreviousLife) return;

  const walletKeys = getWalletKeys();
  const client = await getMainchainClient(true);
  const endpoint = await new BootstrapRecovery(walletKeys).recoverEndpoint(
    client,
    BootstrapRecoveryContext.OwnServer,
    walletKeys.operationalAddress,
  );
  if (!endpoint) return;

  config.serverDetails = {
    ...config.serverDetails,
    ipAddress: endpoint.host,
    gatewayPort: endpoint.port,
    bootstrapEndpointIndex: endpoint.bootstrapEndpointIndex,
    bootstrapEndpointSequence: endpoint.sequence,
    sshUser: endpoint.ssh?.user ?? config.serverDetails.sshUser,
    sshPort: endpoint.ssh?.port ?? config.serverDetails.sshPort,
  };
  config.isServerInstalled = true;
  await config.save();
}
