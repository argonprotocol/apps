import { getAppStartup } from './startup.ts';
import { BootstrapRecovery } from '../lib/BootstrapRecovery.ts';
import { getConfig, type Config } from './config.ts';
import { getMainchainClient, refreshPrunedClientFromConfig } from './mainchain.ts';
import { getTransactionTracker } from './transactions.ts';
import { getWalletKeys, getWalletsForArgon } from './wallets.ts';

let serverPublicationPromise: Promise<void> | undefined;
let endpointPublicationPromise: Promise<void> | undefined;
let stopWatchingOwnServerFunds: VoidFunction | undefined;

export async function recoverUpstreamHost(): Promise<string | undefined> {
  const config = getConfig();
  const previousBootstrap = config.bootstrapDetails;
  const host = await getAppStartup().recoverUpstreamHost();
  if (config.bootstrapDetails !== previousBootstrap) refreshPrunedClientFromConfig();
  return host;
}

export function enrollUpstreamRecovery(): Promise<void> {
  return getAppStartup().enrollUpstreamRecovery(getWalletsForArgon(), getTransactionTracker());
}

export function publishOwnServer(): Promise<void> {
  if (serverPublicationPromise) return serverPublicationPromise;

  const config = getConfig();
  if (!config.isServerInstalled || !config.serverDetails.ipAddress) return Promise.resolve();

  serverPublicationPromise = getMainchainClient(false)
    .then(async client => {
      const walletKeys = getWalletKeys();
      const account = await client.query.system.account(walletKeys.defaultArgonAddress);
      if (account.data.free <= 0n) {
        watchOwnServerFunds();
        return;
      }

      const publications = await Promise.allSettled([
        new BootstrapRecovery(walletKeys).publishOwnServerRecovery({
          config: config as Config,
          client,
          transactionTracker: getTransactionTracker(),
        }),
        publishOwnServerEndpoint(),
      ]);
      const failure = publications.find(publication => publication.status === 'rejected');
      if (failure?.status === 'rejected') throw failure.reason;
      stopWatchingOwnServerFunds?.();
      stopWatchingOwnServerFunds = undefined;
    })
    .finally(() => {
      serverPublicationPromise = undefined;
    });

  return serverPublicationPromise;
}

export function publishOwnServerEndpoint(): Promise<void> {
  if (endpointPublicationPromise) return endpointPublicationPromise;
  const config = getConfig();
  if (!config.isServerInstalled || !config.serverDetails.ipAddress) return Promise.resolve();

  endpointPublicationPromise = getMainchainClient(false)
    .then(async client => {
      const walletKeys = getWalletKeys();
      const account = await client.query.system.account(walletKeys.defaultArgonAddress);
      if (account.data.free <= 0n) {
        watchOwnServerFunds();
        return;
      }
      await new BootstrapRecovery(walletKeys).publishOwnServerEndpoint({
        config: config as Config,
        client,
        transactionTracker: getTransactionTracker(),
      });
    })
    .finally(() => {
      endpointPublicationPromise = undefined;
    });
  return endpointPublicationPromise;
}

function watchOwnServerFunds(): void {
  stopWatchingOwnServerFunds ??= getWalletsForArgon().events.on('balance-change', (balance, type) => {
    if (type !== 'argon' || balance.availableMicrogons <= 0n) return;
    void publishOwnServer().catch(error => console.warn('Unable to publish server recovery details', error));
  });
}
