import './_globals.js';
import * as fs from 'node:fs';
import * as path from 'path';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import {
  JsonExt,
  MainchainClients,
  MiningFrames,
  NetworkConfig,
  NetworkConfigSettings,
  PriceIndex,
} from '@argonprotocol/apps-core';
import { Vaults } from '../src-vue/lib/Vaults.ts';
import { setMainchainClients } from '../src-vue/stores/mainchain.ts';

dayjs.extend(utc);

const rebuildBaseline = Boolean(JSON.parse(process.env.REBUILD_BASELINE ?? '0'));

export default async function fetchVaultRevenue() {
  for (const chain of ['testnet', 'mainnet'] as const) {
    NetworkConfig.networkName = chain;
    const mainchain = new MainchainClients(NetworkConfigSettings[chain].archiveUrl);
    const priceIndex = new PriceIndex(mainchain);
    await priceIndex.fetchMicrogonExchangeRatesTo();
    const miningFrames = new MiningFrames(mainchain);
    await miningFrames.load();
    setMainchainClients(mainchain);
    const vaults = new Vaults(chain, priceIndex, miningFrames);
    await vaults.load();
    // @ts-expect-error -- Override saveStats to prevent writing to DB during data fetch
    vaults.saveStats = () => Promise.resolve(); // Disable saving stats during data fetch
    const data = await vaults.refreshRevenue(mainchain);
    await miningFrames.stop();

    // Write data to JSON file
    const filePath = path.join(process.cwd(), 'core', 'src', 'data', `vaultRevenue.${chain}.json`);
    console.log(`Writing data to: ${filePath}`);

    const fileDir = path.dirname(filePath);
    if (!fs.existsSync(fileDir)) {
      console.log(`Creating directory: ${fileDir}`);
      fs.mkdirSync(fileDir, { recursive: true });
    }

    if (rebuildBaseline) {
      const client = await mainchain.prunedClientOrArchivePromise;
      const utxos = await client.query.bitcoinLocks.locksByUtxoId.entries();
      for (const [_utxoId, utxo] of utxos) {
        const vaultId = utxo.unwrap().vaultId.toNumber();
        const satoshis = utxo.unwrap().satoshis.toBigInt();
        const liquidityPromised = utxo.unwrap().liquidityPromised.toBigInt();
        const vaultStats = data.vaultsById[vaultId].baseline;
        vaultStats.bitcoinLocks += 1;
        vaultStats.satoshis += satoshis;
        vaultStats.microgonLiquidityRealized += liquidityPromised;
        vaultStats.feeRevenue += vaults.vaultsById[vaultId].calculateBitcoinFee(liquidityPromised);
      }
    }

    fs.writeFileSync(filePath, JsonExt.stringify(data, 2));
    console.log(`Successfully saved Vault revenue data`);
  }
}
