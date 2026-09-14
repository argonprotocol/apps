import Path from 'node:path';
import docker from 'docker-compose';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { teardown } from '@argonprotocol/testing';
import { BitcoinLock, type Vault, MainchainClients, MoveTo, NetworkConfig } from '@argonprotocol/apps-core';
import {
  startArgonTestNetwork,
  type StartedArgonTestNetwork,
} from '@argonprotocol/apps-core/__test__/startArgonTestNetwork.js';
import { waitFor } from '@argonprotocol/apps-core/__test__/helpers/waitFor.ts';
import { sudoFundWallet } from '@argonprotocol/apps-core/__test__/helpers/sudoFundWallet.ts';
import {
  createBitcoinAddress,
  runBtcCli,
  sendBitcoinToAddress,
  waitForBitcoinTransactionConfirmations,
  waitForBitcoinTransactionOutputSatoshis,
} from '@argonprotocol/apps-core/__test__/helpers/bitcoinCli.ts';
import { setMainchainClients } from '../stores/mainchain.ts';
import { BitcoinLockStatus, type IBitcoinLockRecord } from '../lib/db/BitcoinLocksTable.ts';
import { BitcoinUtxoSpendStatus, BitcoinUtxoStatus } from '../lib/db/BitcoinUtxosTable.ts';
import { BitcoinReleaseStatus } from '../interfaces/IBitcoinReleaseRecord.ts';
import type { MyVault } from '../lib/MyVault.ts';
import {
  type BitcoinLocksClientHarness as ClientHarness,
  type BitcoinLocksHarness as TestHarness,
  createBitcoinLocksClientHarness,
  createBitcoinLocksHarness as createHarness,
  cleanupBitcoinLocksClientHarness,
  cleanupBitcoinLocksHarness as cleanupHarness,
  shutdownBitcoinLocksClientHarness,
  walletFundingMicrogons,
} from './helpers/bitcoinLocksHarness.ts';
import { MyVaultRecovery } from '../lib/recovery/MyVaultRecovery.ts';
import { BitcoinLockRelease } from '../lib/txs/BitcoinLock.release.ts';
import { createMockWalletKeys } from './helpers/wallet.ts';

const skipE2E = Boolean(JSON.parse(process.env.SKIP_E2E ?? '0'));

let clients: MainchainClients;
let network: StartedArgonTestNetwork;
let minerAddress: string;
let previousComposeProjectName: string | undefined;

afterAll(async () => {
  vi.restoreAllMocks();
  if (previousComposeProjectName === undefined) {
    delete process.env.COMPOSE_PROJECT_NAME;
  } else {
    process.env.COMPOSE_PROJECT_NAME = previousComposeProjectName;
  }
  await teardown();
});

