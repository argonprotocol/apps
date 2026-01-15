import { MainchainClients } from '../MainchainClients.js';
import { type ArgonClient, getClient } from '@argonprotocol/mainchain';
import { NetworkConfig, NetworkConfigSettings } from '../NetworkConfig.js';
import * as fs from 'node:fs';
import * as Path from 'path';
import type { IFramesHistory } from '../interfaces/IFramesHistory.ts';
import { FrameHistoryLoader } from './FrameHistoryLoader.ts';

const ARGON_NETWORK_NAME = process.env.ARGON_NETWORK_NAME;
const ARCHIVE_URL = process.env.ARGON_ARCHIVE_URL;

(async () => {
  const dirname = Path.join(import.meta.dirname, '..', 'data');
  for (const [name, config] of Object.entries(NetworkConfigSettings)) {
    if (name !== 'testnet' && name !== 'mainnet') {
      continue; // Only process mainnet and testnet since local/docknet are ephemeral
    }
    if (ARGON_NETWORK_NAME && ARGON_NETWORK_NAME !== name) {
      continue;
    }
    if (ARCHIVE_URL) {
      config.archiveUrl = ARCHIVE_URL;
    }
    NetworkConfig.setNetwork(name as any);
    const filePath = Path.join(dirname, `frames.${name}.json`);
    console.log(`\n--- Processing network: ${name} ---`, filePath);
    try {
      console.log(`Updating ${name}: ${config.archiveUrl}`);
      const client = (await Promise.race([
        getClient(config.archiveUrl),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Connection timeout')), 1e3)),
      ])) as ArgonClient;
      while ((await client.rpc.chain.getHeader().then(x => x.number.toNumber())) === 0) {
        await new Promise(res => setTimeout(res, 100));
        process.stdout.write('..');
      }
      const clients = new MainchainClients(config.archiveUrl, () => true, client);
      const existingData = await fs.promises.readFile(filePath, 'utf8').catch(() => '[]');
      const frameHistory = (JSON.parse(existingData) as IFramesHistory) ?? [];
      console.log(`Loaded ${frameHistory.length} frames from ${name}.json`);

      const hasChanges = await new FrameHistoryLoader(clients, frameHistory).syncToLatestStored();
      if (hasChanges) {
        frameHistory.sort((a, b) => a.frameId - b.frameId);
        fs.writeFileSync(filePath, JSON.stringify(frameHistory, null, 2) + '\n', 'utf-8');
        console.log(`Updated ${name}.json with latest frame history`);
      }
      await client.disconnect();
    } catch (e) {
      console.warn(`[${name}]`, e);
    }
  }
  process.exit(0);
})();
