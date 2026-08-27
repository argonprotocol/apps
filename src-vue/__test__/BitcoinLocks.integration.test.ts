import Path from 'node:path';
import docker from 'docker-compose';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { teardown } from '@argonprotocol/testing';
import { MainchainClients, MoveTo, NetworkConfig, BitcoinLock, Vault } from '@argonprotocol/apps-core';
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
import { BitcoinUtxoStatus, type IBitcoinUtxoRecord } from '../lib/db/BitcoinUtxosTable.ts';
import { createBitcoinLockProgressStore } from '../stores/bitcoinLockProgress.ts';
import type { Db } from '../lib/Db.ts';
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
        if (!current) return;
        if (current.btcUsdPrice.isLessThanOrEqualTo(0)) return;
        if (current.argonUsdPrice.isLessThanOrEqualTo(0)) return;
        if (current.tick <= 0) return;
        return true;
      },
      { pollMs: 1e3 },
    );
    minerAddress = createBitcoinAddress();
  }, 240e3);

  it('accepts a mismatch candidate and persists the accepted funding record on chain and in the db', async () => {
    const harness = await createHarness({
      archiveUrl: network.archiveUrl,
      esploraHost: network.networkConfigOverride.esploraHost,
      network: 'dev-docker',
    });
    const progress = createBitcoinLockProgressStore({
      myVault: harness.myVault,
      bitcoinLocks: harness.bitcoinLocks,
      miningFrames: harness.miningFrames,
    });

    try {
      const lock = await createLock(harness, harness.myVault.createdVault!);
      const stopTracking = progress.trackLock(lock);

      try {
        const accepted = await acceptMismatchFunding(harness, lock, progress);

        const dbLock = await harness.db.bitcoinLocksTable.getByUtxoId(accepted.lock.utxoId!);
        const dbUtxos = await getDbUtxosForLock(harness.db, accepted.lock.utxoId!);
        const dbAcceptedRecord = dbUtxos.find(record => record.id === dbLock?.fundingUtxoRecordId);
        expect(dbLock?.fundingUtxoRecordId).toBe(accepted.acceptedRecord.id);
        expect(dbAcceptedRecord?.status).toBe(BitcoinUtxoStatus.FundingUtxo);
        expect(dbAcceptedRecord?.txid).toBe(accepted.candidate.txid);
        expect(dbAcceptedRecord?.vout).toBe(accepted.candidate.vout);

        const chainClient = await clients.archiveClientPromise;
        const chainLock = await BitcoinLock.get(chainClient, accepted.lock.utxoId!);
        expect(chainLock).toBeTruthy();
        const chainFundingRef = await chainLock!.getFundingUtxoRef(chainClient);
        expect(chainFundingRef?.txid).toBe(accepted.candidate.txid);
        expect(chainFundingRef?.vout).toBe(accepted.candidate.vout);

        expect(harness.bitcoinLocks.getMismatchViewState(accepted.lock).phase).toBe('none');
      } finally {
        stopTracking();
      }
    } finally {
      await cleanupHarness(harness);
    }
  });

  it('returns an expired mismatch funding candidate and restores vault capacity on chain and in the db', async () => {
    const harness = await createHarness({
      archiveUrl: network.archiveUrl,
      esploraHost: network.networkConfigOverride.esploraHost,
      network: 'dev-docker',
    });
    const progress = createBitcoinLockProgressStore({
      myVault: harness.myVault,
      bitcoinLocks: harness.bitcoinLocks,
      miningFrames: harness.miningFrames,
    });

    try {
      const initialAvailableBitcoinSpace = harness.myVault.createdVault!.availableBitcoinSpace();
      const lock = await createLock(harness, harness.myVault.createdVault!);
      const stopTracking = progress.trackLock(lock);

      try {
        await returnExpiredMismatchAndWaitForChainRestore(harness, lock, progress, initialAvailableBitcoinSpace);
      } finally {
        stopTracking();
      }
    } finally {
      await cleanupHarness(harness);
    }
  });

  it('returns a mismatch funding candidate before expiry and leaves the lock ready to resume', async () => {
    const harness = await createHarness({
      archiveUrl: network.archiveUrl,
      esploraHost: network.networkConfigOverride.esploraHost,
      network: 'dev-docker',
    });
    const progress = createBitcoinLockProgressStore({
      myVault: harness.myVault,
      bitcoinLocks: harness.bitcoinLocks,
      miningFrames: harness.miningFrames,
    });

    try {
      const lock = await createLock(harness, harness.myVault.createdVault!);
      const reservedAvailableBitcoinSpace = harness.myVault.createdVault!.availableBitcoinSpace();
      const stopTracking = progress.trackLock(lock);

      try {
        const returned = await returnMismatchAndWaitForReadyToResume(
          harness,
          lock,
          progress,
          reservedAvailableBitcoinSpace,
        );
        expect(returned.lock.status).toBe(BitcoinLockStatus.LockFundingReadyToResume);

        await harness.bitcoinLocks.resumeWaitingForFunding(returned.lock);
        await waitFor(30e3, 'live mismatch return resume stays pending', async () => {
          const resumed = getCurrentLock(harness, returned.lock.utxoId!);
          progress.updateLock(resumed);
          const mismatchView = harness.bitcoinLocks.getMismatchViewState(resumed);
          if (resumed.status !== BitcoinLockStatus.LockPendingFunding) return;
          if (mismatchView.phase !== 'none') return;
          if (
            mismatchView.candidates.find(
              candidate =>
                candidate.record.id === returned.candidate.id ||
                (candidate.record.txid === returned.candidate.txid &&
                  candidate.record.vout === returned.candidate.vout),
            )?.returnRecord
          ) {
            return;
          }
          if (harness.myVault.createdVault?.availableBitcoinSpace() !== reservedAvailableBitcoinSpace) return;

          const chainClient = await clients.get(false);
          const chainLock = await BitcoinLock.get(chainClient, resumed.utxoId!);
          if (!chainLock) return;
          const chainFundingRef = await chainLock.getFundingUtxoRef(chainClient);
          if (chainFundingRef) return;
          const candidateRefs = await chainClient.query.bitcoinUtxos.candidateUtxoRefsByUtxoId(resumed.utxoId!);
          if (candidateRefs && Object.keys(candidateRefs).length > 0) return;

          return true;
        });
      } finally {
        stopTracking();
      }
    } finally {
      await cleanupHarness(harness);
    }
  });

  it('returns a mismatched deposit received before expiry through a separate vault operator', async () => {
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
        const progress = createBitcoinLockProgressStore({
          myVault: operator.myVault,
          bitcoinLocks: owner.bitcoinLocks,
          miningFrames: owner.miningFrames,
        });
        const stopTracking = progress.trackLock(lock);

        try {
          const observed = await observeMismatchCandidate(
            owner,
            lock,
            getMismatchFundingSatoshis(lock.satoshis),
            progress,
          );

          const expirationConfig = await BitcoinLock.getConfig(await clients.get(false));
          const orphaningBitcoinHeight =
            observed.lock.lockDetails.createdAtHeight + expirationConfig.pendingConfirmationExpirationBlocks + 1;

          const preExpiryClient = await clients.get(false);
          const preExpiryBitcoinHeight = await preExpiryClient.query.bitcoinUtxos
            .confirmedBitcoinBlockTip()
            .then(x => x?.blockHeight ?? 0);
          const preExpiryChainLock = await BitcoinLock.get(preExpiryClient, observed.lock.utxoId!);
          const preExpiryCandidates = await preExpiryClient.query.bitcoinUtxos.candidateUtxoRefsByUtxoId(
            observed.lock.utxoId!,
          );
          const candidateKey = JSON.stringify({
            txid: observed.candidate.txid,
            outputIndex: observed.candidate.vout,
          });
          const candidateWasRecordedBeforeExpiry = candidateKey in preExpiryCandidates;

          expect(preExpiryBitcoinHeight).toBeLessThan(orphaningBitcoinHeight);
          expect(preExpiryChainLock).toBeTruthy();
          expect(candidateWasRecordedBeforeExpiry).toBe(true);

          await waitFor(
            60e3,
            'separate operator lock expiration height',
            async () => {
              const chainClient = await clients.get(false);
              const currentBitcoinHeight = await chainClient.query.bitcoinUtxos
                .confirmedBitcoinBlockTip()
                .then(x => x?.blockHeight ?? 0);
              if (currentBitcoinHeight >= orphaningBitcoinHeight) return true;
              mineBitcoinBlocks(orphaningBitcoinHeight - currentBitcoinHeight, minerAddress);
              return;
            },
            { pollMs: 1e3 },
          );

          const orphan = await waitFor(
            90e3,
            'expired late deposit recorded as orphan',
            async () => {
              const currentLock = getCurrentLock(owner, lock.utxoId!);
              const chainClient = await clients.get(false);
              await owner.bitcoinLocks.utxoTracking.syncPendingFundingSignals(currentLock, chainClient);
              progress.updateLock(currentLock);
              return owner.bitcoinLocks.utxoTracking
                .getUnresolvedOrphanRecords([currentLock])
                .find(record => record.txid === observed.candidate.txid);
            },
            { pollMs: 1e3 },
          );
          expect(orphan.status).toBe(BitcoinUtxoStatus.Orphaned);
          expect(orphan.satoshis).toBe(observed.candidate.satoshis);

          const currentLock = getCurrentLock(owner, lock.utxoId!);
          await waitFor(90e3, 'expired chain lock removed', async () => {
            const chainClient = await clients.get(false);
            return !(await BitcoinLock.get(chainClient, currentLock.utxoId!));
          });
          expect(owner.bitcoinLocks.utxoTracking.getUnresolvedOrphanRecords([currentLock])).toContain(orphan);

          const returnDestination = createBitcoinAddress();
          const bitcoinNetworkFee = await owner.bitcoinLocks.calculateBitcoinNetworkFee(
            currentLock,
            5n,
            returnDestination,
          );
          const returnTx = await owner.bitcoinLocks.orphanReleases.requestOrphanReturn({
            lock: currentLock,
            record: orphan,
            toScriptPubkey: returnDestination,
            bitcoinNetworkFee,
          });
          expect(returnTx).toBeTruthy();
          await returnTx!.txResult.waitForFinalizedBlock;

          await collectVaultSignatureFromAlert(operator.myVault, 1);

          const returningOrphan = await waitFor(
            120e3,
            'orphan return seen on bitcoin',
            async () => {
              await owner.bitcoinLocks.orphanReleases.recoverPendingCosignEvents(
                owner.miningFrames.blockWatch.bestBlockHeader.blockNumber,
              );
              const current = owner.bitcoinLocks.utxoTracking.getUtxoRecord(
                currentLock.utxoId!,
                orphan.txid,
                orphan.vout,
              );
              if (!current?.releaseTxid) return;
              return current;
            },
            { pollMs: 1e3 },
          );
          await waitForBitcoinTransactionOutputSatoshis({
            flowName: 'BitcoinLocks.integration.orphanReturn',
            txid: returningOrphan.releaseTxid!,
            address: returnDestination,
            minimumSatoshis: 1n,
            minerAddress,
            timeoutMs: 30e3,
            pollMs: 500,
          });
          await waitForBitcoinTransactionConfirmations({
            flowName: 'BitcoinLocks.integration.orphanReturn',
            txid: returningOrphan.releaseTxid!,
            minimumConfirmations: 8,
            minerAddress,
            mineMode: 'missing',
            timeoutMs: 30e3,
            pollMs: 500,
          });

          await waitFor(90e3, 'orphan return completed', () => {
            const current = owner.bitcoinLocks.utxoTracking.getUtxoRecord(
              currentLock.utxoId!,
              orphan.txid,
              orphan.vout,
            );
            if (current?.status !== BitcoinUtxoStatus.ReleaseComplete) return;
            if (owner.bitcoinLocks.utxoTracking.getUnresolvedOrphanRecords([currentLock]).length) return;
            if (operator.myVault.data.pendingOrphanCosignCount !== 0) return;
            if (operator.myVault.collectBuilder.getNotice()?.orphanSignatureCount) return;
            return current;
          });
        } finally {
          stopTracking();
        }
      } finally {
        await cleanupBitcoinLocksClientHarness(owner);
      }
    } finally {
      await cleanupHarness(operator);
    }
  }, 420e3);

  it('keeps a new funded lock isolated after a prior release and a prior mismatch return', async () => {
    const harness = await createHarness({
      archiveUrl: network.archiveUrl,
      esploraHost: network.networkConfigOverride.esploraHost,
      network: 'dev-docker',
    });
    const progress = createBitcoinLockProgressStore({
      myVault: harness.myVault,
      bitcoinLocks: harness.bitcoinLocks,
      miningFrames: harness.miningFrames,
    });

    try {
      const initialAvailableBitcoinSpace = harness.myVault.createdVault!.availableBitcoinSpace();
      const firstLock = await createLock(harness, harness.myVault.createdVault!);
      const firstStopTracking = progress.trackLock(firstLock);

      let firstReleasedRecordId = 0;
      let firstFundingTxid = '';
      let firstReleaseTxid = '';
      try {
        const fundedFirst = await acceptMismatchFunding(harness, firstLock, progress);
        await waitFor(30e3, 'vault available bitcoin space reduced after funding', () => {
          const availableBitcoinSpace = harness.myVault.createdVault!.availableBitcoinSpace();
          if (availableBitcoinSpace >= initialAvailableBitcoinSpace) return;
          return availableBitcoinSpace;
        });
        firstFundingTxid = fundedFirst.acceptedRecord.txid;

        const firstRelease = await releaseLockAndWaitForChainRestore(
          harness,
          fundedFirst.lock,
          progress,
          initialAvailableBitcoinSpace,
        );
        firstReleasedRecordId = firstRelease.fundingRecord.id;
        firstReleaseTxid = firstRelease.fundingRecord.releaseTxid ?? '';
      } finally {
        firstStopTracking();
      }

      const secondLock = await createLock(harness, harness.myVault.createdVault!);
      const secondStopTracking = progress.trackLock(secondLock);

      let secondReturnedRecordId = 0;
      let secondMismatchFundingTxid = '';
      let secondReturnTxid = '';
      try {
        const returnedSecond = await returnExpiredMismatchAndWaitForChainRestore(
          harness,
          secondLock,
          progress,
          initialAvailableBitcoinSpace,
        );
        secondReturnedRecordId = returnedSecond.record.id;
        secondMismatchFundingTxid = returnedSecond.txid;
        secondReturnTxid = returnedSecond.releaseTxid;

        await harness.bitcoinLocks.acknowledgeExpiredWaitingForFunding(returnedSecond.lock);
        await waitFor(30e3, 'expired mismatch return notice cleared', () => {
          const refreshed = getCurrentLock(harness, returnedSecond.lock.utxoId!);
          if (refreshed.status !== BitcoinLockStatus.LockExpiredWaitingForFundingAcknowledged) return;
          if (!harness.bitcoinLocks.isInactiveForVaultDisplay(refreshed)) return;
          const activeLocks = harness.bitcoinLocks.getActiveLocks();
          if (activeLocks.some(activeLock => activeLock.utxoId === refreshed.utxoId)) return;
          return true;
        });
      } finally {
        secondStopTracking();
      }

      const thirdLock = await createLock(harness, harness.myVault.createdVault!);
      const thirdStopTracking = progress.trackLock(thirdLock);

      try {
        const fundedThird = await acceptMismatchFunding(harness, thirdLock, progress);
        expect(fundedThird.acceptedRecord.id).not.toBe(firstReleasedRecordId);
        expect(fundedThird.acceptedRecord.id).not.toBe(secondReturnedRecordId);
        expect(fundedThird.acceptedRecord.txid).not.toBe(firstFundingTxid);
        expect(fundedThird.acceptedRecord.txid).not.toBe(secondMismatchFundingTxid);
        expect(harness.bitcoinLocks.getMismatchViewState(fundedThird.lock).nextCandidate?.returnRecord).toBeUndefined();

        const thirdRelease = await releaseLockAndWaitForChainRestore(
          harness,
          fundedThird.lock,
          progress,
          initialAvailableBitcoinSpace,
        );
        expect(thirdRelease.fundingRecord.id).not.toBe(firstReleasedRecordId);
        expect(thirdRelease.fundingRecord.id).not.toBe(secondReturnedRecordId);
        expect(thirdRelease.fundingRecord.releaseTxid).toBeTruthy();
        expect(thirdRelease.fundingRecord.releaseTxid).not.toBe(firstReleaseTxid);
        expect(thirdRelease.fundingRecord.releaseTxid).not.toBe(secondReturnTxid);
      } finally {
        thirdStopTracking();
      }
    } finally {
      await cleanupHarness(harness);
    }
  });

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
        const { pendingLock, txInfo } = await recovered.bitcoinLocks.initializeLock({
          satoshis,
          vault: harness.myVault.createdVault!,
        });
        await txInfo!.txResult.waitForFinalizedBlock;
        await txInfo!.waitForPostProcessing;

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

  const { pendingLock, txInfo } = await harness.bitcoinLocks.initializeLock({
    satoshis,
    vault,
  });
  expect(txInfo).toBeTruthy();

  await txInfo!.txResult.waitForFinalizedBlock;
  await txInfo!.waitForPostProcessing;

  const lock = Object.values(harness.bitcoinLocks.data.locksByUtxoId).find(record => record.uuid === pendingLock.uuid);
  expect(lock?.status).toBe(BitcoinLockStatus.LockPendingFunding);
  if (!lock) throw new Error('Finalized bitcoin lock was not published.');
  return lock;
}

