import { integrationNetwork as sharedNetwork } from '@argonprotocol/apps-core/__test__/integration.setup.ts';
import { mnemonicGenerate } from '@argonprotocol/mainchain';
import { it, beforeAll, afterAll, expect, vi } from 'vitest';
import { teardown } from '@argonprotocol/testing';
import { BitcoinLock, MainchainClients, TreasuryBonds } from '@argonprotocol/apps-core';
import { type IntegrationNetwork } from '@argonprotocol/apps-core/__test__/integrationNetwork.ts';
import { waitFor } from '@argonprotocol/apps-core/__test__/helpers/waitFor.ts';
import { AppVaultOperator } from '../../e2e/actors/AppVaultOperator.ts';
import { MemoryWalletKeys } from '../lib/MemoryWalletKeys.ts';
import { loadOperationalAccount, loadOperationalAccountSetup } from '../lib/OperationalAccount.ts';

let network: IntegrationNetwork;
let clients: MainchainClients;
let actor: AppVaultOperator | undefined;

beforeAll(async () => {
  network = sharedNetwork;

  clients = new MainchainClients(network.archiveUrl, () => false);
  const client = await clients.get(false);
  await waitFor(90e3, 'bootstrap price oracle', async () => {
    const current = await client.query.priceIndex.current();
    return current && current.btcUsdPrice.isGreaterThan(0) && current.argonUsdPrice.isGreaterThan(0);
  });
}, 240e3);

afterAll(async () => {
  vi.restoreAllMocks();
  await actor?.dispose();
  await clients?.disconnect();
  await teardown();
});

it('resumes funded Bitcoin and bonds after registration fails without spending again', async () => {
  const mnemonic = mnemonicGenerate();
  const walletKeys = new MemoryWalletKeys({ substrateSuri: mnemonic, masterMnemonic: mnemonic });
  const client = await clients.get(false);
  actor = await AppVaultOperator.load({ clients, walletKeys });
  const register = vi.spyOn(client.tx.operationalAccounts, 'register').mockImplementationOnce(() => {
    throw new Error('registration RPC unavailable');
  });
  await expect(actor.bootstrapUpstreamOperator({ client, operatorName: 'Testing' })).rejects.toThrow(
    'registration RPC unavailable',
  );
  register.mockRestore();
  expect(await loadOperationalAccount(walletKeys, client)).toBeNull();
  const lockIds = await BitcoinLock.idsByOwner(client, walletKeys.defaultArgonAddress);
  const locks = await BitcoinLock.getMany(client, lockIds);
  expect(locks).toHaveLength(1);
  expect(locks[0]?.fundedSatoshis).toBeGreaterThan(0n);
  const bonds = await TreasuryBonds.getBondLotsByAccount(client, walletKeys.defaultArgonAddress);
  expect(bonds.length).toBeGreaterThan(0);

  await actor.dispose();
  actor = await AppVaultOperator.load({ clients, walletKeys });
  await actor.bootstrapUpstreamOperator({ client, operatorName: 'Testing' });

  expect(await BitcoinLock.idsByOwner(client, walletKeys.defaultArgonAddress)).toEqual(lockIds);
  expect(
    (await TreasuryBonds.getBondLotsByAccount(client, walletKeys.defaultArgonAddress)).map(({ id, bonds }) => ({
      id,
      bonds,
    })),
  ).toEqual(bonds.map(({ id, bonds }) => ({ id, bonds })));
  expect(await loadOperationalAccountSetup({ client, walletKeys, vault: actor.myVault.createdVault! })).toEqual({
    operatorName: 'Testing',
    vaultDelegateIsReady: true,
  });

  // A later worker restart also preserves the completed setup.
  await actor.dispose();
  actor = await AppVaultOperator.load({ clients, walletKeys });
  await actor.bootstrapUpstreamOperator({ client, operatorName: 'Testing' });
  expect(await BitcoinLock.idsByOwner(client, walletKeys.defaultArgonAddress)).toEqual(lockIds);
  expect(
    (await TreasuryBonds.getBondLotsByAccount(client, walletKeys.defaultArgonAddress)).map(({ id, bonds }) => ({
      id,
      bonds,
    })),
  ).toEqual(bonds.map(({ id, bonds }) => ({ id, bonds })));
}, 600e3);