describe.skipIf(skipE2E).sequential('BitcoinLocks integration', { timeout: 240e3 }, () => {
  beforeAll(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    network = await startArgonTestNetwork(Path.basename(import.meta.filename), {
      profiles: ['bob', 'price-oracle'],
      chainStartTimeoutMs: 120_000,
      chainStartPollMs: 250,
    });

    clients = new MainchainClients(network.archiveUrl);
    setMainchainClients(clients);
    NetworkConfig.setNetwork('dev-docker');
    previousComposeProjectName = process.env.COMPOSE_PROJECT_NAME;
    process.env.COMPOSE_PROJECT_NAME = network.composeEnv.COMPOSE_PROJECT_NAME;

    await waitFor(
      90e3,
      'price oracle update',
      async () => {
        const client = await clients.get(false);
        const current = await client.query.priceIndex.current();
        if (!current || current.btcUsdPrice.isLessThanOrEqualTo(0)) return;
        if (current.argonUsdPrice.isLessThanOrEqualTo(0)) return;
        if (current.tick <= 0) return;
        return true;
      },
      { pollMs: 1e3 },
    );
    minerAddress = createBitcoinAddress();
  }, 240e3);

  it('imports multiple confirmed funding UTXOs from the current runtime into the app model', async () => {
    const operator = await createHarness({
      archiveUrl: network.archiveUrl,
      esploraHost: network.networkConfigOverride.esploraHost,
      network: 'dev-docker',
    });

    try {
      const ownerWalletKeys = createMockWalletKeys();
      const owner = await createBitcoinLocksClientHarness({
        archiveUrl: network.archiveUrl,
        esploraHost: network.networkConfigOverride.esploraHost,
        network: 'dev-docker',
        walletKeys: ownerWalletKeys,
      });
      let ownerCleanupRequired = true;

      try {
        await sudoFundWallet({
          address: ownerWalletKeys.defaultArgonAddress,
          microgons: walletFundingMicrogons,
          micronots: 0n,
          archiveUrl: network.archiveUrl,
        });

        const lock = await createLock(owner, operator.myVault.createdVault!);
        const fundingAddress = owner.bitcoinLocks.formatP2wshAddress(lock.scriptDetails!.p2wshScriptHashHex);
        const runtimeClient = await clients.get(false);
        const watchedAddress = await runtimeClient.query.bitcoinUtxos.utxoAddressByLockId(lock.lockId!);
        expect(watchedAddress).toMatchObject({ lockId: lock.lockId });
        expect(watchedAddress && `0x0020${watchedAddress.scriptPubkey.value.wscriptHash.replace('0x', '')}`).toBe(
          lock.scriptDetails!.p2wshScriptHashHex,
        );

        const { firstSatoshis, secondSatoshis, expectedTxids } = await fundLockWithTwoConfirmedUtxos(
          owner,
          lock,
          fundingAddress,
        );
        const runtimeLock = await BitcoinLock.get(runtimeClient, lock.lockId!);
        expect(await runtimeClient.query.bitcoinUtxos.utxoRefsByLockId(lock.lockId!)).toHaveLength(2);
        expect(runtimeLock?.fundingUtxos.map(utxo => utxo.utxoRef.txid).sort()).toEqual(expectedTxids);
        if (!runtimeLock) throw new Error(`Runtime Bitcoin lock ${lock.lockId} disappeared after funding`);
        expect(runtimeLock.fundedSatoshis).toBe(lock.securitizedSatoshis);
        expect(runtimeLock.fundingUtxos.map(utxo => utxo.satoshis).sort()).toEqual(
          [firstSatoshis, secondSatoshis].sort(),
        );

        const appLock = await waitFor(30e3, 'app multi-UTXO funding', () => {
          const current = owner.bitcoinLocks.getLockById(lock.lockId!);
          if (current?.status !== BitcoinLockStatus.LockFunded) return;
          if (current?.fundingUtxoIds.length !== 2) return;
          if (current.fundedSatoshis !== lock.securitizedSatoshis) return;
          return current;
        });
        expect(
          owner.bitcoinLocks
            .getFundingUtxos(appLock)
            .map(utxo => utxo.txid)
            .sort(),
        ).toEqual(expectedTxids);

        const [persistedLock, persistedUtxos] = await Promise.all([
          owner.db.bitcoinLocksTable.getByLockId(lock.lockId!),
          owner.db.bitcoinUtxosTable.fetchByLockId(lock.lockId!),
        ]);
        expect(persistedLock).toMatchObject({
          fundedSatoshis: lock.securitizedSatoshis,
          fundingUtxoIds: appLock.fundingUtxoIds,
        });
        expect(
          persistedUtxos
            .filter(utxo => utxo.status === BitcoinUtxoStatus.FundingUtxo)
            .map(utxo => utxo.txid)
            .sort(),
        ).toEqual(expectedTxids);

        const db = owner.db;
        await shutdownBitcoinLocksClientHarness(owner);
        ownerCleanupRequired = false;

        let restarted: ClientHarness | undefined;
        try {
          restarted = await createBitcoinLocksClientHarness({
            archiveUrl: network.archiveUrl,
            esploraHost: network.networkConfigOverride.esploraHost,
            network: 'dev-docker',
            walletKeys: ownerWalletKeys,
            db,
          });
          const restoredLock = restarted.bitcoinLocks.getLockById(lock.lockId!);
          expect(restoredLock).toMatchObject({
            fundedSatoshis: lock.securitizedSatoshis,
            fundingUtxoIds: appLock.fundingUtxoIds,
          });
          expect(
            restoredLock &&
              restarted.bitcoinLocks
                .getFundingUtxos(restoredLock)
                .map(utxo => utxo.txid)
                .sort(),
          ).toEqual(expectedTxids);
        } finally {
          if (restarted) await cleanupBitcoinLocksClientHarness(restarted);
          else await db.close();
        }
      } finally {
        if (ownerCleanupRequired) await cleanupBitcoinLocksClientHarness(owner);
      }
    } finally {
      await cleanupHarness(operator);
    }
  }, 300e3);

  it('releases multiple accepted funding UTXOs through one durable workflow', async () => {
    const operator = await createHarness({
      archiveUrl: network.archiveUrl,
      esploraHost: network.networkConfigOverride.esploraHost,
      network: 'dev-docker',
    });

    try {
      const ownerWalletKeys = createMockWalletKeys();
      const owner = await createBitcoinLocksClientHarness({
        archiveUrl: network.archiveUrl,
        esploraHost: network.networkConfigOverride.esploraHost,
        network: 'dev-docker',
        walletKeys: ownerWalletKeys,
      });
      let ownerCleanupRequired = true;

      try {
        await sudoFundWallet({
          address: ownerWalletKeys.defaultArgonAddress,
          microgons: walletFundingMicrogons,
          micronots: 0n,
          archiveUrl: network.archiveUrl,
        });

        const lock = await createLock(owner, operator.myVault.createdVault!);
        const fundingAddress = owner.bitcoinLocks.formatP2wshAddress(lock.scriptDetails!.p2wshScriptHashHex);
        await fundLockWithTwoConfirmedUtxos(owner, lock, fundingAddress);
        const fundedLock = await waitFor(30e3, 'app multi-UTXO funding before release', () => {
          const current = owner.bitcoinLocks.getLockById(lock.lockId!);
          if (current?.status !== BitcoinLockStatus.LockFunded) return;
          if (current?.fundingUtxoIds.length !== 2) return;
          if (current.fundedSatoshis !== lock.securitizedSatoshis) return;
          return current;
        });
        const inputUtxoIds = [...fundedLock.fundingUtxoIds];

        const destinationAddress = createBitcoinAddress();
        const bitcoinNetworkFee = await owner.bitcoinLocks.calculateBitcoinNetworkFee(
          fundedLock,
          5n,
          destinationAddress,
        );
        const operation = new BitcoinLockRelease(owner.bitcoinLocks, owner.transactionTracker);
        await operation.load();
        const txInfo = await operation.submit({
          lockId: fundedLock.lockId!,
          toScriptPubkey: destinationAddress,
          bitcoinNetworkFee,
          txSigner: await owner.walletKeys.getLiquidLockingKeypair(),
        });
        await txInfo.txResult.waitForFinalizedBlock;
        await txInfo.waitForPostProcessing;

        const requestedRelease = owner.bitcoinLocks.releases.getActiveForLock(fundedLock);
        expect(requestedRelease).toMatchObject({
          status: BitcoinReleaseStatus.WaitingForVaultCosign,
          inputUtxoIds,
          bitcoinNetworkFee,
        });
        if (!requestedRelease) throw new Error(`Bitcoin lock ${fundedLock.lockId} has no active release`);
        expect(owner.bitcoinLocks.releases.getInputUtxos(requestedRelease)).toHaveLength(2);

        const db = owner.db;
        await shutdownBitcoinLocksClientHarness(owner);
        ownerCleanupRequired = false;

        let restarted: ClientHarness | undefined;
        try {
          restarted = await createBitcoinLocksClientHarness({
            archiveUrl: network.archiveUrl,
            esploraHost: network.networkConfigOverride.esploraHost,
            network: 'dev-docker',
            walletKeys: ownerWalletKeys,
            db,
          });
          const restoredLock = getCurrentLock(restarted, fundedLock.lockId!);
          const restoredRelease = restarted.bitcoinLocks.releases.getActiveForLock(restoredLock);
          expect(restoredRelease).toMatchObject({
            id: requestedRelease.id,
            status: BitcoinReleaseStatus.WaitingForVaultCosign,
            inputUtxoIds,
          });

          await collectVaultSignatureFromAlert(operator.myVault, 0);
          const archiveClient = await restarted.clients.archiveClientPromise;
          const broadcastingRelease = await waitFor(60e3, 'multi-input release broadcast', async () => {
            await restarted!.bitcoinLocks.releases.syncLockVaultCosign(restoredLock, archiveClient);
            await restarted!.bitcoinLocks.releases.reconcileLockRelease(restoredLock, false);
            const current = restarted!.bitcoinLocks.releases.getActiveForLock(restoredLock);
            if (current?.statusError) throw new Error(current.statusError);
            if (!current?.bitcoinTxid || current.status !== BitcoinReleaseStatus.ConfirmingOnBitcoin) return;
            return current;
          });
          expect(broadcastingRelease.vaultSignatures).toHaveLength(2);
          expect(restarted.bitcoinLocks.releases.getInputUtxos(broadcastingRelease)).toHaveLength(2);
          if (!broadcastingRelease.bitcoinTxid) throw new Error('Multi-input release has no Bitcoin transaction ID');

          const bitcoinTxid = broadcastingRelease.bitcoinTxid.replace('0x', '').match(/../g)!.reverse().join('');
          await waitForBitcoinTransactionOutputSatoshis({
            flowName: 'BitcoinLocks.integration.multiUtxoRelease',
            txid: bitcoinTxid,
            address: destinationAddress,
            minimumSatoshis: 1n,
            minerAddress,
            timeoutMs: 30e3,
            pollMs: 500,
          });
          await waitForBitcoinTransactionConfirmations({
            flowName: 'BitcoinLocks.integration.multiUtxoRelease',
            txid: bitcoinTxid,
            minimumConfirmations: 8,
            minerAddress,
            mineMode: 'missing',
            timeoutMs: 30e3,
            pollMs: 500,
          });

          const runtimeClient = await restarted.clients.get(false);
          expect(await BitcoinLock.get(runtimeClient, restoredLock.lockId!)).toBeUndefined();
          expect(await BitcoinLock.getReleaseRequest(runtimeClient, restoredLock.lockId!)).toBeUndefined();

          const completed = await waitFor(90e3, 'multi-input release completed on Argon', async () => {
            await restarted!.bitcoinLocks.releases.reconcileLockRelease(restoredLock, true);
            const currentLock = restarted!.bitcoinLocks.getLockById(restoredLock.lockId!);
            const currentRelease = restarted!.bitcoinLocks.releases.getById(broadcastingRelease.id);
            if (currentRelease?.statusError) throw new Error(currentRelease.statusError);
            if (currentLock?.status !== BitcoinLockStatus.Released) return;
            if (currentRelease?.status !== BitcoinReleaseStatus.Complete) return;
            return { currentLock, currentRelease };
          });
          expect(completed.currentLock.activeReleaseId).toBeUndefined();
          expect(completed.currentRelease.bitcoinTxid).toBe(broadcastingRelease.bitcoinTxid);
          expect(restarted.bitcoinLocks.releases.getInputUtxos(completed.currentRelease)).toEqual([
            expect.objectContaining({
              id: inputUtxoIds[0],
              spendStatus: BitcoinUtxoSpendStatus.Spent,
              spentByReleaseId: completed.currentRelease.id,
            }),
            expect.objectContaining({
              id: inputUtxoIds[1],
              spendStatus: BitcoinUtxoSpendStatus.Spent,
              spentByReleaseId: completed.currentRelease.id,
            }),
          ]);
          expect(await db.bitcoinReleasesTable.getById(completed.currentRelease.id)).toMatchObject({
            status: BitcoinReleaseStatus.Complete,
            inputUtxoIds,
            bitcoinTxid: broadcastingRelease.bitcoinTxid,
          });
        } finally {
          if (restarted) await cleanupBitcoinLocksClientHarness(restarted);
          else await db.close();
        }
      } finally {
        if (ownerCleanupRequired) await cleanupBitcoinLocksClientHarness(owner);
      }
    } finally {
      await cleanupHarness(operator);
    }
  }, 420e3);

  it('claims a deposit first detected while a lock release request is pending', async () => {
    const operator = await createHarness({
      archiveUrl: network.archiveUrl,
      esploraHost: network.networkConfigOverride.esploraHost,
      network: 'dev-docker',
    });

    try {
      const ownerWalletKeys = createMockWalletKeys();
      const owner = await createBitcoinLocksClientHarness({
        archiveUrl: network.archiveUrl,
        esploraHost: network.networkConfigOverride.esploraHost,
        network: 'dev-docker',
        walletKeys: ownerWalletKeys,
      });

      try {
        await sudoFundWallet({
          address: ownerWalletKeys.defaultArgonAddress,
          microgons: walletFundingMicrogons,
          micronots: 0n,
          archiveUrl: network.archiveUrl,
        });

        const lock = await createLock(owner, operator.myVault.createdVault!);
        const fundingAddress = owner.bitcoinLocks.formatP2wshAddress(lock.scriptDetails!.p2wshScriptHashHex);
        await fundLockWithTwoConfirmedUtxos(owner, lock, fundingAddress);
        const fundedLock = await waitFor(30e3, 'app funding before release request', () => {
          const current = owner.bitcoinLocks.getLockById(lock.lockId!);
          if (current?.status !== BitcoinLockStatus.LockFunded || current.fundingUtxoIds.length !== 2) return;
          return current;
        });

        const releaseDestination = createBitcoinAddress();
        const releaseNetworkFee = await owner.bitcoinLocks.calculateBitcoinNetworkFee(
          fundedLock,
          5n,
          releaseDestination,
        );
        const releaseOperation = new BitcoinLockRelease(owner.bitcoinLocks, owner.transactionTracker);
        await releaseOperation.load();
        const releaseTx = await releaseOperation.submit({
          lockId: fundedLock.lockId!,
          toScriptPubkey: releaseDestination,
          bitcoinNetworkFee: releaseNetworkFee,
          txSigner: await owner.walletKeys.getLiquidLockingKeypair(),
        });
        await releaseTx.txResult.waitForFinalizedBlock;
        await releaseTx.waitForPostProcessing;
        expect(owner.bitcoinLocks.releases.getActiveForLock(fundedLock)?.status).toBe(
          BitcoinReleaseStatus.WaitingForVaultCosign,
        );

        const txid = sendBitcoinToAddress(fundingAddress, lock.securitizedSatoshis);
        const sentSatoshis = await waitForBitcoinTransactionOutputSatoshis({
          flowName: 'BitcoinLocks.integration.pendingReleaseOrphanClaim',
          txid,
          address: fundingAddress,
          minimumSatoshis: lock.securitizedSatoshis,
          minerAddress,
          timeoutMs: 30e3,
          pollMs: 500,
        });
        expect(sentSatoshis).toBe(lock.securitizedSatoshis);

        const currentLock = getCurrentLock(owner, lock.lockId!);
        const observedFunding = await waitFor(30e3, 'release-window deposit observed by the app', async () => {
          return await owner.bitcoinLocks.utxoTracking.observeMempoolFunding(currentLock);
        });
        const canonicalTxid = observedFunding.txid;
        if (!canonicalTxid) throw new Error('Observed release-window deposit has no canonical txid.');

        await waitForBitcoinTransactionConfirmations({
          flowName: 'BitcoinLocks.integration.pendingReleaseOrphanClaim',
          txid,
          minimumConfirmations: 8,
          minerAddress,
          mineMode: 'missing',
          timeoutMs: 30e3,
          pollMs: 500,
        });

        const orphan = await waitFor(
          90e3,
          'release-window deposit recorded as orphan',
          async () => {
            const chainClient = await clients.get(false);
            await owner.bitcoinLocks.utxoTracking.syncPendingFundingSignals(currentLock, chainClient);
            return owner.bitcoinLocks.utxoTracking
              .getUnresolvedOrphanRecords([currentLock])
              .find(record => record.txid === canonicalTxid);
          },
          { pollMs: 1e3 },
        );
        expect(orphan.status).toBe(BitcoinUtxoStatus.Orphaned);
        expect(orphan.satoshis).toBe(lock.securitizedSatoshis);

        const returnDestination = createBitcoinAddress();
        const bitcoinNetworkFee = await owner.bitcoinLocks.calculateBitcoinNetworkFee(
          currentLock,
          5n,
          returnDestination,
        );
        const returnTx = await owner.bitcoinOrphanRelease.submit({
          lock: currentLock,
          record: orphan,
          toScriptPubkey: returnDestination,
          bitcoinNetworkFee,
          txSigner: await owner.walletKeys.getLiquidLockingKeypair(),
        });
        await returnTx.txResult.waitForFinalizedBlock;

        await collectVaultSignatureFromAlert(operator.myVault, 1);

        const cosignedRelease = await waitFor(
          60e3,
          'orphan cosign recovered by owner',
          async () => {
            await owner.bitcoinLocks.releases.recoverPendingOrphanCosignEvents(
              owner.miningFrames.blockWatch.bestBlockHeader.blockNumber,
            );
            const current = owner.bitcoinLocks.utxoTracking.getUtxoRecord(
              currentLock.lockId!,
              orphan.txid,
              orphan.vout,
            );
            if (!current) return;
            const release = owner.bitcoinLocks.releases.getActiveForUtxo(current);
            if (release?.statusError) throw new Error(release.statusError);
            if (!release?.vaultSignatures.length) return;
            return release;
          },
          { pollMs: 1e3 },
        );
        await owner.bitcoinLocks.releases.reconcileOrphanReleases(currentLock);

        const returningRelease = await waitFor(
          60e3,
          'orphan return seen on bitcoin',
          () => {
            const current = owner.bitcoinLocks.utxoTracking.getUtxoRecord(
              currentLock.lockId!,
              orphan.txid,
              orphan.vout,
            );
            if (!current) return;
            const release = owner.bitcoinLocks.releases.getActiveForUtxo(current);
            if (release?.statusError) throw new Error(release.statusError);
            if (!release?.bitcoinTxid) return;
            return release;
          },
          { pollMs: 1e3 },
        );

        await waitForBitcoinTransactionOutputSatoshis({
          flowName: 'BitcoinLocks.integration.pendingReleaseOrphanClaim',
          txid: returningRelease.bitcoinTxid!,
          address: returnDestination,
          minimumSatoshis: 1n,
          minerAddress,
          timeoutMs: 30e3,
          pollMs: 500,
        });
        await waitForBitcoinTransactionConfirmations({
          flowName: 'BitcoinLocks.integration.pendingReleaseOrphanClaim',
          txid: returningRelease.bitcoinTxid!,
          minimumConfirmations: 8,
          minerAddress,
          mineMode: 'missing',
          timeoutMs: 30e3,
          pollMs: 500,
        });

        const completed = await waitFor(90e3, 'orphan return completed', () => {
          const current = owner.bitcoinLocks.utxoTracking.getUtxoRecord(currentLock.lockId!, orphan.txid, orphan.vout);
          if (!current || current.spendStatus !== BitcoinUtxoSpendStatus.Spent) return;
          const release = owner.bitcoinLocks.releases.getById(cosignedRelease.id);
          if (release?.status !== BitcoinReleaseStatus.Complete) return;
          if (owner.bitcoinLocks.utxoTracking.getUnresolvedOrphanRecords([currentLock]).length) return;
          if (operator.myVault.data.pendingOrphanCosignCount !== 0) return;
          if (operator.myVault.collectBuilder.getNotice()?.orphanSignatureCount) return;
          return { current, release };
        });

        const persisted = await owner.db.bitcoinUtxosTable.getByLockOutpoint(
          completed.current.lockId,
          completed.current.txid,
          completed.current.vout,
        );
        expect(persisted).toMatchObject({
          status: BitcoinUtxoStatus.Orphaned,
          spendStatus: BitcoinUtxoSpendStatus.Spent,
          spentByReleaseId: completed.release.id,
        });
        expect(await owner.db.bitcoinReleasesTable.getById(completed.release.id)).toMatchObject({
          status: BitcoinReleaseStatus.Complete,
          bitcoinTxid: returningRelease.bitcoinTxid,
          vaultSignatures: cosignedRelease.vaultSignatures,
        });
      } finally {
        await cleanupBitcoinLocksClientHarness(owner);
      }
    } finally {
      await cleanupHarness(operator);
    }
  }, 420e3);

  describe('with the indexer stopped', () => {
    let harness: TestHarness;
    let activeLock: IBitcoinLockRecord;

    beforeAll(async () => {
      harness = await createHarness({
        archiveUrl: network.archiveUrl,
        esploraHost: network.networkConfigOverride.esploraHost,
        network: 'dev-docker',
      });
      activeLock = await createLock(harness, harness.myVault.createdVault!);

      await docker.stopOne('indexer', {
        config: ['docker-compose.yml', 'indexer.docker-compose.yml'],
        cwd: Path.resolve(import.meta.dirname, '../../e2e/argon'),
        env: network.composeEnv,
      });
      await waitFor(15e3, 'indexer shutdown', async () => {
        try {
          await globalThis.fetch(NetworkConfig.get().indexerHost, { signal: AbortSignal.timeout(1_000) });
        } catch {
          return true;
        }
      });
    }, 120e3);

    afterAll(async () => {
      await cleanupHarness(harness);
    });

    it('recovers the vault from chain data', async () => {
      const recovered = await MyVaultRecovery.findOperatorVault(
        clients,
        harness.bitcoinLocks.bitcoinNetwork,
        harness.walletKeys,
      );

      expect(recovered?.vault.vaultId).toBe(harness.myVault.createdVault?.vaultId);
      expect(recovered?.createBlockNumber).toBeGreaterThan(0);
    });

    it('restores an active lock into a fresh database and can start another lock', async () => {
      const recovered = await createBitcoinLocksClientHarness({
        archiveUrl: network.archiveUrl,
        esploraHost: network.networkConfigOverride.esploraHost,
        network: 'dev-docker',
        walletKeys: harness.walletKeys,
      });

      try {
        const restoredLock = recovered.bitcoinLocks.getLockById(activeLock.lockId!);
        expect(restoredLock).toBeTruthy();
        expect(restoredLock?.isHistoryRecoveryPending).not.toBe(true);
        expect(recovered.bitcoinLocks.getActiveLocks().map(lock => lock.lockId)).toContain(activeLock.lockId);

        const remainingLiquidity = harness.myVault.createdVault!.availableBitcoinSpace();
        expect(remainingLiquidity).toBeGreaterThan(0n);
        const satoshis = await recovered.bitcoinLocks.satoshisForArgonLiquidity(remainingLiquidity / 2n);
        const txInfo = await recovered.bitcoinLockCreate.submit({
          satoshis,
          vault: harness.myVault.createdVault!,
          txSigner: await recovered.walletKeys.getLiquidLockingKeypair(),
        });
        const pendingLock = recovered.bitcoinLocks.getLockByUuid(txInfo.tx.metadataJson.bitcoin.uuid)!;
        await txInfo.txResult.waitForFinalizedBlock;
        await txInfo.waitForPostProcessing;

        const newLock = recovered.bitcoinLocks.getAllLocks().find(lock => lock.uuid === pendingLock.uuid);
        expect(newLock?.lockId).toBeDefined();
        const activeLockIds = recovered.bitcoinLocks.getActiveLocks().map(lock => lock.lockId);
        expect(activeLockIds).toContain(activeLock.lockId);
        expect(activeLockIds).toContain(newLock?.lockId);
      } finally {
        await cleanupBitcoinLocksClientHarness(recovered);
      }
    });
  });
});

