import { Keyring, mnemonicGenerate, toFixedNumber, TxSubmitter } from '@argonprotocol/mainchain';
import { describeIntegration, teardown } from '@argonprotocol/testing';
import { MainchainClients, MiningFrames, PriceIndex } from '@argonprotocol/apps-core';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { startArgonTestNetwork } from '@argonprotocol/apps-core/__test__/startArgonTestNetwork.js';
import { DEFAULT_MASTER_XPUB_PATH, MyVault } from '../lib/MyVault.ts';
import { createTestDb } from './helpers/db.ts';
import { Vaults } from '../lib/Vaults.ts';
import { Config } from '../lib/Config.ts';
import IVaultingRules from '../interfaces/IVaultingRules.ts';
import { bip39, BitcoinNetwork } from '@argonprotocol/bitcoin';
import { MyVaultRecovery } from '../lib/MyVaultRecovery.ts';
import { setMainchainClients } from '../stores/mainchain.ts';
import { Db } from '../lib/Db.ts';
import BitcoinLocksStore from '../lib/BitcoinLocksStore.ts';

afterAll(teardown);

describeIntegration.sequential('My Vault tests', () => {
  let clients: MainchainClients;
  let mainchainUrl: string;
  let db: Db;
  let vaultId: number;
  let myVault: MyVault;
  const vaultRules: IVaultingRules = {
    ...(Config.getDefault('vaultingRules') as IVaultingRules),
    personalBtcPct: 50,
    securitizationRatio: 1,
    capitalForTreasuryPct: 50,
    capitalForSecuritizationPct: 50,
    baseMicrogonCommitment: 10_000_000n,
    baseMicronotCommitment: 0n,
    btcFlatFee: 100_000n,
    btcPctFee: 2.5,
    profitSharingPct: 5,
  };
  const alice = new Keyring({ type: 'sr25519' }).addFromMnemonic('//Alice');
  const xprivSeed = bip39.mnemonicToSeedSync(mnemonicGenerate());
  let vaultCreatedBlockNumber: number;
  let vaultCreationFees: bigint;

  beforeAll(async () => {
    db = await createTestDb();
    const network = await startArgonTestNetwork('exttest', { profiles: ['bob'] });

    mainchainUrl = network.archiveUrl;
    clients = new MainchainClients(mainchainUrl);
    setMainchainClients(clients);
    MiningFrames.setNetwork('dev-docker');
  }, 60e3);

  it('should work when no vault is found', async () => {
    const recovery = MyVaultRecovery.findOperatorVault(clients, BitcoinNetwork.Regtest, alice.address, xprivSeed);
    await expect(recovery).resolves.toBeUndefined();
  });

  it(
    'should be able to create a vault',
    {
      timeout: 60e3,
    },
    async () => {
      const client = await clients.archiveClientPromise;
      let blockNumber = 0;
      while (blockNumber <= 10) {
        blockNumber = await client.rpc.chain.getHeader().then(x => x.number.toNumber());
      }
      const currentTick = await client.query.ticks.currentTick();
      await new TxSubmitter(
        client,
        client.tx.priceIndex.submit({
          btcUsdPrice: toFixedNumber(60_000.5, 18),
          argonUsdPrice: toFixedNumber(1.0, 18),
          argonotUsdPrice: toFixedNumber(12.0, 18),
          argonUsdTargetPrice: toFixedNumber(1.0, 18),
          argonTimeWeightedAverageLiquidity: toFixedNumber(1_000, 18),
          tick: currentTick.toBigInt(),
        }),
        new Keyring({ type: 'sr25519' }).addFromUri('//Eve//oracle'),
      ).submit({ waitForBlock: true });

      const priceIndex = new PriceIndex(clients);
      await priceIndex.fetchMicrogonExchangeRatesTo();
      const vaults = new Vaults('dev-docker', priceIndex);
      myVault = new MyVault(Promise.resolve(db), vaults);
      const vaultCreation = await myVault.create({
        argonKeyring: alice,
        masterXpubPath: DEFAULT_MASTER_XPUB_PATH,
        rules: vaultRules,
        xprivSeed,
      });
      vaultCreationFees = vaultCreation.txResult.finalFee ?? 0n;
      expect(vaultCreation.vault.vaultId).toBe(1);
      vaultCreatedBlockNumber = await client.rpc.chain
        .getHeader(await vaultCreation.txResult.inBlockPromise)
        .then(x => x.number.toNumber());

      const recovery = MyVaultRecovery.findOperatorVault(clients, BitcoinNetwork.Regtest, alice.address, xprivSeed);
      await expect(recovery).resolves.toBeTruthy();
      const { vault, masterXpubPath, txFee, createBlockNumber } = (await recovery)!;

      expect(txFee).toBe(vaultCreationFees);
      expect(createBlockNumber).toBe(vaultCreatedBlockNumber);
      expect(vault).toStrictEqual(vaultCreation.vault);
      expect(masterXpubPath).toBe(DEFAULT_MASTER_XPUB_PATH);
      vaultId = vault.vaultId;
      await expect(
        MyVaultRecovery.findPrebonded({
          vaultCreatedBlockNumber: vaultCreatedBlockNumber,
          vaultingAddress: alice.address,
          vaultId: vault.vaultId,
          client,
        }),
      ).resolves.toMatchObject(expect.objectContaining({ prebondedMicrogons: 0n }));
    },
  );

  it(
    'should be able to recover vault rules + details',
    {
      timeout: 60e3,
    },
    async () => {
      const bitcoinLocksStore = new BitcoinLocksStore(Promise.resolve(db), myVault.vaults.priceIndex);
      await bitcoinLocksStore.load();
      const vaultSave = await myVault.initialActivate({
        rules: vaultRules,
        argonKeyring: alice,
        bip39Seed: xprivSeed,
        bitcoinLocksStore,
        txProgressCallback() {},
      });
      expect(vaultSave).toBeTruthy();
      const client = await clients.archiveClientPromise;
      const api = await client.at(await vaultSave!.txResult.inBlockPromise);
      const rulesSavedBlockNumber = await api.query.system.number().then(x => x.toNumber());
      const tick = await api.query.ticks.currentTick();
      expect(Object.keys(bitcoinLocksStore.data.locksById)).toHaveLength(1);
      const bitcoinStored = Object.values(bitcoinLocksStore.data.locksById)[0];

      // recover again so we get the right securitization
      const recovery = await MyVaultRecovery.findOperatorVault(
        clients,
        BitcoinNetwork.Regtest,
        alice.address,
        xprivSeed,
      );
      expect(recovery).toBeTruthy();
      const { vault: recoveredVault } = recovery!;

      // check treasury
      const prebond = await MyVaultRecovery.findPrebonded({
        vaultCreatedBlockNumber: vaultCreatedBlockNumber,
        vaultingAddress: alice.address,
        vaultId: recoveredVault.vaultId,
        client: await clients.archiveClientPromise,
      });
      expect(prebond).toMatchObject(
        expect.objectContaining({
          prebondedMicrogons:
            (MyVault.getMicrogonSplit(vaultRules, vaultCreationFees).microgonsForTreasury / 10n) * 10n,
          tick: tick.toNumber(),
          txFee: vaultSave!.txResult.finalFee,
        }),
      );

      // check bitcoin
      const newDb = await createTestDb();
      const bitcoinLocksStoreRecovery = new BitcoinLocksStore(Promise.resolve(newDb), myVault.vaults.priceIndex);
      await bitcoinLocksStoreRecovery.load();
      expect(Object.keys(bitcoinLocksStoreRecovery.data.locksById)).toHaveLength(0);
      const bitcoins = await MyVaultRecovery.recoverPersonalBitcoin({
        mainchainClients: clients,
        vaultSetupBlockNumber: prebond.blockNumber!,
        vault: recoveredVault,
        bip39Seed: xprivSeed,
        bitcoinLocksStore: bitcoinLocksStoreRecovery,
      });
      expect(bitcoins).toHaveLength(1);
      const bitcoin = bitcoins[0];
      console.log('Bitcoin result', {
        recovered: bitcoin.ratchets[0],
        original: bitcoinStored.ratchets[0],
      });
      expect({ ...bitcoin, createdAt: undefined, updatedAt: undefined }).toStrictEqual({
        ...bitcoinStored,
        initializedAtBlockNumber: rulesSavedBlockNumber,
        createdAt: undefined,
        updatedAt: undefined,
      });

      const rules = MyVaultRecovery.rebuildRules({
        feesInMicrogons: vaultCreationFees + (vaultSave!.txResult.finalFee ?? 0n),
        vault: recoveredVault,
        treasuryMicrogons: prebond.prebondedMicrogons,
        bitcoin,
      });
      expect(rules).toStrictEqual(vaultRules);
    },
  );
});
