import 'source-map-support/register';
import { waitForLoad } from '@argonprotocol/mainchain';
import { NetworkConfig } from '@argonprotocol/apps-core';
import { loadKeypair, onExit, requireAll, requireEnv } from './utils.ts';
import Bot from './Bot.ts';
import { startServer } from './server.ts';
import { Db } from './Db.ts';
import { configureNetwork } from './configureNetwork.ts';

let oldestFrameIdToSync: number | undefined;

if (process.env.OLDEST_FRAME_ID_TO_SYNC) {
  oldestFrameIdToSync = parseInt(process.env.OLDEST_FRAME_ID_TO_SYNC, 10);
}

await waitForLoad();

const datadir = requireEnv('DATADIR');
const archiveRpcUrl = requireEnv('ARCHIVE_NODE_URL');
const proxyKeypair = await loadKeypair(requireEnv('BIDDER_KEYPAIR_PATH'));
const bitcoinInitializerDelegateKeypair = await loadKeypair(requireEnv('VAULT_DELEGATE_KEYPAIR_PATH'));
const db = new Db(datadir);
db.migrate();
await configureNetwork(archiveRpcUrl);
const ethereumBeaconApiUrl =
  process.env.ETHEREUM_BEACON_API_URL?.trim() || NetworkConfig.get().ethereumNetwork.beaconApiUrl.trim() || undefined;
const bot = new Bot({
  db,
  oldestFrameIdToSync: oldestFrameIdToSync,
  bitcoinInitializerDelegateKeypair,
  ethereumBeaconApiUrl,
  ...requireAll({
    datadir,
    fundingAccountId: process.env.MINING_FUNDING_ACCOUNT_ID,
    proxyKeypair,
    archiveRpcUrl,
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
