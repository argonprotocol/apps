import { Keyring, toFixedNumber, TxSubmitter } from '@argonprotocol/mainchain';
import { teardown } from '@argonprotocol/testing';
import { MainchainClients, MiningFrames, NetworkConfig, PriceIndex, IAllVaultStats } from '@argonprotocol/apps-core';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startArgonTestNetwork } from '@argonprotocol/apps-core/__test__/startArgonTestNetwork.js';
import { DEFAULT_MASTER_XPUB_PATH, MyVault } from '../lib/MyVault.ts';
import { createTestDb } from './helpers/db.ts';
import { Vaults } from '../lib/Vaults.ts';
import { Config } from '../lib/Config.ts';
import IVaultingRules from '../interfaces/IVaultingRules.ts';
import { BitcoinNetwork } from '@argonprotocol/bitcoin';
import { MyVaultRecovery } from '../lib/MyVaultRecovery.ts';
import { setMainchainClients } from '../stores/mainchain.ts';
import { Db } from '../lib/Db.ts';
import BitcoinLocksStore from '../lib/BitcoinLocksStore.ts';
import { TransactionTracker } from '../lib/TransactionTracker.ts';
import Path from 'path';
import { createMockWalletKeys } from './helpers/wallet.ts';
import { BlockWatch } from '@argonprotocol/apps-core/src/BlockWatch.ts';

afterAll(teardown);

const skipE2E = Boolean(JSON.parse(process.env.SKIP_E2E ?? '0'));

describe.skipIf(skipE2E).sequential('My Vault tests', {}, () => {
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
  let vaultCreatedBlockNumber: number;
  let vaultCreationFees: bigint;
  const walletKeys = createMockWalletKeys();

  beforeAll(async () => {
    db = await createTestDb();
    const network = await startArgonTestNetwork(Path.basename(import.meta.filename), { profiles: ['bob'] });

    mainchainUrl = network.archiveUrl;
    clients = new MainchainClients(mainchainUrl);
    const client = await clients.get(false);

    const txSubmitter = new TxSubmitter(
      client,
      client.tx.balances.transferAllowDeath(walletKeys.vaultingAddress, 10_000_000n),
      new Keyring({ type: 'sr25519' }).addFromMnemonic('//Alice'),
    );
    await txSubmitter.submit().then(res => res.waitForInFirstBlock);

    setMainchainClients(clients);
    NetworkConfig.setNetwork('dev-docker');
  }, 60e3);

  it('should work when no vault is found', async () => {
    const recovery = MyVaultRecovery.findOperatorVault(clients, BitcoinNetwork.Regtest, walletKeys);
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
      const res = await new TxSubmitter(
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
      ).submit();
      await res.waitForInFirstBlock;

      const priceIndex = new PriceIndex(clients);
      await priceIndex.fetchMicrogonExchangeRatesTo();
      const miningFrames = new MiningFrames(clients);
      const vaults = new Vaults('dev-docker', priceIndex, miningFrames);
      const transactionTracker = new TransactionTracker(Promise.resolve(db), miningFrames.blockWatch);
      const bitcoinLocksStore = new BitcoinLocksStore(
        Promise.resolve(db),
        walletKeys,
        miningFrames.blockWatch,
        priceIndex,
        transactionTracker,
      );
      myVault = new MyVault(
        Promise.resolve(db),
        vaults,
        walletKeys,
        transactionTracker,
        bitcoinLocksStore,
        miningFrames,
      );
      vi.spyOn(myVault.vaults, 'load').mockImplementation(async () => {});
      vi.spyOn(myVault.vaults, 'refreshRevenue').mockImplementation(async () => {
        return {} as IAllVaultStats;
      });

      await myVault.load();
      const vaultCreation = await myVault.createNew({
        masterXpubPath: DEFAULT_MASTER_XPUB_PATH,
        rules: vaultRules,
      });
      await vaultCreation.txResult.waitForFinalizedBlock;
      vaultCreationFees = vaultCreation.txResult.finalFee ?? 0n;
      expect(vaultCreation.tx.metadataJson.masterXpubPath).toBe(DEFAULT_MASTER_XPUB_PATH);
      vaultCreatedBlockNumber = vaultCreation.txResult.blockNumber!;
      await vaultCreation.waitForPostProcessing;
      const createdVault = myVault.createdVault!;
      expect(createdVault).toBeTruthy();
      expect(createdVault.vaultId).toBe(1);
      expect(createdVault.operatorAccountId).toBe(walletKeys.vaultingAddress);

      const recovery = MyVaultRecovery.findOperatorVault(clients, BitcoinNetwork.Regtest, walletKeys);
      await expect(recovery).resolves.toBeTruthy();
      const { vault, masterXpubPath, txFee, createBlockNumber } = (await recovery)!;

      expect(txFee).toBe(vaultCreationFees);
      expect(createBlockNumber).toBe(vaultCreatedBlockNumber);
      expect(vault).toStrictEqual(createdVault);
      expect(masterXpubPath).toBe(DEFAULT_MASTER_XPUB_PATH);
      vaultId = vault.vaultId;
      await expect(
        MyVaultRecovery.findPrebonded({
          vaultCreatedBlockNumber: vaultCreatedBlockNumber,
          walletKeys,
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
      const vaultSave = await myVault.activateSecuritizationAndTreasury({
        rules: vaultRules,
      });
      const bitcoinLocksStore = myVault.bitcoinLocksStore;
      expect(vaultSave).toBeTruthy();
      const client = await clients.archiveClientPromise;
      console.log('wait for finalize');
      const api = await client.at(await vaultSave!.txResult.waitForFinalizedBlock);
      const rulesSavedBlockNumber = await api.query.system.number().then(x => x.toNumber());
      console.log('finalized at', rulesSavedBlockNumber);
      const tick = await api.query.ticks.currentTick();

      await vaultSave!.waitForPostProcessing;
      expect(Object.keys(bitcoinLocksStore.data.locksByUtxoId)).toHaveLength(1);
      const bitcoinStored = Object.values(bitcoinLocksStore.data.locksByUtxoId)[0];

      // recover again so we get the right securitization
      const recovery = await MyVaultRecovery.findOperatorVault(clients, BitcoinNetwork.Regtest, walletKeys);
      expect(recovery).toBeTruthy();
      const { vault: recoveredVault } = recovery!;

      // check treasury
      const prebond = await MyVaultRecovery.findPrebonded({
        vaultCreatedBlockNumber: vaultCreatedBlockNumber,
        walletKeys,
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
      const blockWatch = new BlockWatch(clients);
      const transactionTracker2 = new TransactionTracker(Promise.resolve(newDb), blockWatch);
      const bitcoinLocksStoreRecovery = new BitcoinLocksStore(
        Promise.resolve(newDb),
        walletKeys,
        blockWatch,
        myVault.vaults.priceIndex,
        transactionTracker2,
      );
      await bitcoinLocksStoreRecovery.load();
      expect(Object.keys(bitcoinLocksStoreRecovery.data.locksByUtxoId)).toHaveLength(0);
      const bitcoins = await MyVaultRecovery.recoverPersonalBitcoin({
        mainchainClients: clients,
        vaultSetupBlockNumber: prebond.blockNumber!,
        vault: recoveredVault,
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
        uuid: expect.any(String),
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
