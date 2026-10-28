import { runtimeClient } from '@argonprotocol/runtime-client';
import BigNumber from 'bignumber.js';
import { integrationNetwork as sharedNetwork } from '@argonprotocol/apps-core/__test__/integration.setup.ts';
import { mnemonicGenerate } from '@argonprotocol/mainchain';
import { teardown } from '@argonprotocol/testing';
import {
  Currency as CurrencyBase,
  IAllVaultStats,
  MainchainClients,
  MiningFrames,
  minimumVaultDelegateBalance,
  TreasuryBonds,
  Vault,
} from '@argonprotocol/apps-core';
import { it, beforeAll, afterAll, describe, expect, vi } from 'vitest';
import { submitAndFinalize } from '@argonprotocol/apps-core/__test__/helpers/mainchain.ts';
import { sudoFundWallet } from '@argonprotocol/apps-core/__test__/helpers/sudoFundWallet.ts';
import { DEFAULT_MASTER_XPUB_PATH, MyVault } from '../lib/MyVault.ts';
import { createTestDb } from './helpers/db.ts';
import { Vaults } from '../lib/Vaults.ts';
import { Config } from '../lib/Config.ts';
import type { IConfig } from '../interfaces/IConfig.ts';
import { BitcoinNetwork } from '@argonprotocol/bitcoin';
import { MyVaultRecovery } from '../lib/recovery/MyVaultRecovery.ts';
import { setMainchainClients } from '../stores/mainchain.ts';
import { Db } from '../lib/Db.ts';
import BitcoinLocks from '../lib/BitcoinLocks.ts';
import { GlobalCouncil } from '../lib/GlobalCouncil.ts';
import { MintingAuthorities } from '../lib/MintingAuthorities.ts';
import { TransactionTracker } from '../lib/TransactionTracker.ts';
import { BitcoinLockCreate } from '../lib/txs/BitcoinLock.create.ts';
import { UpstreamOperatorClient } from '../lib/UpstreamOperatorClient.ts';
import { createMockWalletKeys } from './helpers/wallet.ts';
import { BlockWatch } from '@argonprotocol/apps-core/src/BlockWatch.ts';
import { setDbPromise } from '../stores/helpers/dbPromise.ts';
import { ExtrinsicType, TransactionStatus } from '../lib/db/TransactionsTable.ts';

const skipE2E = Boolean(JSON.parse(process.env.SKIP_E2E ?? '0'));

