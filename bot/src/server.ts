import 'source-map-support/register';
import { getClient, Keyring, type KeyringPair, waitForLoad } from '@argonprotocol/mainchain';
import { jsonExt, onExit, requireAll, requireEnv } from './utils.ts';
import Bot from './Bot.ts';
import express from 'express';
import cors from 'cors';
import { Dockers } from './Dockers.ts';
import {
  type IBlockNumbers,
  type IBotStateError,
  type IBotStateStarting,
  MiningFrames,
  NetworkConfig,
} from '@argonprotocol/commander-core';
import os from 'node:os';
import { promises as Fs } from 'node:fs';

// wait for crypto wasm to be loaded
await waitForLoad();

let errorMessage = '';
let oldestFrameIdToSync: number | undefined;

if (process.env.OLDEST_FRAME_ID_TO_SYNC) {
  oldestFrameIdToSync = parseInt(process.env.OLDEST_FRAME_ID_TO_SYNC, 10);
}

let pair: KeyringPair;
{
  const path = requireEnv('KEYPAIR_PATH').replace('~', os.homedir());
  const json = JSON.parse(await Fs.readFile(path, 'utf-8'));
  pair = new Keyring().createFromJson(json);
  pair.decodePkcs8(process.env.KEYPAIR_PASSPHRASE);
}

let networkName: keyof typeof NetworkConfig & string = (process.env.ARGON_CHAIN as any) ?? 'mainnet';
if ((networkName as any) === 'local') {
  networkName = 'localnet';
}
if (!(networkName in NetworkConfig)) {
  throw new Error(`${networkName} is not a valid Network chain name`);
}
// set archive url from env since we might be in docker and can't use localhost
NetworkConfig[networkName].archiveUrl = requireEnv('ARCHIVE_NODE_URL');
MiningFrames.setNetwork(networkName);
if (networkName === 'localnet' || networkName === 'dev-docker') {
  const client = await getClient(NetworkConfig[networkName].archiveUrl);
  await MiningFrames.updateConfig(client);
  await client.disconnect();
}

const bot = new Bot({
  oldestFrameIdToSync: oldestFrameIdToSync,
  ...requireAll({
    datadir: process.env.DATADIR!,
    pair,
    biddingRulesPath: process.env.BIDDING_RULES_PATH,
    archiveRpcUrl: process.env.ARCHIVE_NODE_URL,
    localRpcUrl: process.env.LOCAL_RPC_URL,
    sessionMiniSecret: process.env.SESSION_MINI_SECRET,
  }),
});

const app = express();

app.use(cors({ origin: true, methods: ['GET', 'POST', 'PUT', 'DELETE'] }));

app.get('/state', async (_req, res) => {
  if (await hasError(res)) return;
  if (await isStarting(res)) return;
  const botState = await bot.blockSync.state();
  let lastBlockNumberByFrameId = botState.lastBlockNumberByFrameId;
  // only keep the last 10 frames
  if (lastBlockNumberByFrameId) {
    const frameIds = Object.keys(lastBlockNumberByFrameId)
      .map(x => Number(x))
      .sort((a, b) => b - a)
      .slice(0, 10);
    lastBlockNumberByFrameId = frameIds.reduce(
      (acc, frameId) => {
        acc[frameId] = lastBlockNumberByFrameId[frameId];
        return acc;
      },
      {} as Record<number, number>,
    );
  }

  jsonExt({ ...botState, lastBlockNumberByFrameId }, res);
});

app.get('/last-modified', async (_req, res) => {
  if (await hasError(res)) return;
  let lastModifiedDate = new Date();
  if (!bot.isReady) {
    return jsonExt({ lastModifiedDate }, res);
  }

  const state = await bot.blockSync.state();
  lastModifiedDate = state.bidsLastModifiedAt;
  if (lastModifiedDate < state.earningsLastModifiedAt) {
    lastModifiedDate = state.earningsLastModifiedAt;
  }
  jsonExt({ lastModifiedDate }, res);
});

app.get('/argon-blockchain-status', async (_req, res) => {
  if (await hasError(res)) return;
  const status = await Dockers.getArgonBlockNumbers();
  jsonExt(status, res);
});

