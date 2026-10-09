import { integrationNetwork as sharedNetwork } from '@argonprotocol/apps-core/__test__/integration.setup.ts';
import { mnemonicGenerate } from '@argonprotocol/mainchain';
import { it, beforeAll, afterAll, expect, inject, vi } from 'vitest';
import { runtimeClient, type CurrentRuntimeQueries } from '@argonprotocol/runtime-client';
import { sudoFundWallet } from '@argonprotocol/apps-core/__test__/helpers/sudoFundWallet.ts';
import { teardown } from '@argonprotocol/testing';
import {
  BitcoinFission,
  BitcoinLock,
  loadCertificationProgress,
  MainchainClients,
  TreasuryBonds,
} from '@argonprotocol/apps-core';
import {
  integrationAccountUri,
  type IntegrationNetwork,
} from '@argonprotocol/apps-core/__test__/integrationNetwork.ts';
import { waitFor } from '@argonprotocol/apps-core/__test__/helpers/waitFor.ts';
import { AppVaultOperator } from '../../e2e/actors/AppVaultOperator.ts';
import { MemoryWalletKeys } from '../lib/MemoryWalletKeys.ts';
import {
  getOperationalRewardConfig,
  loadOperationalAccount,
  loadOperationalAccountSetup,
} from '../lib/OperationalAccount.ts';

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

it(
  'resumes certification after registration fails without spending Bitcoin or buying bonds again',
  { tags: ['exclusive-argon-network'], timeout: 600e3 },
  async () => {
    const mnemonic = mnemonicGenerate();
    const walletKeys = new MemoryWalletKeys({
      substrateSuri: integrationAccountUri(inject('argonIntegrationRunId'), import.meta.filename, 'upstream'),
      masterMnemonic: mnemonic,
    });
    const client = await clients.get(false);
    const treasuryPositions = runtimeClient<typeof client.raw, CurrentRuntimeQueries>(client.raw).query
      .treasuryPositions;
    const networkLiquidityBefore = (await treasuryPositions.networkTotals()).fissionLiquidity;
    actor = await AppVaultOperator.load({ clients, walletKeys });
    // Resume a vault created with the previous default, below the new certification bond minimum.
    const initialSecuritization = actor.config.vaultSetup.securitizationMicrogons;
    await sudoFundWallet({
      client,
      address: walletKeys.defaultArgonAddress,
      microgons: initialSecuritization + 20_000_000n,
      micronots: 0n,
    });
    await actor.ensureVaultReady();
    const register = vi.spyOn(client.tx.operationalAccounts, 'register').mockImplementationOnce(() => {
      throw new Error('registration RPC unavailable');
    });
    await expect(actor.bootstrapUpstreamOperator({ client, operatorName: 'Testing' })).rejects.toThrow(
      'registration RPC unavailable',
    );
    register.mockRestore();
    expect(await loadOperationalAccount(walletKeys, client)).toBeNull();
    const lockIds = await BitcoinLock.idsByOwner(client, walletKeys.defaultArgonAddress);
    expect(lockIds).toEqual([]);
    expect(await BitcoinFission.getAllByOwner(client, walletKeys.defaultArgonAddress)).toEqual([]);
    const bonds = await TreasuryBonds.getBondLotsByAccount(client, walletKeys.defaultArgonAddress);
    expect(bonds.length).toBeGreaterThan(0);
    const rewardConfig = await getOperationalRewardConfig(client);
    expect(initialSecuritization).toBeLessThan(rewardConfig.treasuryMinimumBonds);
    expect(actor.myVault.createdVault?.securitization).toBeGreaterThanOrEqual(rewardConfig.treasuryMinimumBonds);
    const position = await treasuryPositions.positionsByAccount(walletKeys.defaultArgonAddress);
    expect(position?.bondPrincipal).toBe(rewardConfig.treasuryMinimumBonds);
    expect(position?.quantities.bonds).toBeGreaterThan(0n);
    expect(position?.quantities.fissionLiquidity).toBe(rewardConfig.treasuryMinimumBitcoin);
    expect((await treasuryPositions.networkTotals()).fissionLiquidity).toBe(networkLiquidityBefore);

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
    expect(
      await loadCertificationProgress({
        client,
        defaultAccountId: walletKeys.defaultArgonAddress,
        operationalAccountId: walletKeys.operationalAddress,
      }),
    ).toMatchObject({ isTreasuryCertified: true, isOperationallyCertified: true });
    expect((await loadOperationalAccount(walletKeys, client))?.availableAccessCodes).toBeGreaterThan(0);

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
    expect(await BitcoinFission.getAllByOwner(client, walletKeys.defaultArgonAddress)).toEqual([]);
    expect((await treasuryPositions.networkTotals()).fissionLiquidity).toBe(networkLiquidityBefore);
  },
);
