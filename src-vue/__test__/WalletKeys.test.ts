import { expect, it } from 'vitest';
import type { IWalletRecord } from '../lib/db/WalletsTable.ts';
import { createTestWallet } from './helpers/wallet.ts';

it('keeps the core Ethereum address separate from the active external wallet', () => {
  const { walletKeys } = createTestWallet();
  const defaultEthereumAddress = walletKeys.defaultEthereumAddress;
  const externalWallet = {
    id: 1,
    walletType: 'ethereum',
    role: 'externalEthereum',
    name: 'External Ethereum',
    address: '0x0000000000000000000000000000000000000001',
    sortOrder: 1,
    secretKind: 'privateKey',
    encryptedSecret: 'encrypted',
    createdAt: new Date(),
    updatedAt: new Date(),
  } satisfies IWalletRecord;

  walletKeys.configureEthereumWallet(externalWallet);

  expect(walletKeys.ethereumAddress).toBe(externalWallet.address);
  expect(walletKeys.defaultEthereumAddress).toBe(defaultEthereumAddress);

  walletKeys.configureEthereumWallet();

  expect(walletKeys.ethereumAddress).toBe(defaultEthereumAddress);
});
