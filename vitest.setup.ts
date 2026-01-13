import { mnemonicGenerate } from '@argonprotocol/mainchain';
import ISecurity from './src-vue/interfaces/ISecurity';

(globalThis as any).__ARGON_APP_ID__ = 'com.argon.operations';
(globalThis as any).__ARGON_APP_NAME__ = 'ARGON';
(globalThis as any).__ARGON_NETWORK_NAME__ = 'dev-docker';
(globalThis as any).__ARGON_APP_INSTANCE__ = 'test-instance';
(globalThis as any).__ARGON_APP_ENABLE_AUTOUPDATE__ = false;
(globalThis as any).__SERVER_ENV_VARS__ = {} as any;
(globalThis as any).__IS_TEST__ = true;
(globalThis as any).__LOG_DEBUG__ = false;
(globalThis as any).__ARGON_APP_SECURITY__ = {
  masterMnemonic: mnemonicGenerate(),
  sshPublicKey: '',
} as unknown as ISecurity;
