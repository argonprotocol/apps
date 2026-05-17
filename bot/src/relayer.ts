import 'source-map-support/register';
import cors from 'cors';
import express from 'express';
import type { Server } from 'node:http';
import { setTimeout } from 'node:timers/promises';
import type { IEthereumInboundRelayRequest } from '@argonprotocol/apps-core';
import { getClient, type ArgonClient, waitForLoad } from '@argonprotocol/mainchain';
import { DelegateSubmitLane } from './DelegateSubmitLane.ts';
import { EthereumBeaconSyncService } from './EthereumBeaconSyncService.ts';
import { EthereumProofRelayService } from './EthereumProofRelayService.ts';
import { requireBody, safeJsonRoute, sendJson } from './apiUtils.ts';
import { configureNetwork } from './configureNetwork.ts';
import { loadKeypair, onExit, requireEnv } from './utils.ts';

await waitForLoad();
await configureNetwork(process.env.ARCHIVE_NODE_URL);

const localRpcUrl = requireEnv('LOCAL_RPC_URL');
const beaconApiUrl = process.env.ETHEREUM_BEACON_API_URL?.trim();
const beaconPollMsValue = process.env.ETHEREUM_BEACON_POLL_MS?.trim();
const parsedBeaconPollMs = beaconPollMsValue ? Number.parseInt(beaconPollMsValue, 10) : undefined;
if (
  beaconPollMsValue &&
  (parsedBeaconPollMs === undefined || !Number.isFinite(parsedBeaconPollMs) || parsedBeaconPollMs <= 0)
) {
  throw new Error('ETHEREUM_BEACON_POLL_MS must be a positive integer');
}
const beaconPollMs = parsedBeaconPollMs;
const delegateKeypair = await loadKeypair(requireEnv('VAULT_DELEGATE_KEYPAIR_PATH'));
const submitLane = new DelegateSubmitLane(delegateKeypair);
const ethereumProofRelayService = new EthereumProofRelayService(submitLane);

let localClient: ArgonClient | undefined;
let ethereumBeaconSyncService: EthereumBeaconSyncService | undefined;
let isReady = false;
const server = startRelayerServer(process.env.PORT ?? 3000);

onExit(async () => {
  server?.close();
  await ethereumBeaconSyncService?.shutdown().catch(() => undefined);
  await localClient?.disconnect().catch(() => undefined);
});

void start().catch(error => {
  console.error('Error starting relayer', error);
});

async function start(): Promise<void> {
  console.log('STARTING RELAYER');

  while (!localClient) {
    try {
      localClient = await getClient(localRpcUrl, { throwOnConnect: true });
    } catch (error) {
      console.error('Error initializing local client, retrying...', error);
      await setTimeout(1000);
    }
  }

  submitLane.client = localClient;
  if (beaconApiUrl) {
    ethereumBeaconSyncService = new EthereumBeaconSyncService(localClient, {
      beaconApiUrl,
      pollMs: beaconPollMs,
      submitLane,
    });
    await ethereumBeaconSyncService.start();
  }

  isReady = true;
}

function startRelayerServer(port: number | string): Server {
  const app = express();
  app.use(cors({ origin: true, methods: ['GET', 'POST'] }));

  app.get('/is-ready', async (_req, res) => {
    sendJson(res, isReady);
  });

  app.post('/ethereum-proof-relay', express.text({ type: '*/*' }), async (req, res) => {
    await safeJsonRoute(res, async () => {
      const request = requireBody<IEthereumInboundRelayRequest>(req.body);
      return await ethereumProofRelayService.relayTransferProof(request);
    });
  });

  app.use((_req, res) => {
    res.status(404).send('Not Found');
  });

  return app.listen(port, () => {
    console.log(`Relayer server is running on port ${port}`);
  });
}
