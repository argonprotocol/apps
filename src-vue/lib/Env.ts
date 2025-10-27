import { NetworkConfig, MiningFrames } from '@argonprotocol/apps-core';
import type ISecurity from '../interfaces/ISecurity.ts';

console.log('__ARGON_NETWORK_NAME__', __ARGON_NETWORK_NAME__);
console.log('__ARGON_APP_INSTANCE__', __ARGON_APP_INSTANCE__);

export const NETWORK_NAME = __ARGON_NETWORK_NAME__ || 'mainnet';
MiningFrames.setNetwork(NETWORK_NAME as any);
export const ENABLE_AUTO_UPDATE = __ARGON_APP_ENABLE_AUTOUPDATE__ ?? false;

export const SERVER_ENV_VARS = __SERVER_ENV_VARS__ ?? {};
const networkConfig = NetworkConfig[NETWORK_NAME as keyof typeof NetworkConfig] ?? NetworkConfig.mainnet;
export const NETWORK_URL = networkConfig.archiveUrl;
export const [INSTANCE_NAME, INSTANCE_PORT] = (__ARGON_APP_INSTANCE__ || 'default:1420').split(':');

export const env = (import.meta as any).env ?? {};
export const TICK_MILLIS: number = networkConfig.tickMillis;
export const ESPLORA_HOST: string = networkConfig.esploraHost;
export const BITCOIN_BLOCK_MILLIS: number = networkConfig.bitcoinBlockMillis;
export const DEPLOY_ENV_FILE = `.env.${NETWORK_NAME}`;
export const SECURITY = __ARGON_APP_SECURITY__ as ISecurity;
export const IS_TEST = __IS_TEST__ ?? false;
// eslint-disable-next-line prefer-const
export let LOG_DEBUG = '__LOG_DEBUG__' in window ? __LOG_DEBUG__ : false;
delete (globalThis as any).__ARGON_APP_SECURITY__; // remove from global scope
