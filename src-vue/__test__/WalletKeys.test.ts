import { expect, it } from 'vitest';
import { WalletKeys } from '../lib/WalletKeys.ts';
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

it('falls back after a capacity load error, retries, and incrementally reuses generated subaccounts', async () => {
  const { walletKeys: sourceWalletKeys } = createTestWallet();
  let capacityLoadCount = 0;
  const walletKeys = new WalletKeys(
    {
      sshPublicKey: sourceWalletKeys.sshPublicKey,
      miningHoldAddress: sourceWalletKeys.legacyMiningHoldAddress,
      miningBotAddress: sourceWalletKeys.miningBotAddress,
      vaultingAddress: sourceWalletKeys.defaultArgonAddress,
      operationalAddress: sourceWalletKeys.operationalAddress,
      ethereumAddress: sourceWalletKeys.defaultEthereumAddress,
      ethereumHdPrefixes: sourceWalletKeys.ethereumHdPrefixes,
    },
    async () => false,
    async () => {
      capacityLoadCount += 1;
      if (capacityLoadCount === 1) {
        throw new Error('capacity unavailable');
      }
      return 150;
    },
  );

  const fallbackSubaccounts = await walletKeys.getMiningBotSubaccounts();
  const fallbackValues = Object.values(fallbackSubaccounts);

  expect(fallbackValues).toHaveLength(144);
  expect(fallbackValues[0]?.index).toBe(0);
  expect(fallbackValues[143]?.index).toBe(143);

  const runtimeSubaccounts = await walletKeys.getMiningBotSubaccounts();
  const runtimeValues = Object.values(runtimeSubaccounts);

  expect(runtimeSubaccounts).toBe(fallbackSubaccounts);
  expect(runtimeValues).toHaveLength(150);
  expect(runtimeValues[149]?.index).toBe(149);

  const expandedSubaccounts = await walletKeys.getMiningBotSubaccounts(152);
  const expandedValues = Object.values(expandedSubaccounts);

  expect(expandedSubaccounts).toBe(runtimeSubaccounts);
  expect(expandedValues).toHaveLength(152);
  expect(expandedValues[150]?.index).toBe(150);
  expect(expandedValues[151]?.index).toBe(151);

  const reusedSubaccounts = await walletKeys.getMiningBotSubaccounts(140);

  expect(reusedSubaccounts).toBe(expandedSubaccounts);
  expect(Object.values(reusedSubaccounts)).toHaveLength(152);
});
