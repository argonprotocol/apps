import { Keyring, mnemonicGenerate } from '@argonprotocol/mainchain';
import { bip39 } from '@argonprotocol/bitcoin';
import { wordlist as englishWordlist } from '@scure/bip39/wordlists/english';
import { MemoryWalletKeys } from '../../lib/MemoryWalletKeys.ts';

const DEFAULT_TEST_MNEMONIC = 'test test test test test test test test test test test junk';

function resolveTestSecrets(mnemonicOrUri?: string) {
  const substrateSuri = mnemonicOrUri ?? DEFAULT_TEST_MNEMONIC;
  const masterMnemonic = bip39.validateMnemonic(substrateSuri, englishWordlist) ? substrateSuri : DEFAULT_TEST_MNEMONIC;

  return { substrateSuri, masterMnemonic };
}

export function createTestWallet(mnemonic?: string) {
  const { substrateSuri, masterMnemonic } = resolveTestSecrets(mnemonic ?? mnemonicGenerate());
  const keypair = new Keyring({ type: 'sr25519' }).addFromUri(substrateSuri);
  const legacyMiningHoldAccount = keypair.derive('//holding');
  const miningBotAccount = keypair.derive('//mining');
  const vaultingAccount = keypair.derive('//vaulting');
  const operationalAccount = keypair.derive('//operational');

  return {
    mnemonic: masterMnemonic,
    legacyMiningHoldAccount,
    miningBotAccount,
    vaultingAccount,
    operationalAccount,
    walletKeys: new MemoryWalletKeys({
      substrateSuri,
      masterMnemonic,
    }),
  };
}

export function createMockWalletKeys(mnemonic?: string) {
  return createTestWallet(mnemonic).walletKeys;
}
