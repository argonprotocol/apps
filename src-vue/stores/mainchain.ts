import {
  ArgonClient,
  BiddingCalculator,
  BiddingCalculatorData,
  type IBiddingRules,
  MainchainClients,
  Mining,
  PriceIndex,
} from '@argonprotocol/apps-core';
import { ApiDecoration } from '@argonprotocol/mainchain';
import { NETWORK_URL, SERVER_ENV_VARS } from '../lib/Env.ts';
import { useConfig } from './config';
import { botEmitter } from '../lib/Bot.ts';
import { BotStatus } from '../lib/BotSyncer.ts';
import { useBot } from './bot.ts';
import { VaultCalculator } from '../lib/VaultCalculator.ts';
import { SSH } from '../lib/SSH.ts';

let mainchainClients: MainchainClients;
let mining: Mining;
let priceIndex: PriceIndex;
let biddingCalculator: BiddingCalculator;
let biddingCalculatorData: BiddingCalculatorData;
let vaultCalculator: VaultCalculator;

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

export function setArchiveClientUrl(url: string) {
  const clients = getMainchainClients();
  return clients.setArchiveClient(url);
}

function setPrunedClientToLocal() {
  if (!mainchainClients) {
    return;
  }

  void SSH.getIpAddress().then(ip => mainchainClients.setPrunedClient(`ws://${ip}:${SERVER_ENV_VARS.ARGON_RPC_PORT}`));
}

export function setMainchainClients(clients: MainchainClients) {
  mainchainClients = clients;
  return mainchainClients;
}

export function getMainchainClients(): MainchainClients {
  if (!mainchainClients) {
    mainchainClients = new MainchainClients(NETWORK_URL);

    const bot = useBot();
    if (bot.isReady) {
      setPrunedClientToLocal();
    }

    botEmitter.on('status-changed', status => {
      if (status === BotStatus.Ready && !mainchainClients.prunedClientPromise) {
        setPrunedClientToLocal();
      }
    });
  }

  return mainchainClients;
}

export function getMining(): Mining {
  if (!mining) {
    mining = new Mining(getMainchainClients());
  }
  return mining;
}

export function getPriceIndex(): PriceIndex {
  if (!priceIndex) {
    priceIndex = new PriceIndex(getMainchainClients());
  }
  return priceIndex;
}

export function getBiddingCalculator(): BiddingCalculator {
  if (!biddingCalculator) {
    const config = useConfig();
    if (!config.isLoaded) {
      throw new Error('Config must be loaded before BiddingCalculator can be initialized');
    }
    biddingCalculator = new BiddingCalculator(getBiddingCalculatorData(), config.biddingRules as IBiddingRules);
  }
  return biddingCalculator;
}

export function getBiddingCalculatorData(): BiddingCalculatorData {
  biddingCalculatorData ??= new BiddingCalculatorData(getMining());
  return biddingCalculatorData;
}

export function getVaultCalculator(): VaultCalculator {
  if (!vaultCalculator) {
    const config = useConfig();
    if (!config.isLoaded) {
      throw new Error('Config must be loaded before VaultCalculator can be initialized');
    }
    vaultCalculator = new VaultCalculator(getMainchainClients());
    void vaultCalculator.load(config.vaultingRules);
  }
  return vaultCalculator;
}