async function fundLockWithTwoConfirmedUtxos(
  owner: ClientHarness,
  lock: IBitcoinLockRecord,
  fundingAddress: string,
): Promise<{ firstSatoshis: bigint; secondSatoshis: bigint; expectedTxids: string[] }> {
  const firstSatoshis = lock.securitizedSatoshis / 3n;
  const secondSatoshis = lock.securitizedSatoshis - firstSatoshis;
  expect(firstSatoshis).toBeGreaterThan(546n);
  expect(secondSatoshis).toBeGreaterThan(546n);

  const firstTxid = sendBitcoinToAddress(fundingAddress, firstSatoshis);
  const secondTxid = sendBitcoinToAddress(fundingAddress, secondSatoshis);
  for (const [txid, satoshis] of [
    [firstTxid, firstSatoshis],
    [secondTxid, secondSatoshis],
  ] as const) {
    await waitForBitcoinTransactionOutputSatoshis({
      flowName: 'BitcoinLocks.integration.multiUtxoFunding',
      txid,
      address: fundingAddress,
      minimumSatoshis: satoshis,
      minerAddress,
      timeoutMs: 30e3,
      pollMs: 500,
    });
  }
  for (const txid of [firstTxid, secondTxid]) {
    await waitForBitcoinTransactionConfirmations({
      flowName: 'BitcoinLocks.integration.multiUtxoFunding',
      txid,
      minimumConfirmations: 8,
      minerAddress,
      mineMode: 'missing',
      timeoutMs: 30e3,
      pollMs: 500,
    });
  }

  const transactionBitcoinHeights = [firstTxid, secondTxid].map(txid => {
    const transaction = JSON.parse(runBtcCli(['getrawtransaction', txid, 'true'])) as { blockhash: string };
    const block = JSON.parse(runBtcCli(['getblockheader', transaction.blockhash])) as { height: number };
    return block.height;
  });
  const latestFundingBitcoinHeight = Math.max(...transactionBitcoinHeights);
  const runtimeClient = await owner.clients.get(false);
  await waitFor(60e3, 'runtime confirmed Bitcoin funding height', async () => {
    const tip = await runtimeClient.query.bitcoinUtxos.confirmedBitcoinBlockTip();
    if (!tip || tip.blockHeight < latestFundingBitcoinHeight) return;
    return tip;
  });
  await waitFor(60e3, 'runtime synchronized Bitcoin funding height', async () => {
    const tip = await runtimeClient.query.bitcoinUtxos.synchedBitcoinBlock();
    if (!tip || tip.blockHeight < latestFundingBitcoinHeight) return;
    return tip;
  });

  const expectedTxids = [firstTxid, secondTxid].map(txid => `0x${txid.match(/../g)!.reverse().join('')}`).sort();
  return { firstSatoshis, secondSatoshis, expectedTxids };
}

