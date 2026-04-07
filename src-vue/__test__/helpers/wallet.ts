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
  const investmentAccount = keypair.derive('//investment');
  const operationalAccount = keypair.derive('//operational');
  return {
    mnemonic,
    miningHoldAccount,
    miningBotAccount,
    vaultingAccount,
    investmentAccount,
    operationalAccount,
    walletKeys: new WalletKeys(
      {
        sshPublicKey: '',
        miningHoldAddress: miningHoldAccount.address,
        miningBotAddress: miningBotAccount.address,
        vaultingAddress: vaultingAccount.address,
        investmentAddress: investmentAccount.address,
        operationalAddress: operationalAccount.address,
      },
      () => Promise.resolve(false),
    ),
  };
}

export function createMockWalletKeys(mnemonic?: string) {
  mnemonic ??= mnemonicGenerate();
  const { miningBotAccount, vaultingAccount, walletKeys, operationalAccount, miningHoldAccount } =
    createTestWallet(mnemonic);
  const delegateAccount = vaultingAccount.derive('//delegate');
  vi.spyOn(walletKeys, 'getBitcoinChildXpriv').mockImplementation(async (path, networks) => {
    const xpriv = await bip39.mnemonicToSeed(mnemonic);
    const version = getBip32Version(networks);
    return HDKey.fromMasterSeed(xpriv, version).derive(path);
  });
  vi.spyOn(walletKeys, 'getOperationalKeypair').mockImplementation(async () => operationalAccount);
  vi.spyOn(walletKeys, 'getMiningBotKeypair').mockImplementation(async () => miningBotAccount);
  vi.spyOn(walletKeys, 'getMiningHoldKeypair').mockImplementation(async () => miningHoldAccount);
  vi.spyOn(walletKeys, 'getOperationalEncryptionKeypair').mockImplementation(async () =>
    Uint8Array.from(Array(32).fill(1)),
  );
  vi.spyOn(walletKeys, 'getVaultingKeypair').mockImplementation(async () => vaultingAccount);
  vi.spyOn(walletKeys, 'getVaultDelegateKeypair').mockImplementation(async () => delegateAccount);
  vi.spyOn(walletKeys, 'exposeMasterMnemonic').mockImplementation(async () => mnemonic);
  vi.spyOn(walletKeys, 'getMiningSessionMiniSecret').mockImplementation(async () => {
    return miniSecretFromUri(`${mnemonic}//mining//session`);
  });
  vi.spyOn(walletKeys, 'exportMiningBotAccountJson').mockImplementation(async (passphrase: string) => {
    return miningBotAccount.toJson(passphrase);
  });
  return walletKeys;
}
