import { NetworkConfig } from '@argonprotocol/apps-core';
import type ISecurity from '../interfaces/ISecurity.ts';

type ServerEnvVars = typeof __SERVER_ENV_VARS__;
type RuntimeEnv = Partial<{
  __ARGON_APP_ID__?: string;
  __ARGON_APP_NAME__?: string;
  __ARGON_NETWORK_NAME__?: string;
  __ARGON_NETWORK_CONFIG_OVERRIDE__?: Record<string, unknown> | null;
  __ARGON_APP_ENABLE_AUTOUPDATE__?: boolean;
  __SERVER_ENV_VARS__?: ServerEnvVars;
  __ARGON_APP_INSTANCE__?: string;
  __ARGON_APP_SECURITY__?: ISecurity;
  __LOG_DEBUG__?: boolean;
}>;

function readInjected<K extends keyof RuntimeEnv>(key: K, fallback: NonNullable<RuntimeEnv[K]>) {
  return (globalThis as RuntimeEnv)[key] || fallback;
}

export const APP_ID = readInjected('__ARGON_APP_ID__', 'com.argon.desktop');
export const IS_LOCAL_BUILD = APP_ID.includes('local');
export const IS_EXPERIMENTAL_BUILD = APP_ID.includes('experimental');
export const IS_STABLE_BUILD = !IS_LOCAL_BUILD && !IS_EXPERIMENTAL_BUILD;
export const APP_NAME = readInjected('__ARGON_APP_NAME__', 'Argon');

export const NETWORK_NAME = readInjected('__ARGON_NETWORK_NAME__', 'mainnet');
NetworkConfig.setNetwork(NETWORK_NAME as any);
const networkConfigOverride = (globalThis as RuntimeEnv).__ARGON_NETWORK_CONFIG_OVERRIDE__;
if (networkConfigOverride) {
  NetworkConfig.setRuntimeOverride(NETWORK_NAME as any, networkConfigOverride as any);
}
export const ENABLE_AUTO_UPDATE = readInjected('__ARGON_APP_ENABLE_AUTOUPDATE__', false);

export const SERVER_ENV_VARS: ServerEnvVars = readInjected('__SERVER_ENV_VARS__', {
  ARGON_VERSION: '',
  BITCOIN_VERSION: '',
});
const networkConfig = NetworkConfig.get();
export const NETWORK_URL = networkConfig.archiveUrl;
export const [INSTANCE_NAME, INSTANCE_PORT] = readInjected('__ARGON_APP_INSTANCE__', 'default:1420').split(':');

export const env = (import.meta as any).env ?? {};
export const IS_E2E = typeof __ARGON_DRIVER_WS__ !== 'undefined' && __ARGON_DRIVER_WS__.trim().length > 0;
export const TICK_MILLIS: number = networkConfig.tickMillis;
export const ESPLORA_HOST: string = networkConfig.esploraHost;
export const BITCOIN_BLOCK_MILLIS: number = networkConfig.bitcoinBlockMillis;
export const DEPLOY_ENV_FILE = `.env.${NETWORK_NAME}`;
export const SECURITY = (globalThis as RuntimeEnv).__ARGON_APP_SECURITY__ as ISecurity;
export const IS_TEST = (typeof __IS_TEST__ !== 'undefined' && __IS_TEST__) || IS_E2E;
// eslint-disable-next-line prefer-const
export let LOG_DEBUG =
  (globalThis as RuntimeEnv).__LOG_DEBUG__ ?? (typeof __LOG_DEBUG__ !== 'undefined' ? __LOG_DEBUG__ : false);
delete (globalThis as any).__ARGON_APP_SECURITY__; // remove from global scope