async function observeMismatchCandidate(
  harness: ClientHarness,
  lock: IBitcoinLockRecord,
  satoshis: bigint,
  progress: ReturnType<typeof createBitcoinLockProgressStore>,
): Promise<{ lock: IBitcoinLockRecord; candidate: IBitcoinUtxoRecord; txid: string }> {
  await waitFor(
    20e3,
    'lock funding watch readiness',
    async () => {
      const chainClient = await clients.get(false);
      const currentBlock = Number((await chainClient.query.system.number()).toString());
      if (currentBlock <= lock.lockDetails.createdAtArgonBlock + 2) return;
      return true;
    },
    { pollMs: 500 },
  );

  const fundingAddress = harness.bitcoinLocks.formatP2wshAddress(lock.lockDetails.p2wshScriptHashHex);
  const txid = sendBitcoinToAddress(fundingAddress, satoshis);
  const sentSatoshis = await waitForBitcoinTransactionOutputSatoshis({
    flowName: 'BitcoinLocks.integration.funding',
    txid,
    address: fundingAddress,
    minimumSatoshis: satoshis,
    minerAddress,
    timeoutMs: 30e3,
    pollMs: 500,
  });
  expect(sentSatoshis).toBe(satoshis);
  await waitForBitcoinTransactionConfirmations({
    flowName: 'BitcoinLocks.integration.funding',
    txid,
    minimumConfirmations: 8,
    minerAddress,
    mineMode: 'missing',
    timeoutMs: 30e3,
    pollMs: 500,
  });

  const observed = await waitFor(
    120e3,
    'mismatch funding candidate',
    async () => {
      const currentLock = getCurrentLock(harness, lock.utxoId!);
      await harness.bitcoinLocks.utxoTracking.syncPendingFundingSignals(currentLock);
      progress.updateLock(currentLock);
      const mismatchView = harness.bitcoinLocks.getMismatchViewState(currentLock);
      const candidate = mismatchView.nextCandidate?.record;
      if (!candidate?.firstSeenOnArgonAt) return;
      if (mismatchView.phase === 'none') return;
      if (harness.bitcoinLocks.getLockProcessingDetails(currentLock).confirmations < 0) return;
      return { lock: currentLock, candidate };
    },
    { pollMs: 1e3 },
  );

  const dbLock = await harness.db.bitcoinLocksTable.getByUtxoId(observed.lock.utxoId!);
  const dbUtxos = await getDbUtxosForLock(harness.db, observed.lock.utxoId!);
  const dbCandidate = dbUtxos.find(
    record => record.txid === observed.candidate.txid && record.vout === observed.candidate.vout,
  );

  expect(dbLock?.fundingUtxoRecordId).toBeNull();
  expect(dbCandidate?.firstSeenOnArgonAt).toBeTruthy();
  expect(progress.lockProcessing.value.confirmations).toBeGreaterThanOrEqual(0);
  expect(progress.lockProcessing.value.expectedConfirmations).toBeGreaterThan(0);

  return { ...observed, txid };
}

