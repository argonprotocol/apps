import { NetworkConfig, NetworkConfigSettings } from '@argonprotocol/apps-core';
import { Db } from './src/Db.ts';
import { RouterServer } from './src/RouterServer.ts';
import { TreasuryInviteService } from './src/TreasuryInviteService.ts';
import { ARGON_CHAIN, BITCOIN_CHAIN, LOCAL_NODE_URL, MAIN_NODE_URL, PORT, ROUTER_DB_PATH } from './src/env';

console.log('Starting router server on port', PORT, {
  LOCAL_NODE_URL,
  MAIN_NODE_URL,
  BITCOIN_CHAIN,
});

const networkName = ARGON_CHAIN === 'local' ? 'localnet' : (ARGON_CHAIN ?? 'mainnet');
if (!(networkName in NetworkConfigSettings)) {
  throw new Error(`${networkName} is not a valid Network chain name`);
}
NetworkConfig.setNetwork(networkName as keyof typeof NetworkConfigSettings);

const db = new Db(ROUTER_DB_PATH);
db.migrate();

const server = new RouterServer({
  db,
  inviteService: new TreasuryInviteService(db),
  botInternalUrl: 'http://bot:8080',
  port: Number(PORT),
  localNodeUrl: LOCAL_NODE_URL,
  mainNodeUrl: MAIN_NODE_URL,
});

server.start();
