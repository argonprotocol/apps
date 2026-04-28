import {
  ArgonClient,
  BiddingCalculator,
  BiddingCalculatorData,
  type IBiddingRules,
  MainchainClients,
  Mining,
  MiningFrames,
} from '@argonprotocol/apps-core';
import { ApiDecoration } from '@argonprotocol/mainchain';
import { INSTANCE_NAME, IS_OPERATIONS_APP, IS_TREASURY_APP, LOG_DEBUG, NETWORK_NAME, NETWORK_URL } from '../lib/Env.ts';
import { getConfig } from './config';
import { botEmitter } from '../lib/Bot.ts';
import { BotStatus } from '../lib/BotSyncer.ts';
import { getBot } from './bot.ts';
import { VaultCalculator } from '../lib/VaultCalculator.ts';
import { Config } from '../lib/Config.ts';
import { BaseDirectory, readTextFile, writeTextFile } from '@tauri-apps/plugin-fs';
import { BlockWatch } from '@argonprotocol/apps-core/src/BlockWatch.ts';
import { getServerApiClient } from './server.ts';
import { getUpstreamOperatorClient } from './upstreamOperator.ts';

let mainchainClients: MainchainClients;
let mining: Mining;
let miningFrames: MiningFrames;
let blockWatch: BlockWatch;
let biddingCalculator: BiddingCalculator;
let biddingCalculatorData: BiddingCalculatorData;
let vaultCalculator: VaultCalculator;
let refreshPrunedClientPromise: Promise<void> | undefined;
let shouldRefreshPrunedClient = false;

export async function getMainchainClientAt(
  height: number,
  isPriorToFinalizedHeight: boolean = true,
): Promise<ApiDecoration<'promise'>> {
  const client = await getMainchainClients().get(isPriorToFinalizedHeight);
  const blockHash = await client.rpc.chain.getBlockHash(height);
  return client.at(blockHash);
}
export function getMainchainClient(needsHistoricalAccess: boolean): Promise<ArgonClient> {
  return getMainchainClients().get(needsHistoricalAccess);
}

export async function getFinalizedClient(): Promise<ApiDecoration<'promise'>> {
  const client = await getMainchainClient(false);
  const finalized = await client.rpc.chain.getFinalizedHead();
  return client.at(finalized);
}

export function setArchiveClientUrl(url: string) {
  const clients = getMainchainClients();
  return clients.setArchiveClient(url);
}

export function refreshPrunedClientFromConfig() {
  if (!mainchainClients) {
    return;
  }

  shouldRefreshPrunedClient = true;
  if (refreshPrunedClientPromise) {
    return;
  }

  refreshPrunedClientPromise = (async () => {
    try {
      while (shouldRefreshPrunedClient) {
        shouldRefreshPrunedClient = false;
        await connectPrunedClientToConfiguredServer();
      }
    } catch (error) {
      console.warn('[PRUNED_RPC] Unable to connect through the configured server', error);
    } finally {
      refreshPrunedClientPromise = undefined;

      if (shouldRefreshPrunedClient) {
        refreshPrunedClientFromConfig();
      }
    }
  })();
}

export function setMainchainClients(clients: MainchainClients) {
  mainchainClients = clients;
  return mainchainClients;
}

export function getMainchainClients(): MainchainClients {
  if (!mainchainClients) {
    mainchainClients = new MainchainClients(NETWORK_URL, () => __LOG_DEBUG__ || LOG_DEBUG);

    const config = getConfig();
    if (config.isLoaded) {
      refreshPrunedClientFromConfig();
    } else {
      void config.isLoadedPromise.then(refreshPrunedClientFromConfig);
    }

    if (getBot().isReady) {
      refreshPrunedClientFromConfig();
    }

    botEmitter.on('status-changed', status => {
      if (status === BotStatus.Ready && !mainchainClients.prunedClientPromise) {
        refreshPrunedClientFromConfig();
      }
    });
  }

  return mainchainClients;
}

export function getBlockWatch(): BlockWatch {
  if (blockWatch) {
    return blockWatch;
  }
  const clients = getMainchainClients();
  blockWatch = new BlockWatch(clients);
  return blockWatch;
}

export function getMiningFrames(): MiningFrames {
  if (!miningFrames) {
    console.log('Initializing MiningFrames', NETWORK_NAME);
    const clients = getMainchainClients();
    let storageFile = `${NETWORK_NAME}/miningFrames.json`;
    if (NETWORK_NAME === 'dev-docker') {
      storageFile = `${NETWORK_NAME}/${INSTANCE_NAME}/miningFrames.json`;
    }
    const dir = {
      baseDir: BaseDirectory.AppConfig,
    };
    miningFrames = new MiningFrames(clients, getBlockWatch(), {
      read: () => readTextFile(storageFile, dir),
      write: data => writeTextFile(storageFile, data, dir),
    });
  }
  return miningFrames;
}

export function getMining(): Mining {
  if (!mining) {
    mining = new Mining(getMainchainClients());
  }
  return mining;
}

export function getBiddingCalculator(): BiddingCalculator {
  const config = getConfig();
  if (!biddingCalculator) {
    const defaultRules = Config.getDefault('biddingRules') as IBiddingRules;
    const initialRules = config.isLoaded ? (config.biddingRules as IBiddingRules) : defaultRules;
    biddingCalculator = new BiddingCalculator(getBiddingCalculatorData(), initialRules);
    if (!config.isLoaded) {
      void config.isLoadedPromise.then(() => {
        biddingCalculator?.updateBiddingRules(config.biddingRules as IBiddingRules);
        biddingCalculator?.calculateBidAmounts();
      });
    }
  }
  return biddingCalculator;
}

export function getBiddingCalculatorData(): BiddingCalculatorData {
  biddingCalculatorData ??= new BiddingCalculatorData(getMining(), getMiningFrames());
  return biddingCalculatorData;
}

export function getVaultCalculator(): VaultCalculator {
  if (!vaultCalculator) {
    const config = getConfig();
    if (!config.isLoaded) {
      throw new Error('Config must be loaded before VaultCalculator can be initialized');
    }
    vaultCalculator = new VaultCalculator(getMainchainClients());
    void vaultCalculator.load(config.vaultingRules);
  }
  return vaultCalculator;
}

async function connectPrunedClientToConfiguredServer(): Promise<void> {
  const config = getConfig();
  if (!config.isLoaded) {
    await config.isLoadedPromise;
  }

  const serverApiClient = getServerApiClient();
  if (config.isServerInstalled && config.serverDetails.ipAddress) {
    if (!(await serverApiClient.isGatewayReady())) {
      mainchainClients.clearPrunedClient();
      return;
    }

    try {
      await serverApiClient.ensureAdminOperatorSession({ forceVerify: true });
      await mainchainClients.setPrunedClient(serverApiClient.getGatewayWebsocketUrl('/substrate'));
    } catch (error) {
      mainchainClients.clearPrunedClient();
      throw error;
    }

    return;
  }

  const upstreamOperatorClient = getUpstreamOperatorClient();
  if (upstreamOperatorClient.operatorHost && config.upstreamOperator) {
    if (IS_TREASURY_APP) {
      await upstreamOperatorClient.ensureTreasurySession({ forceVerify: true });
    } else if (IS_OPERATIONS_APP) {
      await upstreamOperatorClient.ensureOperationalSession({
        forceVerify: true,
      });
    }

    await mainchainClients.setPrunedClient(upstreamOperatorClient.getWebsocketUrl('/substrate'));
    return;
  }

  mainchainClients.clearPrunedClient();
}
