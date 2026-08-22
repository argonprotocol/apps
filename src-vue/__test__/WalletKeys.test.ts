import { expect, it, vi } from 'vitest';
import { WalletKeys } from '../lib/WalletKeys.ts';
import type { IWalletRecord } from '../lib/db/WalletsTable.ts';
import { createTestWallet } from './helpers/wallet.ts';

const invokeWithTimeout = vi.hoisted(() => vi.fn());
vi.mock('../lib/tauriApi.ts', () => ({ invokeWithTimeout }));

it('exports the private seed for the configured default Argon key reference', async () => {
  const { walletKeys } = createTestWallet();
  const seed = Uint8Array.from({ length: 32 }, (_, index) => index);
  invokeWithTimeout.mockResolvedValueOnce(seed);

  const privateKey = await walletKeys.exportDefaultArgonPrivateKey();

  expect(privateKey).toBe(`0x${Array.from(seed, byte => byte.toString(16).padStart(2, '0')).join('')}`);
  expect(invokeWithTimeout).toHaveBeenCalledWith(
    'derive_sr25519_seed',
    { suri: walletKeys.defaultArgonKeyReference },
    60e3,
  );
});

it('uses an explicit external wallet without changing the core Ethereum signer', async () => {
  invokeWithTimeout.mockReset();
  const { walletKeys: sourceWalletKeys } = createTestWallet();
  const walletKeys = new WalletKeys(
    {
      sshPublicKey: sourceWalletKeys.sshPublicKey,
      miningHoldAddress: sourceWalletKeys.legacyMiningHoldAddress,
      miningBotAddress: sourceWalletKeys.miningBotAddress,
      vaultingAddress: sourceWalletKeys.defaultArgonAddress,
      operationalAddress: sourceWalletKeys.operationalAddress,
      ethereumAddress: sourceWalletKeys.coreEthereumAddress,
      ethereumHdPrefixes: sourceWalletKeys.ethereumHdPrefixes,
    },
    async () => false,
  );
  const externalWallet = {
    id: 1,
    walletType: 'ethereum',
    name: 'External Ethereum',
    address: '0x0000000000000000000000000000000000000001',
    sortOrder: 1,
    secretKind: 'privateKey',
    encryptedSecret: 'encrypted',
    derivationPath: "m/44'/60'/0'/0/1",
    createdAt: new Date(),
    updatedAt: new Date(),
  } satisfies IWalletRecord;
  const externalSignature = { r: '0x01', s: '0x02', v: 27n };
  const coreSignature = { r: '0x03', s: '0x04', v: 28n };
  invokeWithTimeout.mockResolvedValueOnce(externalSignature).mockResolvedValueOnce(coreSignature);

  await expect(walletKeys.signEthereumTransaction('0x01', walletKeys.ethereumHdPath, externalWallet)).resolves.toBe(
    externalSignature,
  );
  await expect(walletKeys.signEthereumTransaction('0x02')).resolves.toBe(coreSignature);

  expect(invokeWithTimeout).toHaveBeenNthCalledWith(
    1,
    'sign_external_ethereum_transaction',
    {
      encryptedSecret: externalWallet.encryptedSecret,
      secretKind: externalWallet.secretKind,
      hdPath: externalWallet.derivationPath,
      request: { unsignedTransaction: '0x01' },
    },
    60e3,
  );
  expect(invokeWithTimeout).toHaveBeenNthCalledWith(
    2,
    'sign_ethereum_transaction',
    { hdPath: walletKeys.ethereumHdPath, request: { unsignedTransaction: '0x02' } },
    60e3,
  );
  expect(walletKeys.coreEthereumAddress).not.toBe(externalWallet.address);
});

it('uses the secured Ethereum address as the core wallet authority', () => {
  const { walletKeys } = createTestWallet();
  const record = {
    id: 1,
    walletType: 'ethereum',
    name: 'Imported-looking Core Wallet',
    address: walletKeys.coreEthereumAddress.toUpperCase(),
    sortOrder: 1,
    secretKind: 'privateKey',
    encryptedSecret: 'redundant-secret',
    createdAt: new Date(),
    updatedAt: new Date(),
  } satisfies IWalletRecord;

  expect(walletKeys.isCoreEthereumAddress(record.address)).toBe(true);
  expect(walletKeys.isCoreEthereumWallet(record)).toBe(true);
  expect(walletKeys.isCoreEthereumWallet({ ...record, address: '0x0000000000000000000000000000000000000001' })).toBe(
    false,
  );
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
      ethereumAddress: sourceWalletKeys.coreEthereumAddress,
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