function getMismatchReturnRecord(
  harness: TestHarness,
  lock: IBitcoinLockRecord,
  candidate: Pick<IBitcoinUtxoRecord, 'id'>,
): IBitcoinUtxoRecord | undefined {
  const mismatchRecord = harness.bitcoinLocks.getMismatchViewState(lock).candidates.find(view => {
    return view.record.id === candidate.id;
  })?.returnRecord;
  if (mismatchRecord) return mismatchRecord;

  const record = harness.bitcoinLocks.utxoTracking.getUtxoRecordById(candidate.id);
  return harness.bitcoinLocks.utxoTracking.isReleaseStatus(record?.status) ? record : undefined;
}

async function waitForMismatchReturnTracked(args: {
  timeoutMs: number;
  label: string;
  harness: TestHarness;
  lock: IBitcoinLockRecord;
  candidate: IBitcoinUtxoRecord;
  progress: ReturnType<typeof createBitcoinLockProgressStore>;
}): Promise<{ lock: IBitcoinLockRecord; record: IBitcoinUtxoRecord }> {
  return await waitFor(args.timeoutMs, args.label, () => {
    const refreshed = getCurrentLock(args.harness, args.lock.utxoId!);
    args.progress.updateLock(refreshed);

    const record = getMismatchReturnRecord(args.harness, refreshed, args.candidate);
    if (!record) return;

    if (record.status === BitcoinUtxoStatus.ReleaseIsProcessingOnArgon) {
      if (args.progress.orphanedReturnArgon.value.confirmations < 0) return;
      if (args.progress.orphanedReturnArgon.value.expectedConfirmations <= 0) return;
      return { lock: refreshed, record };
    }

    if (![BitcoinUtxoStatus.ReleaseIsProcessingOnBitcoin, BitcoinUtxoStatus.ReleaseComplete].includes(record.status)) {
      return;
    }
    if (!record.releaseTxid) return;

    return { lock: refreshed, record };
  });
}