app.get('/bitcoin-blockchain-status', async (_req, res) => {
  if (await hasError(res)) return;
  const status = await Dockers.getBitcoinBlockNumbers();
  jsonExt(status, res);
});

app.get('/bitcoin-recent-blocks', async (_req, res) => {
  if (await hasError(res)) return;
  const status = await Dockers.getBitcoinLatestBlocks();
  jsonExt(status, res);
});

app.get('/bids', async (_req, res) => {
  if (await hasError(res)) return;
  if (await isStarting(res)) return;
  const currentFrameId = await bot.currentFrameId;
  const nextFrameId = currentFrameId + 1;
  const data = await bot.storage.bidsFile(currentFrameId, nextFrameId).get();
  jsonExt(data, res);
});

app.get('/history', async (_req, res) => {
  if (await hasError(res)) return;
  const data = (await bot.history?.recent) || [];
  jsonExt(data, res);
});

app.get('/bids/:cohortBiddingFrameId-:cohortActivationFrameId', async (req, res) => {
  if (await hasError(res)) return;
  if (await isStarting(res)) return;
  const cohortBiddingFrameId = Number(req.params.cohortBiddingFrameId);
  const cohortActivationFrameId = Number(req.params.cohortActivationFrameId);
  const data = await bot.storage.bidsFile(cohortBiddingFrameId, cohortActivationFrameId).get();
  jsonExt(data, res);
});

app.get('/earnings/:frameId', async (req, res) => {
  if (await hasError(res)) return;
  if (await isStarting(res)) return;
  const frameId = Number(req.params.frameId);
  const data = await bot.storage.earningsFile(frameId).get();
  jsonExt(data, res);
});

app.use((_req, res) => {
  res.status(404).send('Not Found');
});

const server = app.listen(process.env.PORT ?? 3000, () => {
  console.log(`Server is running on port ${process.env.PORT ?? 3000}`);
});

onExit(() => new Promise<void>(resolve => server.close(() => resolve())));

bot.start().catch(e => {
  console.error('Error starting bot', e);

  if (e && typeof e === 'object' && 'message' in e && typeof e.message === 'string') {
    errorMessage = e.message as string;
  } else {
    errorMessage = `An unknown error occurred while starting the bot -> ${e}`;
  }
  bot.history.handleError(e);
});

onExit(() => bot.shutdown());

// Helper functions //////////////////////////////

async function createStartingPayload(): Promise<IBotStateStarting> {
  let syncProgress = 0;
  let argonBlockNumbers: IBlockNumbers = {
    localNode: 0,
    mainNode: 0,
  };

  let bitcoinBlockNumbers: IBlockNumbers = {
    localNode: 0,
    mainNode: 0,
  };

  try {
    [argonBlockNumbers, bitcoinBlockNumbers] = await Promise.all([
      Dockers.getArgonBlockNumbers(),
      Dockers.getBitcoinBlockNumbers(),
    ]);
  } catch (e) {
    console.error('Error getting block numbers', e);
  }

  try {
    syncProgress = (await bot.blockSync?.calculateSyncProgress()) ?? 0;
  } catch (e) {
    console.error('Error calculating sync progress', e);
  }

  const blockData = {
    argonBlockNumbers: argonBlockNumbers,
    bitcoinBlockNumbers: bitcoinBlockNumbers,
  };

  const payload: IBotStateStarting = {
    isReady: bot.isReady,
    isStarting: bot.isStarting || undefined,
    isSyncing: bot.isSyncing || undefined,
    isWaitingForBiddingRules: bot.isWaitingForBiddingRules || undefined,
    syncProgress,
    ...blockData,
  };

  return payload;
}

async function isStarting(res: express.Response): Promise<boolean> {
  if (bot.isReady) return false;

  jsonExt(await createStartingPayload(), res);

  return true;
}

async function hasError(res: express.Response): Promise<boolean> {
  if (!errorMessage && !bot.errorMessage) return false;

  const payload: IBotStateError = {
    ...(await createStartingPayload()),
    serverError: bot.errorMessage || errorMessage,
  };
  jsonExt(payload, res);

  return true;
}
