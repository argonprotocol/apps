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
  generateBlocks as mineBitcoinBlocks,
  sendBitcoinToAddress,
  waitForBitcoinTransactionConfirmations,
  waitForBitcoinTransactionOutputSatoshis,
} from '@argonprotocol/apps-core/__test__/helpers/bitcoinCli.ts';
import { setMainchainClients } from '../stores/mainchain.ts';
import { BitcoinLockStatus, type IBitcoinLockRecord } from '../lib/db/BitcoinLocksTable.ts';
import { BitcoinUtxoStatus } from '../lib/db/BitcoinUtxosTable.ts';
import type { MyVault } from '../lib/MyVault.ts';
import {
  type BitcoinLocksClientHarness as ClientHarness,
  type BitcoinLocksHarness as TestHarness,
  createBitcoinLocksClientHarness,
  createBitcoinLocksHarness as createHarness,
  cleanupBitcoinLocksClientHarness,
  cleanupBitcoinLocksHarness as cleanupHarness,
  walletFundingMicrogons,
} from './helpers/bitcoinLocksHarness.ts';
import { MyVaultRecovery } from '../lib/recovery/MyVaultRecovery.ts';
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

  it('claims a late deposit to an expired lock through a separate vault operator', async () => {
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
        const initializedChainLock = await BitcoinLock.get(await clients.get(false), lock.utxoId!);
        expect(initializedChainLock).toBeTruthy();
        const expirationHeight = initializedChainLock!.fundingExpirationHeight;

        await waitFor(
          60e3,
          'lock expiration height',
          async () => {
            const chainClient = await clients.get(false);
            const currentBitcoinHeight = await chainClient.query.bitcoinUtxos
              .confirmedBitcoinBlockTip()
              .then(x => x?.blockHeight ?? 0);
            if (currentBitcoinHeight >= expirationHeight) return true;
            mineBitcoinBlocks(expirationHeight - currentBitcoinHeight, minerAddress);
            return;
          },
          { pollMs: 1e3 },
        );

        const expiredChainLock = await waitFor(90e3, 'expired lock securitization released', async () => {
          const chainClient = await clients.get(false);
          const current = await BitcoinLock.get(chainClient, lock.utxoId!);
          if (current?.securitizedSatoshis !== 0n) return;
          return current;
        });
        expect(expiredChainLock.utxoId).toBe(lock.utxoId);

        const fundingAddress = owner.bitcoinLocks.formatP2wshAddress(lock.scriptDetails!.p2wshScriptHashHex);
        const txid = sendBitcoinToAddress(fundingAddress, lock.securitizedSatoshis);
        const sentSatoshis = await waitForBitcoinTransactionOutputSatoshis({
          flowName: 'BitcoinLocks.integration.lateOrphanClaim',
          txid,
          address: fundingAddress,
          minimumSatoshis: lock.securitizedSatoshis,
          minerAddress,
          timeoutMs: 30e3,
          pollMs: 500,
        });
        expect(sentSatoshis).toBe(lock.securitizedSatoshis);

        const currentLock = getCurrentLock(owner, lock.utxoId!);
        const observedFunding = await waitFor(30e3, 'late deposit observed by the app', async () => {
          return await owner.bitcoinLocks.utxoTracking.observeMempoolFunding(currentLock);
        });
        const canonicalTxid = observedFunding.txid;
        if (!canonicalTxid) throw new Error('Observed late deposit has no canonical txid.');

        await waitForBitcoinTransactionConfirmations({
          flowName: 'BitcoinLocks.integration.lateOrphanClaim',
          txid,
          minimumConfirmations: 8,
          minerAddress,
          mineMode: 'missing',
          timeoutMs: 30e3,
          pollMs: 500,
        });

        const orphan = await waitFor(
          90e3,
          'late deposit recorded as orphan',
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

        const cosignedOrphan = await waitFor(
          60e3,
          'orphan cosign recovered by owner',
          async () => {
            await owner.bitcoinLocks.orphanReleases.recoverPendingCosignEvents(
              owner.miningFrames.blockWatch.bestBlockHeader.blockNumber,
            );
            const current = owner.bitcoinLocks.utxoTracking.getUtxoRecord(
              currentLock.utxoId!,
              orphan.txid,
              orphan.vout,
            );
            if (current?.statusError) throw new Error(current.statusError);
            if (!current?.releaseCosignVaultSignature) return;
            return current;
          },
          { pollMs: 1e3 },
        );
        await owner.bitcoinLocks.orphanReleases.reconcileOrphanReturns(currentLock);

        const returningOrphan = await waitFor(
          60e3,
          'orphan return seen on bitcoin',
          () => {
            const current = owner.bitcoinLocks.utxoTracking.getUtxoRecord(
              currentLock.utxoId!,
              cosignedOrphan.txid,
              cosignedOrphan.vout,
            );
            if (current?.statusError) throw new Error(current.statusError);
            if (!current?.releaseTxid) return;
            return current;
          },
          { pollMs: 1e3 },
        );

        await waitForBitcoinTransactionOutputSatoshis({
          flowName: 'BitcoinLocks.integration.lateOrphanClaim',
          txid: returningOrphan.releaseTxid!,
          address: returnDestination,
          minimumSatoshis: 1n,
          minerAddress,
          timeoutMs: 30e3,
          pollMs: 500,
        });
        await waitForBitcoinTransactionConfirmations({
          flowName: 'BitcoinLocks.integration.lateOrphanClaim',
          txid: returningOrphan.releaseTxid!,
          minimumConfirmations: 8,
          minerAddress,
          mineMode: 'missing',
          timeoutMs: 30e3,
          pollMs: 500,
        });

        const completed = await waitFor(90e3, 'orphan return completed', () => {
          const current = owner.bitcoinLocks.utxoTracking.getUtxoRecord(currentLock.utxoId!, orphan.txid, orphan.vout);
          if (current?.status !== BitcoinUtxoStatus.ReleaseComplete) return;
          if (owner.bitcoinLocks.utxoTracking.getUnresolvedOrphanRecords([currentLock]).length) return;
          if (operator.myVault.data.pendingOrphanCosignCount !== 0) return;
          if (operator.myVault.collectBuilder.getNotice()?.orphanSignatureCount) return;
          return current;
        });

        const persisted = await owner.db.bitcoinUtxosTable.getByLockOutpoint(
          completed.lockUtxoId,
          completed.txid,
          completed.vout,
        );
        expect(persisted).toBeTruthy();
        expect(persisted?.status).toBe(BitcoinUtxoStatus.ReleaseComplete);
        expect(persisted?.releaseTxid).toBe(completed.releaseTxid);
        expect(persisted?.releaseCosignVaultSignature).toBeTruthy();
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
        const restoredLock = recovered.bitcoinLocks.getLockByUtxoId(activeLock.utxoId!);
        expect(restoredLock).toBeTruthy();
        expect(restoredLock?.isHistoryRecoveryPending).not.toBe(true);
        expect(recovered.bitcoinLocks.getActiveLocks().map(lock => lock.utxoId)).toContain(activeLock.utxoId);

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
        expect(newLock?.utxoId).toBeDefined();
        const activeUtxoIds = recovered.bitcoinLocks.getActiveLocks().map(lock => lock.utxoId);
        expect(activeUtxoIds).toContain(activeLock.utxoId);
        expect(activeUtxoIds).toContain(newLock?.utxoId);
      } finally {
        await cleanupBitcoinLocksClientHarness(recovered);
      }
    });
  });
});

