/// <reference types="vite/client" />
/// <reference types="vite-svg-loader" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue';
  const component: DefineComponent<{}, {}, any>;
  export default component;
}

// Global variables defined by Vite
declare const __ARGON_APP_BUILD_TYPE__: string;
declare const __ARGON_APP_INSTANCE__: string;
declare const __ARGON_APP_ENABLE_AUTOUPDATE__: boolean;
declare const __ARGON_APP_SECURITY__: any;
declare const __ARGON_NETWORK_NAME__: string;
declare const __IS_TEST__: boolean;
declare let __LOG_DEBUG__: boolean;
declare const __SERVER_ENV_VARS__: {
  STATUS_PORT: string;
  BOT_PORT: string;
  ARGON_RPC_PORT: string;
  BITCOIN_VERSION: string;
  ARGON_VERSION: string;
};
