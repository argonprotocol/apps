import * as fs from 'node:fs';
import * as Path from 'path';
import NetworkConfig from '../core/network.config.json';
import { ArgonClient, getClient } from '@argonprotocol/mainchain';
import { MiningFrames } from '@argonprotocol/apps-core';

const ARGON_NETWORK_NAME = process.env.ARGON_NETWORK_NAME;
const ARCHIVE_URL = process.env.ARGON_ARCHIVE_URL;

(async () => {
  const dirname = Path.join(import.meta.dirname, '..', 'core');
  for (const [name, config] of Object.entries(NetworkConfig)) {
    if (ARGON_NETWORK_NAME && ARGON_NETWORK_NAME !== name) {
      continue;
    }
    if (ARCHIVE_URL) {
      config.archiveUrl = ARCHIVE_URL;
    }
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
      const miningConfig = await MiningFrames.loadConfigs(client);
      Object.assign(config, miningConfig);
      await client.disconnect();
    } catch (e) {
      console.warn(`[${name}]: ${e}`);
    }
  }
  fs.writeFileSync(Path.join(dirname, 'network.config.json'), JSON.stringify(NetworkConfig, null, 2), 'utf-8');
  console.log('Updated network.config.json with latest mining configuration');
  process.exit(0);
})();
