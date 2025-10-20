import { mnemonicGenerate } from '@argonprotocol/mainchain';
import ISecurity from './src-vue/interfaces/ISecurity';

globalThis.__ARGON_NETWORK_NAME__ = 'dev-docker';
globalThis.__COMMANDER_INSTANCE__ = 'test-instance';
globalThis.__COMMANDER_ENABLE_AUTOUPDATE__ = false;
globalThis.__SERVER_ENV_VARS__ = {} as any;
globalThis.__IS_TEST__ = true;
globalThis.__COMMANDER_SECURITY__ = {
  masterMnemonic: mnemonicGenerate(),
  sshPublicKey: '',
} as ISecurity;