async function createLock(
  harness: ClientHarness,
  vault: Vault,
  microgonLiquidity?: bigint,
): Promise<IBitcoinLockRecord> {
  const availableBitcoinSpace = vault.availableBitcoinSpace();
  const targetLiquidity = microgonLiquidity ?? (availableBitcoinSpace * 4n) / 5n;
  expect(targetLiquidity).toBeGreaterThan(0n);
  const satoshis = await harness.bitcoinLocks.satoshisForArgonLiquidity(targetLiquidity);

  const txInfo = await harness.bitcoinLockCreate.submit({
    satoshis,
    vault,
    txSigner: await harness.walletKeys.getLiquidLockingKeypair(),
  });
  const pendingLock = harness.bitcoinLocks.getLockByUuid(txInfo.tx.metadataJson.bitcoin.uuid)!;

  await txInfo.txResult.waitForFinalizedBlock;
  await txInfo.waitForPostProcessing;

  const lock = Object.values(harness.bitcoinLocks.data.locksByUtxoId).find(record => record.uuid === pendingLock.uuid);
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

function getCurrentLock(harness: ClientHarness, utxoId: number): IBitcoinLockRecord {
  const lock = harness.bitcoinLocks.getLockByUtxoId(utxoId);
  if (!lock) {
    throw new Error(`Missing current lock ${utxoId}`);
  }
  return lock;
}