async function waitForMismatchReturnSeenOnBitcoin(args: {
  timeoutMs: number;
  label: string;
  harness: TestHarness;
  lock: IBitcoinLockRecord;
  candidate: IBitcoinUtxoRecord;
  progress: ReturnType<typeof createBitcoinLockProgressStore>;
}): Promise<{ lock: IBitcoinLockRecord; record: IBitcoinUtxoRecord }> {
  return await waitFor(args.timeoutMs, args.label, () => {
    const refreshed = getCurrentLock(args.harness, args.lock.utxoId!);
    args.progress.updateLock(refreshed);

    const record = getMismatchReturnRecord(args.harness, refreshed, args.candidate);
    if (!record?.releaseTxid) return;

    if (record.status === BitcoinUtxoStatus.ReleaseComplete) {
      return { lock: refreshed, record };
    }

    if (record.status !== BitcoinUtxoStatus.ReleaseIsProcessingOnBitcoin) return;
    if (args.progress.orphanedReturnBitcoin.value.confirmations < 0) return;
    if (args.progress.orphanedReturnBitcoin.value.expectedConfirmations <= 0) return;

    return { lock: refreshed, record };
  });
}

async function returnMismatchAndWaitForReadyToResume(
  harness: TestHarness,
  lock: IBitcoinLockRecord,
  progress: ReturnType<typeof createBitcoinLockProgressStore>,
  expectedAvailableBitcoinSpace: bigint,
): Promise<{
  lock: IBitcoinLockRecord;
  candidate: IBitcoinUtxoRecord;
  record: IBitcoinUtxoRecord;
  txid: string;
  releaseTxid: string;
}> {
  const observed = await observeMismatchCandidate(harness, lock, getMismatchFundingSatoshis(lock.satoshis), progress);
  expect(observed.candidate.firstSeenOnArgonAt).toBeTruthy();
  const observedView = harness.bitcoinLocks.getMismatchViewState(observed.lock);
  const observedCandidateView = observedView.candidates.find(
    candidate => candidate.record.id === observed.candidate.id,
  );
  expect(observedCandidateView?.canReturn).toBe(true);
  expect(observedCandidateView?.canAccept).toBe(true);

  const returnDestination = createBitcoinAddress();
  const bitcoinNetworkFee = await harness.bitcoinLocks.calculateBitcoinNetworkFee(observed.lock, 5n, returnDestination);
  const returnTx = await harness.bitcoinLocks.orphanReleases.requestCandidateReturn({
    lock: observed.lock,
    candidateRecord: observed.candidate,
    toScriptPubkey: returnDestination,
    bitcoinNetworkFee,
  });
  expect(returnTx).toBeTruthy();
  await returnTx!.txResult.waitForInFirstBlock;

  await waitForMismatchReturnTracked({
    timeoutMs: 30e3,
    label: 'live mismatch return tracked',
    harness,
    lock: observed.lock,
    candidate: observed.candidate,
    progress,
  });

  await returnTx!.txResult.waitForFinalizedBlock;

  const seenOnBitcoin = await waitForMismatchReturnSeenOnBitcoin({
    timeoutMs: 60e3,
    label: 'live mismatch return seen on bitcoin',
    harness,
    lock: observed.lock,
    candidate: observed.candidate,
    progress,
  });

  const returnedSatoshis = await waitForBitcoinTransactionOutputSatoshis({
    flowName: 'BitcoinLocks.integration.liveOrphanReturn',
    txid: seenOnBitcoin.record.releaseTxid!,
    address: returnDestination,
    minimumSatoshis: 1n,
    minerAddress,
    timeoutMs: 30e3,
    pollMs: 500,
  });
  expect(returnedSatoshis).toBeGreaterThan(0n);

  await waitForBitcoinTransactionConfirmations({
    flowName: 'BitcoinLocks.integration.liveOrphanReturn',
    txid: seenOnBitcoin.record.releaseTxid!,
    minimumConfirmations: 1,
    minerAddress,
    mineMode: 'missing',
    timeoutMs: 30e3,
    pollMs: 500,
  });

  const completed = await waitFor(
    90e3,
    'live mismatch return finalized',
    async () => {
      const refreshed = getCurrentLock(harness, observed.lock.utxoId!);
      progress.updateLock(refreshed);
      const record = harness.bitcoinLocks.getMismatchViewState(refreshed).candidates.find(candidate => {
        return candidate.record.id === observed.candidate.id;
      })?.returnRecord;
      if (!record) return;
      if (refreshed.status !== BitcoinLockStatus.LockFundingReadyToResume) return;
      if (record.status !== BitcoinUtxoStatus.ReleaseComplete) return;
      if (!record.releaseTxid) return;
      if (record.releaseCosignHeight == null) return;
      if (!record.releaseCosignVaultSignature) return;
      if (harness.myVault.createdVault?.availableBitcoinSpace() !== expectedAvailableBitcoinSpace) return;

      const chainClient = await clients.get(false);
      const chainLock = await BitcoinLock.get(chainClient, refreshed.utxoId!);
      if (!chainLock) return;
      const chainFundingRef = await chainLock.getFundingUtxoRef(chainClient);
      if (chainFundingRef) return;

      const candidateRefs = await chainClient.query.bitcoinUtxos.candidateUtxoRefsByUtxoId(refreshed.utxoId!);
      if (candidateRefs && Object.keys(candidateRefs).length > 0) return;

      const pendingCosign = await chainClient.query.vaults.pendingCosignByVaultId(refreshed.vaultId);
      if (pendingCosign.length > 0) return;

      const vault = await chainClient.query.vaults.vaultsById(refreshed.vaultId);
      if (!vault) return;
      if (vault.securitizationLocked <= 0n) return;

      return { lock: refreshed, record };
    },
    { pollMs: 1e3 },
  );

  const dbLock = await harness.db.bitcoinLocksTable.getByUtxoId(completed.lock.utxoId!);
  const dbUtxos = await getDbUtxosForLock(harness.db, completed.lock.utxoId!);
  const dbReturnRecord = dbUtxos.find(record => record.id === completed.record.id);
  expect(dbLock?.fundingUtxoRecordId).toBeNull();
  expect(dbReturnRecord?.status).toBe(BitcoinUtxoStatus.ReleaseComplete);
  expect(dbReturnRecord?.releaseTxid).toBe(completed.record.releaseTxid);
  expect(dbReturnRecord?.releaseCosignHeight).toBe(completed.record.releaseCosignHeight);
  expect(dbReturnRecord?.releaseCosignVaultSignature).toBeTruthy();

  return {
    lock: completed.lock,
    candidate: observed.candidate,
    record: completed.record,
    txid: observed.txid,
    releaseTxid: completed.record.releaseTxid!,
  };
}

