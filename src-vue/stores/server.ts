import { ServerApiClient } from '../lib/ServerApiClient.ts';
import { ServerAuthClient } from '../lib/ServerAuthClient.ts';
import { getConfig } from './config.ts';
import { getWalletKeys } from './wallets.ts';

let serverApiClient: ServerApiClient | undefined;
let serverAuthClient: ServerAuthClient | undefined;

export function getServerApiClient(): ServerApiClient {
  serverApiClient ??= new ServerApiClient(() => getConfig().serverDetails, getServerAuthClient());
  return serverApiClient;
}

export function getServerAuthClient(): ServerAuthClient {
  serverAuthClient ??= new ServerAuthClient(getWalletKeys);
  return serverAuthClient;
}