describe.skipIf(skipE2E).sequential('Your Vault tests', {}, () => {
  let clients: MainchainClients;
  let mainchainUrl: string;
  let db: Db;
  let vaultId: number;
  let myVault: MyVault;
  let bitcoinLockCreate: BitcoinLockCreate;
  const trackedBitcoinLocks: BitcoinLocks[] = [];
  const trackedBlockWatches: BlockWatch[] = [];
  const trackedDbs: Db[] = [];
  const trackedMiningFrames: MiningFrames[] = [];
  const vaultSetup: IConfig['vaultSetup'] = {
    ...(Config.getDefault('vaultSetup') as IConfig['vaultSetup']),
    securitizationMicrogons: 10_000_000n,
    committedMicronots: 10_000_000n,
    btcFlatFee: 1_000_000n,
    btcPctFee: 2.5,
  };
  let vaultCreatedBlockNumber: number;
  let vaultCreationFees: bigint;
  const mnemonic = mnemonicGenerate();
  const walletKeys = createMockWalletKeys(mnemonic);

  beforeAll(async () => {
    db = await createTestDb();
    setDbPromise(Promise.resolve(db));
    trackedDbs.push(db);
    const network = sharedNetwork;

    mainchainUrl = network.archiveUrl;
    clients = new MainchainClients(mainchainUrl);
    await sudoFundWallet({
      address: walletKeys.vaultingAddress,
      microgons: 100_000_000n,
      micronots: 0n,
      archiveUrl: network.archiveUrl,
    });

    setMainchainClients(clients);
  }, 180e3);

  afterAll(async () => {
    myVault?.unsubscribe();
    await cleanupTrackedResources();
    await teardown();
  });

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
      const currency = new CurrencyBase(clients);
      await currency.fetchMainchainRates();
      const miningFrames = trackMiningFrames(new MiningFrames(clients));
      const vaults = new Vaults('dev-docker', currency, miningFrames);
      let transactionTracker = new TransactionTracker(Promise.resolve(db), miningFrames.blockWatch);
      let bitcoinLocks = trackBitcoinLocks(
        new BitcoinLocks(Promise.resolve(db), walletKeys, miningFrames.blockWatch, currency, transactionTracker),
      );
      const globalCouncil = new GlobalCouncil(Promise.resolve(db), walletKeys, miningFrames);
      let mintingAuthorities = new MintingAuthorities(
        Promise.resolve(db),
        walletKeys,
        miningFrames,
        transactionTracker,
      );
      myVault = new MyVault(
        Promise.resolve(db),
        vaults,
        walletKeys,
        transactionTracker,
        bitcoinLocks,
        miningFrames,
        globalCouncil,
        mintingAuthorities,
      );
      vi.spyOn(myVault.vaults, 'load').mockImplementation(async () => {});
      vi.spyOn(myVault.vaults, 'updateRevenue').mockImplementation(async () => {
        return {} as IAllVaultStats;
      });

      const config = new Config(Promise.resolve(db), walletKeys);
      await config.load();
      await myVault.load();

      // The signed creation survives a crash before RPC submission.
      const broadcast = vi.spyOn(client.rpc.author, 'submitAndWatchExtrinsic').mockResolvedValueOnce(() => undefined);
      let unbroadcastCreation;
      try {
        unbroadcastCreation = await myVault.createNew({ masterXpubPath: DEFAULT_MASTER_XPUB_PATH, vaultSetup });
      } finally {
        broadcast.mockRestore();
      }
      expect(unbroadcastCreation.tx.status).toBe(TransactionStatus.Submitted);
      await transactionTracker.shutdown();
      await bitcoinLocks.shutdown();
      myVault.unsubscribe();
      await db.transactionsTable.markExpiredWaitingForBlock(unbroadcastCreation.tx);

      transactionTracker = new TransactionTracker(Promise.resolve(db), miningFrames.blockWatch);
      bitcoinLocks = trackBitcoinLocks(
        new BitcoinLocks(Promise.resolve(db), walletKeys, miningFrames.blockWatch, currency, transactionTracker),
      );
      mintingAuthorities = new MintingAuthorities(Promise.resolve(db), walletKeys, miningFrames, transactionTracker);
      myVault = new MyVault(
        Promise.resolve(db),
        vaults,
        walletKeys,
        transactionTracker,
        bitcoinLocks,
        miningFrames,
        globalCouncil,
        mintingAuthorities,
      );
      bitcoinLockCreate = new BitcoinLockCreate(
        bitcoinLocks,
        transactionTracker,
        currency,
        new UpstreamOperatorClient(),
      );
      await myVault.load();
      const restoredCreation = myVault.getTxInfoByType(ExtrinsicType.VaultCreate)!;
      expect(restoredCreation.getStatus().error?.message).toBe('Transaction expired waiting for block inclusion');
      await expect(restoredCreation.txResult.waitForInFirstBlock).rejects.toThrow('Transaction expired');
      await expect(restoredCreation.txResult.waitForFinalizedBlock).rejects.toThrow('Transaction expired');

      // Insufficient ARGNOT must roll back the vault and delegate setup together.
      const failedCreation = await myVault.createNew({
        masterXpubPath: DEFAULT_MASTER_XPUB_PATH,
        vaultSetup,
      });
      await expect(failedCreation.waitForPostProcessing).rejects.toThrow();
      expect(myVault.createdVault).toBeNull();
      expect(await MyVaultRecovery.findOperatorVault(clients, BitcoinNetwork.Regtest, walletKeys)).toBeUndefined();

      await sudoFundWallet({
        address: walletKeys.vaultingAddress,
        microgons: 100_000_000n,
        micronots: 100_000_000n,
        archiveUrl: mainchainUrl,
      });
      const signer = await walletKeys.getVaultingKeypair();
      const nextNonce = await client.rpc.system.accountNextIndex(signer.address);
      const nonceQuery = vi
        .spyOn(client.rpc.system, 'accountNextIndex')
        .mockImplementation(vi.fn().mockResolvedValue(nextNonce));
      let vaultCreation;
      try {
        // A remote RPC may not yet see this app's pending transaction.
        const transfer = await transactionTracker.submitAndWatch({
          client,
          tx: client.tx.balances.transferKeepAlive(signer.address, 1_000_000n),
          txSigner: signer,
          extrinsicType: ExtrinsicType.Transfer,
          useLatestNonce: true,
        });
        vaultCreation = await myVault.createNew({
          masterXpubPath: DEFAULT_MASTER_XPUB_PATH,
          vaultSetup,
        });
        expect(vaultCreation.tx.txNonce).toBe(transfer.tx.txNonce! + 1);
        await transfer.txResult.waitForFinalizedBlock;
      } finally {
        nonceQuery.mockRestore();
      }
      await vaultCreation.txResult.waitForFinalizedBlock;
      vaultCreationFees = vaultCreation.txResult.finalFee ?? 0n;
      expect(vaultCreation.tx.metadataJson.masterXpubPath).toBe(DEFAULT_MASTER_XPUB_PATH);
      vaultCreatedBlockNumber = vaultCreation.txResult.blockNumber!;
      await vaultCreation.waitForPostProcessing;
      expect(vaultCreation.tx.id).not.toBe(unbroadcastCreation.tx.id);
      expect((await db.transactionsTable.fetchAll()).find(tx => tx.id === unbroadcastCreation.tx.id)?.status).toBe(
        TransactionStatus.TimedOutWaitingForBlock,
      );
      const createdVault = myVault.createdVault!;
      expect(createdVault).toBeTruthy();
      expect(createdVault.vaultId).toBeGreaterThan(0);
      expect(createdVault.securitization).toBe(vaultSetup.securitizationMicrogons);
      expect(myVault.data.argonotCommitment.heldMicronots).toBe(vaultSetup.committedMicronots);
      const commitment = await Vault.getArgonotSecuritization(await clients.get(false), createdVault.vaultId);
      expect(commitment?.heldMicronots).toBe(vaultSetup.committedMicronots);
      expect(createdVault.operatorAccountId).toBe(walletKeys.vaultingAddress);
      const spec = client.runtimeVersion.specVersion.toNumber();
      expect(spec).toBe(Number(process.env.ARGON_TEST_RUNTIME_SPEC ?? 161));
      expect(createdVault.bitcoinCapacityMicrogons()).toBe(vaultSetup.securitizationMicrogons);
      if (spec === 160) expect(createdVault.securitizationRatio?.toNumber()).toBe(1);
      else expect(createdVault.securitizationRatio).toBeUndefined();
      const delegateAddress = await walletKeys.getVaultDelegateKeypair().then(x => x.address);
      const delegateBalance = await client.query.system.account(delegateAddress).then(x => x.data.free);
      expect(createdVault.delegateAccountId).toBe(delegateAddress);
      expect(delegateBalance).toBeGreaterThanOrEqual(minimumVaultDelegateBalance);

      const recovery = MyVaultRecovery.findOperatorVault(clients, BitcoinNetwork.Regtest, walletKeys);
      await expect(recovery).resolves.toBeTruthy();
      const { vault, masterXpubPath, txFee, createBlockNumber } = (await recovery)!;

      expect(txFee).toBe(vaultCreationFees);
      expect(createBlockNumber).toBe(vaultCreatedBlockNumber);
      expect(vault).toMatchObject({
        vaultId: createdVault.vaultId,
        operatorAccountId: createdVault.operatorAccountId,
        securitization: createdVault.securitization,
        securitizationTarget: createdVault.securitizationTarget,
        terms: createdVault.terms,
        delegateAccountId: createdVault.delegateAccountId,
      });
      expect(masterXpubPath).toBe(DEFAULT_MASTER_XPUB_PATH);
      vaultId = vault.vaultId;
    },
  );

  it('recovers vault details without local signing keys', async () => {
    const readonlyWalletKeys = createMockWalletKeys(mnemonic, { canSign: false, canAccessServer: false });
    const deriveBitcoinKey = vi
      .spyOn(readonlyWalletKeys, 'getBitcoinChildXpriv')
      .mockRejectedValue(new Error('Wallet encryption key is unavailable'));

    const recovered = await MyVaultRecovery.findOperatorVault(clients, BitcoinNetwork.Regtest, readonlyWalletKeys);

    expect(recovered?.vault.vaultId).toBe(vaultId);
    expect(recovered?.masterXpubPath).toBe(DEFAULT_MASTER_XPUB_PATH);
    expect(deriveBitcoinKey).not.toHaveBeenCalled();
  });

  it(
    'should be able to recover vault details after creating a personal bitcoin lock',
    {
      timeout: 60e3,
    },
    async () => {
      const bitcoinLocks = myVault.bitcoinLocks;
      const availableBitcoinSpace = myVault.createdVault!.availableBitcoinSpace();
      const targetLiquidity = (availableBitcoinSpace * 4n) / 5n;
      expect(targetLiquidity).toBeGreaterThan(0n);

      // Create a personal bitcoin lock (previously done by activateSecuritizationAndTreasury)
      const lockTxInfo = await bitcoinLockCreate.submit({
        satoshis: await bitcoinLocks.satoshisForArgonLiquidity(targetLiquidity),
        vault: myVault.createdVault!,
        txSigner: await walletKeys.getLiquidLockingKeypair(),
      });
      const trackedLockTxInfo = lockTxInfo;
      await trackedLockTxInfo.txResult.waitForFinalizedBlock;
      const lockCreatedBlockNumber = trackedLockTxInfo.txResult.blockNumber!;
      await trackedLockTxInfo.waitForPostProcessing;

      expect(bitcoinLocks.getActiveLocks()).toHaveLength(1);
      const bitcoinStored = bitcoinLocks.getActiveLocks()[0];
      expect(bitcoinStored.createdAtArgonBlock).toBe(lockCreatedBlockNumber);

      // recover again so we get the right securitization
      const recovery = await MyVaultRecovery.findOperatorVault(clients, BitcoinNetwork.Regtest, walletKeys);
      expect(recovery).toBeTruthy();
      const { vault: recoveredVault } = recovery!;

      // check bitcoin
      const newDb = await createTestDb();
      trackedDbs.push(newDb);
      const blockWatch = trackBlockWatch(new BlockWatch(clients));
      const transactionTracker2 = new TransactionTracker(Promise.resolve(newDb), blockWatch);
      const bitcoinLocksRecovery = trackBitcoinLocks(
        new BitcoinLocks(Promise.resolve(newDb), walletKeys, blockWatch, myVault.vaults.currency, transactionTracker2),
      );
      await bitcoinLocksRecovery.load();
      expect(Object.keys(bitcoinLocksRecovery.data.locksByLockId)).toHaveLength(1);

      const bitcoins = await bitcoinLocksRecovery.syncCurrentLocks();
      expect(bitcoins).toHaveLength(1);
      const bitcoin = bitcoins[0];
      expect(bitcoinLocksRecovery.getLockById(bitcoin.lockId)?.scriptDetails).toEqual(bitcoinStored.scriptDetails);

      const client = await clients.get(false);
      const treasuryBondLots = await TreasuryBonds.getBondLots(
        client,
        recoveredVault.vaultId,
        recoveredVault.operatorAccountId,
      );
      expect(treasuryBondLots).toEqual([]);
    },
  );

  it('finalizes settings, bond lots and ARGNOT securitization', { timeout: 180e3 }, async () => {
    const client = await clients.get(false);
    const signer = await walletKeys.getVaultingKeypair();
    await sudoFundWallet({ address: signer.address, microgons: 1_000_000_000n, micronots: 100_000_000n, client });
    const settings = { ...vaultSetup, btcFlatFee: 2_000_000n, btcPctFee: 1.5 };
    const settingsTx = await myVault.updateSettings({
      terms: {
        bitcoinBaseFee: settings.btcFlatFee,
        bitcoinAnnualPercentRate: BigNumber(settings.btcPctFee).div(100),
      },
      txProgressCallback: () => undefined,
    });
    await settingsTx?.waitForPostProcessing;
    const updatedVault = await Vault.get(client, vaultId);
    const updatedTerms = updatedVault.pendingTerms?.[1] ?? updatedVault.terms;
    expect(updatedTerms.bitcoinBaseFee).toBe(2_000_000n);
    expect(updatedTerms.bitcoinAnnualPercentRate.toNumber()).toBe(0.015);
    const publishedTerms = myVault.createdVault!.pendingTerms?.[1] ?? myVault.createdVault!.terms;
    expect(publishedTerms.bitcoinBaseFee).toBe(updatedTerms.bitcoinBaseFee);
    expect(publishedTerms.bitcoinAnnualPercentRate.toNumber()).toBe(0.015);
    const commitment = await myVault.setVaultSecuritization({ committedMicronots: 20_000_000n });
    await commitment.waitForPostProcessing;
    expect(myVault.data.argonotCommitment.heldMicronots).toBe(20_000_000n);
    expect(myVault.argonotSecuritizationTarget).toBe(20_000_000n);

    const spec = client.runtimeVersion.specVersion.toNumber();
    if (spec === 160) {
      const existing = await Vault.get(client, vaultId);
      existing.securitizationRatio = BigNumber(1.5);
      await submitAndFinalize(
        client,
        existing.buildModifyFundingTx(client, existing.securitizationTarget),
        await walletKeys.getVaultingKeypair(),
      );
      myVault.data.createdVault = await Vault.get(client, vaultId);
    }
    const minimumPurchase = client.consts.treasury.minimumArgonsPerContributor;
    const increased = await myVault.setVaultSecuritization({ securitizationMicrogons: minimumPurchase * 3n });
    await increased.waitForPostProcessing;
    expect(myVault.createdVault?.securitizationTarget).toBe(minimumPurchase * 3n);
    const fundedVault = await Vault.get(client, vaultId);
    expect(fundedVault.securitizationTarget).toBe(minimumPurchase * 3n);
    expect(myVault.createdVault?.bitcoinCapacityMicrogons(fundedVault.securitizationTarget)).toBe(
      spec === 160 ? minimumPurchase * 2n : minimumPurchase * 3n,
    );
    if (spec === 160) expect(fundedVault.securitizationRatio?.toNumber()).toBe(1.5);
    else expect(fundedVault.securitizationRatio).toBeUndefined();
    const additionalLock = await bitcoinLockCreate.submit({
      satoshis: await myVault.bitcoinLocks.satoshisForArgonLiquidity(
        (myVault.createdVault!.availableBitcoinSpace() * 4n) / 5n,
      ),
      vault: myVault.createdVault!,
      txSigner: await walletKeys.getLiquidLockingKeypair(),
    });
    await additionalLock.waitForPostProcessing;
    const purchase = await TreasuryBonds.buildBuyBondTx({ client, vaultId, bondPurchaseMicrogons: minimumPurchase });
    const purchaseVault = await Vault.get(client, vaultId);
    const bought = await submitAndFinalize(client, purchase, signer);
    const purchaseApi = runtimeClient(await client.raw.at(await bought.waitForFinalizedBlock));
    const bonds = await TreasuryBonds.getBondLots(purchaseApi, vaultId, signer.address);
    expect(bonds).toHaveLength(1);
    expect(bonds[0]).toMatchObject({
      bonds: Number(minimumPurchase / 1_000_000n),
      owner: signer.address,
      isOwn: true,
    });
    if (purchaseVault.securitizationExitNoticeBlocks !== undefined) {
      const reduction = await myVault.setVaultSecuritization({ securitizationMicrogons: minimumPurchase });
      await reduction.waitForPostProcessing;
      const reducedVault = await Vault.get(client, vaultId);
      const reducedBonds = await TreasuryBonds.getVaultBondState(client, vaultId, signer.address);
      expect(
        TreasuryBonds.availableBondSpace({
          vault: reducedVault,
          capacityMicrogons: reducedVault.bondCapacityMicrogons(),
          bondState: reducedBonds,
        }),
      ).toBe(0n);
      await expect(submitAndFinalize(client, purchase, signer)).rejects.toMatchObject({
        errorCode: 'treasury.InsufficientBondSpace',
      });
      const cancellation = await myVault.setVaultSecuritization({ securitizationMicrogons: minimumPurchase * 3n });
      await cancellation.waitForPostProcessing;
      const restoredVault = await Vault.get(client, vaultId);
      expect(
        TreasuryBonds.availableBondSpace({
          vault: restoredVault,
          capacityMicrogons: restoredVault.bondCapacityMicrogons(),
          bondState: reducedBonds,
        }),
      ).toBe(minimumPurchase * 2n);
    }
    const released = await submitAndFinalize(
      client,
      await TreasuryBonds.buildReleaseBondLotTx({ client, bondLotId: bonds[0].id }),
      signer,
    );
    const releaseApi = runtimeClient(await client.raw.at(await released.waitForFinalizedBlock));
    const releasing = await TreasuryBonds.getBondLots(releaseApi, vaultId, signer.address);
    expect(releasing.find(lot => lot.id === bonds[0].id)).toMatchObject({ isReleasing: true });
    const previousArgonots = await Vault.getArgonotSecuritization(client, vaultId);
    expect(previousArgonots).toMatchObject({ committedMicronots: 0n, encumberedMicronots: 0n });

    // Unused ARGNOT backing releases immediately, even when reward commitments require notice.
    const reduced = await myVault.setVaultSecuritization({ committedMicronots: 1_000_000n });
    await reduced.waitForPostProcessing;
    expect(myVault.argonotSecuritizationTarget).toBe(1_000_000n);
    const finalizedVault = await Vault.get(client, vaultId);
    const argonots = await Vault.getArgonotSecuritization(client, vaultId);
    expect(argonots!.heldMicronots).toBe(1_000_000n);
    expect(myVault.data.argonotCommitment.heldMicronots).toBe(1_000_000n);
    expect(
      [...finalizedVault.securitizationReleaseSchedule.values()].reduce(
        (sum, entry) => sum + entry.argonotWithdrawals,
        0n,
      ),
    ).toBe(0n);
  });

  async function cleanupTrackedResources(): Promise<void> {
    await Promise.allSettled(trackedBitcoinLocks.map(x => x.shutdown()));
    trackedBitcoinLocks.length = 0;

    await Promise.allSettled(trackedMiningFrames.map(x => x.stop()));
    trackedMiningFrames.length = 0;

    for (const blockWatch of trackedBlockWatches) {
      blockWatch.destroy();
    }
    trackedBlockWatches.length = 0;

    await Promise.allSettled(trackedDbs.map(x => x.close()));
    trackedDbs.length = 0;

    await clients?.disconnect();
  }

  function trackBitcoinLocks(bitcoinLocks: BitcoinLocks): BitcoinLocks {
    trackedBitcoinLocks.push(bitcoinLocks);
    return bitcoinLocks;
  }

  function trackBlockWatch(blockWatch: BlockWatch): BlockWatch {
    trackedBlockWatches.push(blockWatch);
    return blockWatch;
  }

  function trackMiningFrames(miningFrames: MiningFrames): MiningFrames {
    trackedMiningFrames.push(miningFrames);
    return miningFrames;
  }
});