async function acceptMismatchFunding(
  harness: ClientHarness,
  lock: IBitcoinLockRecord,
  progress: ReturnType<typeof createBitcoinLockProgressStore>,
): Promise<{ lock: IBitcoinLockRecord; acceptedRecord: IBitcoinUtxoRecord; candidate: IBitcoinUtxoRecord }> {
  const observed = await observeMismatchCandidate(harness, lock, getMismatchFundingSatoshis(lock.satoshis), progress);
  const acceptTx = await harness.bitcoinLocks.acceptMismatchedFunding(observed.lock, observed.candidate);
  expect(acceptTx).toBeTruthy();
  await acceptTx!.txResult.waitForInFirstBlock;

  await waitFor(30e3, 'mismatch accept argon progress', () => {
    const status = acceptTx!.getStatus();
    if (status.confirmations < 0) return;
    if (status.expectedConfirmations <= 0) return;
    return true;
  });

  await acceptTx!.txResult.waitForFinalizedBlock;

  return await waitFor(45e3, 'accepted mismatch funding record', async () => {
    const currentLock = getCurrentLock(harness, observed.lock.utxoId!);
    progress.updateLock(currentLock);
    const acceptedRecord = harness.bitcoinLocks.getAcceptedFundingRecord(currentLock);
    if (!acceptedRecord) return;
    if (acceptedRecord.status !== BitcoinUtxoStatus.FundingUtxo) return;
    if (!harness.bitcoinLocks.isLockedStatus(currentLock)) return;

    const chainClient = await clients.get(false);
    const chainLock = await BitcoinLock.get(chainClient, currentLock.utxoId!);
    if (!chainLock) return;
    const chainFundingRef = await chainLock.getFundingUtxoRef(chainClient);
    if (chainFundingRef?.txid !== observed.candidate.txid) return;
    if (chainFundingRef?.vout !== observed.candidate.vout) return;
    const chainVault = await chainClient.query.vaults.vaultsById(currentLock.vaultId);
    if (!chainVault) return;
    if (chainVault.securitizationLocked <= 0n) return;

    return {
      lock: currentLock,
      acceptedRecord,
      candidate: observed.candidate,
    };
  });
}

