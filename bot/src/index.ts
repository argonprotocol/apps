import 'source-map-support/register';
import { getClient, Keyring, type KeyringPair, waitForLoad } from '@argonprotocol/mainchain';
import { onExit, requireAll, requireEnv } from './utils.ts';
import Bot from './Bot.ts';
import { NetworkConfig, NetworkConfigSettings } from '@argonprotocol/apps-core';
import os from 'node:os';
import { promises as Fs } from 'node:fs';
import { startServer } from './server.ts';
import { Db } from './Db.ts';

let oldestFrameIdToSync: number | undefined;

if (process.env.OLDEST_FRAME_ID_TO_SYNC) {
  oldestFrameIdToSync = parseInt(process.env.OLDEST_FRAME_ID_TO_SYNC, 10);
}

await waitForLoad();

const datadir = requireEnv('DATADIR');
const bidderKeypair = await loadKeypair(requireEnv('BIDDER_KEYPAIR_PATH'));
const bitcoinInitializerDelegateKeypair = await loadKeypair(requireEnv('VAULT_DELEGATE_KEYPAIR_PATH'));
const db = new Db(datadir);
db.migrate();

// Load network config
{
  // eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents
  let networkName: keyof typeof NetworkConfigSettings & string = (process.env.ARGON_CHAIN as any) ?? 'mainnet';
  if ((networkName as any) === 'local') {
    networkName = 'localnet';
  }
  if (!(networkName in NetworkConfigSettings)) {
    throw new Error(`${networkName} is not a valid Network chain name`);
  }
  // set archive url from env since we might be in docker and can't use localhost
  NetworkConfigSettings[networkName].archiveUrl = requireEnv('ARCHIVE_NODE_URL');
  NetworkConfig.setNetwork(networkName);
  if (networkName === 'localnet' || networkName === 'dev-docker') {
    const client = await getClient(NetworkConfigSettings[networkName].archiveUrl);
    await NetworkConfig.updateConfig(client);
    await client.disconnect();
  }
}
const bot = new Bot({
  db,
  oldestFrameIdToSync: oldestFrameIdToSync,
  bitcoinInitializerDelegateKeypair,
  ...requireAll({
    datadir,
    bidderKeypair,
    archiveRpcUrl: process.env.ARCHIVE_NODE_URL,
    localRpcUrl: process.env.LOCAL_RPC_URL,
    vaultOperatorAddress: process.env.VAULT_OPERATOR_ADDRESS,
    sessionMiniSecret: process.env.SESSION_MINI_SECRET,
    biddingRulesPath: process.env.BIDDING_RULES_PATH,
  }),
});
onExit(() => bot.shutdown());

const server = startServer(bot, process.env.PORT ?? 3000);
onExit(() => server.close());

try {
  await bot.start();
  let lastStateBroadcast = 0;
  const broadcastInterval = Math.max(100, NetworkConfig.tickMillis / 60);
  function broadcastUpdate() {
    const now = Date.now();
    if (now - lastStateBroadcast > broadcastInterval) {
      lastStateBroadcast = now;
      void server.broadcast('/state');
    }
  }
  bot.storage.events.on('data:updated', async ({ data }) => {
    if (data === 'bot-state') {
      broadcastUpdate();
    }
  });
  bot.autobidder.subscribeToUpdates(() => broadcastUpdate());
} catch (e: unknown) {
  console.error('Error starting bot', e);

  if (e && typeof e === 'object' && 'message' in e && typeof e.message === 'string') {
    server.startupError = e.message;
  } else {
    server.startupError = `An unknown error occurred while starting the bot -> ${String(e)}`;
  }
  bot.history.handleError(e as Error);
}

async function loadKeypair(path: string): Promise<KeyringPair> {
  const json = JSON.parse(await Fs.readFile(path.replace('~', os.homedir()), 'utf-8'));
  const pair = new Keyring().createFromJson(json);
  pair.decodePkcs8('');
  return pair;
}