async function createLock(
  harness: ClientHarness,
  vault: Vault,
  microgonLiquidity?: bigint,
): Promise<IBitcoinLockRecord> {
  const availableBitcoinSpace = vault.availableBitcoinSpace();
  const targetLiquidity = microgonLiquidity ?? (availableBitcoinSpace * 4n) / 5n;
  expect(targetLiquidity).toBeGreaterThan(0n);
  const client = await harness.clients.get(false);
  const microgonsAtTargetPerBtc = (await client.query.bitcoinLocks.microgonPerBtcHistory()).at(-1)?.[1];
  expect(microgonsAtTargetPerBtc).toBeGreaterThan(0n);
  if (!microgonsAtTargetPerBtc) throw new Error('No eligible Bitcoin rate is available for the test lock.');
  const satoshis = await harness.bitcoinLocks.satoshisForArgonLiquidity(targetLiquidity, microgonsAtTargetPerBtc);

  const txInfo = await harness.bitcoinLockCreate.submit({
    satoshis,
    vault,
    microgonsAtTargetPerBtc,
    txSigner: await harness.walletKeys.getLiquidLockingKeypair(),
  });
  const pendingLock = harness.bitcoinLocks.getLockByUuid(txInfo.tx.metadataJson.bitcoin.uuid)!;

  await txInfo.txResult.waitForFinalizedBlock;
  await txInfo.waitForPostProcessing;

  const lock = Object.values(harness.bitcoinLocks.data.locksByLockId).find(record => record.uuid === pendingLock.uuid);
  expect(lock?.status).toBe(BitcoinLockStatus.LockPendingFunding);
  if (!lock) throw new Error('Finalized bitcoin lock was not published.');
  return lock;
}

async function collectVaultSignatureFromAlert(
  operatorVault: MyVault,
  expectedOrphanSignatureCount: number,
): Promise<void> {
  const notice = await waitFor(30e3, 'vault signature alert', () => {
    const current = operatorVault.collectBuilder.getNotice();
    if (!current?.signatureCount) return;
    if (current.orphanSignatureCount !== expectedOrphanSignatureCount) return;
    return current;
  });

  expect(notice.signatureCount).toBeGreaterThanOrEqual(1);
  expect(notice.orphanSignatureCount).toBe(expectedOrphanSignatureCount);

  const collectTx = await operatorVault.collect({ moveTo: MoveTo.DefaultArgon });
  if (!collectTx) throw new Error('Expected the vault signature alert to produce a collect transaction.');
  await collectTx.txResult.waitForFinalizedBlock;
}

function getCurrentLock(harness: ClientHarness, lockId: number): IBitcoinLockRecord {
  const lock = harness.bitcoinLocks.getLockById(lockId);
  if (!lock) {
    throw new Error(`Missing current lock ${lockId}`);
  }
  return lock;
}