async function returnExpiredMismatchAndWaitForChainRestore(
  harness: TestHarness,
  lock: IBitcoinLockRecord,
  progress: ReturnType<typeof createBitcoinLockProgressStore>,
  expectedAvailableBitcoinSpace: bigint,
): Promise<{
  lock: IBitcoinLockRecord;
  candidate: IBitcoinUtxoRecord;
  record: IBitcoinUtxoRecord;
  txid: string;
  releaseTxid: string;
}> {
  const observed = await observeMismatchCandidate(harness, lock, getMismatchFundingSatoshis(lock.satoshis), progress);
  const expirationConfig = await BitcoinLock.getConfig(await clients.get(false));
  const orphaningBitcoinHeight =
    observed.lock.lockDetails.createdAtHeight + expirationConfig.pendingConfirmationExpirationBlocks + 1;
  await waitFor(
    60e3,
    'bitcoin lock expiration height',
    async () => {
      const chainClient = await clients.get(false);
      const currentBitcoinHeight = await chainClient.query.bitcoinUtxos
        .confirmedBitcoinBlockTip()
        .then(x => x?.blockHeight ?? 0);
      if (currentBitcoinHeight >= orphaningBitcoinHeight) return true;
      mineBitcoinBlocks(orphaningBitcoinHeight - currentBitcoinHeight, minerAddress);
      return;
    },
    { pollMs: 1e3 },
  );

  const expired = await waitFor(
    90e3,
    'mismatch funding expiry',
    async () => {
      const currentLock = getCurrentLock(harness, observed.lock.utxoId!);
      await harness.bitcoinLocks.utxoTracking.syncPendingFundingSignals(currentLock);
      progress.updateLock(currentLock);
      const mismatchView = harness.bitcoinLocks.getMismatchViewState(currentLock);

      const currentCandidate =
        mismatchView.nextCandidate?.record.id === observed.candidate.id
          ? mismatchView.nextCandidate?.record
          : mismatchView.candidates.find(candidate => {
              return (
                candidate.record.txid === observed.candidate.txid && candidate.record.vout === observed.candidate.vout
              );
            })?.record;
      const currentCandidateView = mismatchView.candidates.find(candidate => {
        return candidate.record.id === currentCandidate?.id;
      });

      if (!harness.bitcoinLocks.isFundingWindowExpired(currentLock)) return;
      if (!currentCandidate) return;
      if (!currentCandidateView?.canReturn) return;
      if (
        ![
          BitcoinLockStatus.LockExpiredWaitingForFunding,
          BitcoinLockStatus.LockExpiredWaitingForFundingAcknowledged,
        ].includes(currentLock.status)
      ) {
        return;
      }

      const chainClient = await clients.get(false);
      const chainLock = await BitcoinLock.get(chainClient, currentLock.utxoId!);
      if (chainLock) return;

      const candidateRefs = await chainClient.query.bitcoinUtxos.candidateUtxoRefsByUtxoId(currentLock.utxoId!);
      if (candidateRefs && Object.keys(candidateRefs).length > 0) return;

      const pendingCosign = await chainClient.query.vaults.pendingCosignByVaultId(currentLock.vaultId);
      if (pendingCosign.length > 0) return;

      const vault = await chainClient.query.vaults.vaultsById(currentLock.vaultId);
      if (!vault) return;
      if (vault.securitizationLocked !== 0n) return;
      if (harness.myVault.createdVault?.availableBitcoinSpace() !== expectedAvailableBitcoinSpace) return;

      return {
        lock: currentLock,
        candidate: currentCandidate,
      };
    },
    { pollMs: 1e3 },
  );

  const returnDestination = createBitcoinAddress();
  const bitcoinNetworkFee = await harness.bitcoinLocks.calculateBitcoinNetworkFee(expired.lock, 5n, returnDestination);
  const returnTx = await harness.bitcoinLocks.orphanReleases.requestCandidateReturn({
    lock: expired.lock,
    candidateRecord: expired.candidate,
    toScriptPubkey: returnDestination,
    bitcoinNetworkFee,
  });
  expect(returnTx).toBeTruthy();
  await returnTx!.txResult.waitForInFirstBlock;

  await waitForMismatchReturnTracked({
    timeoutMs: 30e3,
    label: 'mismatch return tracked',
    harness,
    lock: expired.lock,
    candidate: expired.candidate,
    progress,
  });

  await returnTx!.txResult.waitForFinalizedBlock;

  const seenOnBitcoin = await waitForMismatchReturnSeenOnBitcoin({
    timeoutMs: 60e3,
    label: 'mismatch return seen on bitcoin',
    harness,
    lock: expired.lock,
    candidate: expired.candidate,
    progress,
  });

  const returnedSatoshis = await waitForBitcoinTransactionOutputSatoshis({
    flowName: 'BitcoinLocks.integration.orphanReturn',
    txid: seenOnBitcoin.record.releaseTxid!,
    address: returnDestination,
    minimumSatoshis: 1n,
    minerAddress,
    timeoutMs: 30e3,
    pollMs: 500,
  });
  expect(returnedSatoshis).toBeGreaterThan(0n);

  await waitForBitcoinTransactionConfirmations({
    flowName: 'BitcoinLocks.integration.orphanReturn',
    txid: seenOnBitcoin.record.releaseTxid!,
    minimumConfirmations: 8,
    minerAddress,
    mineMode: 'missing',
    timeoutMs: 30e3,
    pollMs: 500,
  });

  const completed = await waitFor(
    90e3,
    'mismatch return finalized',
    async () => {
      const refreshed = getCurrentLock(harness, expired.lock.utxoId!);
      progress.updateLock(refreshed);
      const record = getMismatchReturnRecord(harness, refreshed, expired.candidate);
      if (!record) return;
      if (record.status !== BitcoinUtxoStatus.ReleaseComplete) return;
      if (!record.releaseTxid) return;
      if (record.releaseCosignHeight == null) return;
      if (!record.releaseCosignVaultSignature) return;

      const chainClient = await clients.get(false);
      const chainLock = await BitcoinLock.get(chainClient, refreshed.utxoId!);
      if (chainLock) return;

      const mismatchView = harness.bitcoinLocks.getMismatchViewState(refreshed);
      if (mismatchView.candidates.some(candidate => candidate.record.id === expired.candidate.id)) return;
      if (
        refreshed.status !== BitcoinLockStatus.LockExpiredWaitingForFunding &&
        refreshed.status !== BitcoinLockStatus.LockExpiredWaitingForFundingAcknowledged
      ) {
        return;
      }

      const candidateRefs = await chainClient.query.bitcoinUtxos.candidateUtxoRefsByUtxoId(refreshed.utxoId!);
      if (candidateRefs && Object.keys(candidateRefs).length > 0) return;
      const pendingCosign = await chainClient.query.vaults.pendingCosignByVaultId(refreshed.vaultId);
      if (pendingCosign.length > 0) return;
      const vault = await chainClient.query.vaults.vaultsById(refreshed.vaultId);
      if (!vault) return;
      if (vault.securitizationLocked !== 0n) return;
      if (harness.myVault.createdVault?.availableBitcoinSpace() !== expectedAvailableBitcoinSpace) return;
      return { lock: refreshed, record };
    },
    { pollMs: 1e3 },
  );

  const dbLock = await harness.db.bitcoinLocksTable.getByUtxoId(completed.lock.utxoId!);
  const dbUtxos = await getDbUtxosForLock(harness.db, completed.lock.utxoId!);
  const dbReturnRecord = dbUtxos.find(record => record.id === completed.record.id);
  expect(dbLock?.fundingUtxoRecordId).toBeNull();
  expect(dbReturnRecord?.status).toBe(BitcoinUtxoStatus.ReleaseComplete);
  expect(dbReturnRecord?.releaseTxid).toBe(completed.record.releaseTxid);
  expect(dbReturnRecord?.releaseCosignHeight).toBe(completed.record.releaseCosignHeight);
  expect(dbReturnRecord?.releaseCosignVaultSignature).toBeTruthy();

  return {
    lock: completed.lock,
    candidate: observed.candidate,
    record: completed.record,
    txid: observed.txid,
    releaseTxid: completed.record.releaseTxid!,
  };
}

