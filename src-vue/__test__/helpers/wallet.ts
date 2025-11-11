import { Keyring, mnemonicGenerate } from '@argonprotocol/mainchain';
import { WalletKeys } from '../../lib/WalletKeys.ts';
import { vi } from 'vitest';
import { bip39, getBip32Version, HDKey } from '@argonprotocol/bitcoin';
import { miniSecretFromUri } from '@argonprotocol/apps-core';

export function createMockWalletKeys(mnemonic?: string) {
  mnemonic ??= mnemonicGenerate();
  const keypair = new Keyring({ type: 'sr25519' }).addFromMnemonic(mnemonic);
  const miningAccount = keypair.derive('//mining');
  const vaultingAccount = keypair.derive('//vaulting');
  const walletKeys = new WalletKeys({
    sshPublicKey: '',
    miningAddress: miningAccount.address,
    vaultingAddress: vaultingAccount.address,
  });
  vi.spyOn(walletKeys, 'getBitcoinChildXpriv').mockImplementation(async (path, networks) => {
    const xpriv = await bip39.mnemonicToSeed(mnemonic);
    const version = getBip32Version(networks);
    return HDKey.fromMasterSeed(xpriv, version).derive(path);
  });
  vi.spyOn(walletKeys, 'getVaultingKeypair').mockImplementation(async () => vaultingAccount);
  vi.spyOn(walletKeys, 'getMiningSubaccounts').mockImplementation(async count => {
    const derivedAddresses: { [address: string]: { index: number } } = {};
    for (let index = 0; index < (count ?? 144); index++) {
      const address = miningAccount.derive(`//${index}`).address;
      derivedAddresses[address] = { index };
    }
    return derivedAddresses;
  });
  vi.spyOn(walletKeys, 'exposeMasterMnemonic').mockImplementation(async () => mnemonic);
  vi.spyOn(walletKeys, 'getMiningSessionMiniSecret').mockImplementation(async () => {
    return miniSecretFromUri(`${mnemonic}//mining//session`);
  });
  vi.spyOn(walletKeys, 'exportMiningAccountJson').mockImplementation(async (passphrase: string) => {
    return miningAccount.toJson(passphrase);
  });
  return walletKeys;
}
