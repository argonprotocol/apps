import { Keyring, mnemonicGenerate } from '@argonprotocol/mainchain';
import { WalletKeys } from '../../lib/WalletKeys.ts';
import { vi } from 'vitest';
import { bip39, getBip32Version, HDKey } from '@argonprotocol/bitcoin';
import { miniSecretFromUri } from '@argonprotocol/apps-core';

export function createTestWallet(mnemonic?: string) {
  mnemonic ??= mnemonicGenerate();
  const keypair = new Keyring({ type: 'sr25519' }).addFromMnemonic(mnemonic);
  const miningHoldAccount = keypair.derive('//holding'); // If we had a do-over, it would be called mining
  const miningBotAccount = keypair.derive('//mining'); // If we had a do-over, it would be called miningBot
  const vaultingAccount = keypair.derive('//vaulting');
  const investmentAccount = keypair.derive('//investments');
  return {
    mnemonic,
    miningHoldAccount,
    miningBotAccount,
    vaultingAccount,
    investmentAccount,
    walletKeys: new WalletKeys(
      {
        sshPublicKey: '',
        miningHoldAddress: miningHoldAccount.address,
        miningBotAddress: miningBotAccount.address,
        vaultingAddress: vaultingAccount.address,
        investmentsAddress: investmentAccount.address,
      },
      () => Promise.resolve(false),
    ),
  };
}

export function createMockWalletKeys(mnemonic?: string) {
  mnemonic ??= mnemonicGenerate();
  const { miningBotAccount, vaultingAccount, walletKeys } = createTestWallet(mnemonic);
  vi.spyOn(walletKeys, 'getBitcoinChildXpriv').mockImplementation(async (path, networks) => {
    const xpriv = await bip39.mnemonicToSeed(mnemonic);
    const version = getBip32Version(networks);
    return HDKey.fromMasterSeed(xpriv, version).derive(path);
  });
  vi.spyOn(walletKeys, 'getVaultingKeypair').mockImplementation(async () => vaultingAccount);
  vi.spyOn(walletKeys, 'getMiningBotSubaccounts').mockImplementation(async count => {
    const derivedAddresses: { [address: string]: { index: number } } = {};
    for (let index = 0; index < (count ?? 144); index++) {
      const address = miningBotAccount.derive(`//${index}`).address;
      derivedAddresses[address] = { index };
    }
    return derivedAddresses;
  });
  vi.spyOn(walletKeys, 'exposeMasterMnemonic').mockImplementation(async () => mnemonic);
  vi.spyOn(walletKeys, 'getMiningSessionMiniSecret').mockImplementation(async () => {
    return miniSecretFromUri(`${mnemonic}//mining//session`);
  });
  vi.spyOn(walletKeys, 'exportMiningBotAccountJson').mockImplementation(async (passphrase: string) => {
    return miningBotAccount.toJson(passphrase);
  });
  return walletKeys;
}