async function releaseLockAndWaitForChainRestore(
  harness: TestHarness,
  lock: IBitcoinLockRecord,
  progress: ReturnType<typeof createBitcoinLockProgressStore>,
  expectedAvailableBitcoinSpace: bigint,
): Promise<{ lock: IBitcoinLockRecord; fundingRecord: IBitcoinUtxoRecord }> {
  const currentLock = getCurrentLock(harness, lock.utxoId!);
  const releaseAddress = createBitcoinAddress();
  const bitcoinNetworkFee = await harness.bitcoinLocks.calculateBitcoinNetworkFee(currentLock, 5n, releaseAddress);
  const releaseTx = await harness.bitcoinLocks.requestBitcoinRelease({
    utxoId: currentLock.utxoId!,
    bitcoinNetworkFee,
    toScriptPubkey: releaseAddress,
  });
  expect(releaseTx).toBeTruthy();
  await releaseTx!.txResult.waitForInFirstBlock;

  await waitFor(30e3, 'release request tracked on argon', () => {
    const refreshed = getCurrentLock(harness, currentLock.utxoId!);
    progress.updateLock(refreshed);
    const label = progress.getUnlockProgressLabel(refreshed.status);
    if (!label.includes('Argon')) return;
    if (progress.getUnlockProgressPct(refreshed.status) <= 0) return;
    return true;
  });

  const seenOnBitcoin = await waitFor(120e3, 'release seen on bitcoin', () => {
    const refreshed = getCurrentLock(harness, currentLock.utxoId!);
    progress.updateLock(refreshed);
    const fundingRecord = harness.bitcoinLocks.getAcceptedFundingRecord(refreshed);
    if (!fundingRecord?.releaseTxid) return;
    if (fundingRecord.status !== BitcoinUtxoStatus.ReleaseIsProcessingOnBitcoin) return;
    const label = progress.getUnlockProgressLabel(refreshed.status);
    if (!label.includes('Bitcoin')) return;
    return { lock: refreshed, fundingRecord };
  });

  const releasedSatoshis = await waitForBitcoinTransactionOutputSatoshis({
    flowName: 'BitcoinLocks.integration.release',
    txid: seenOnBitcoin.fundingRecord.releaseTxid!,
    address: releaseAddress,
    minimumSatoshis: 1n,
    minerAddress,
    timeoutMs: 30e3,
    pollMs: 500,
  });
  expect(releasedSatoshis).toBeGreaterThan(0n);

  await waitForBitcoinTransactionConfirmations({
    flowName: 'BitcoinLocks.integration.release',
    txid: seenOnBitcoin.fundingRecord.releaseTxid!,
    minimumConfirmations: 8,
    minerAddress,
    mineMode: 'missing',
    timeoutMs: 30e3,
    pollMs: 500,
  });

  await waitFor(60e3, 'release finalized', () => {
    const refreshed = getCurrentLock(harness, currentLock.utxoId!);
    progress.updateLock(refreshed);
    const fundingRecord = harness.bitcoinLocks.getAcceptedFundingRecord(refreshed);
    if (!fundingRecord) return;
    if (refreshed.status !== BitcoinLockStatus.Released) return;
    return { lock: refreshed, fundingRecord };
  });

  await waitFor(90e3, 'chain release cleanup', async () => {
    const chainClient = await clients.get(false);
    const chainLock = await BitcoinLock.get(chainClient, currentLock.utxoId!);
    if (chainLock) return;
    const pendingCosign = await chainClient.query.vaults.pendingCosignByVaultId(currentLock.vaultId);
    const vault = await chainClient.query.vaults.vaultsById(currentLock.vaultId);
    if (!vault) return;
    if (vault.securitizationLocked !== 0n) return;
    if (pendingCosign.length > 0) return;
    if (harness.myVault.createdVault?.availableBitcoinSpace() !== expectedAvailableBitcoinSpace) return;
    return true;
  });

  return seenOnBitcoin;
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

async function getDbUtxosForLock(db: Db, lockUtxoId: number): Promise<IBitcoinUtxoRecord[]> {
  return (await db.bitcoinUtxosTable.fetchAll())
    .filter(record => record.lockUtxoId === lockUtxoId)
    .sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime());
}

function getMismatchFundingSatoshis(lockSatoshis: bigint): bigint {
  const mismatchDeltaSatoshis = lockSatoshis > 1_201n ? 1_200n : lockSatoshis - 1n;
  if (mismatchDeltaSatoshis < 1_001n) {
    throw new Error(`Lock amount ${lockSatoshis} sats is too small to create a real mismatch candidate`);
  }
  return lockSatoshis - mismatchDeltaSatoshis;
}
