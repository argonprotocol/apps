import Path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { BitcoinLock } from '@argonprotocol/mainchain';
import { teardown } from '@argonprotocol/testing';
import {
  Currency as CurrencyBase,
  type IAllVaultStats,
  MainchainClients,
  MiningFrames,
  NetworkConfig,
} from '@argonprotocol/apps-core';
import {
  startArgonTestNetwork,
  type StartedArgonTestNetwork,
} from '@argonprotocol/apps-core/__test__/startArgonTestNetwork.js';
import { waitFor } from '@argonprotocol/apps-core/__test__/helpers/waitFor.ts';
import {
  createBitcoinAddress,
  generateBlocks as mineBitcoinBlocks,
  sendBitcoinToAddress,
  waitForBitcoinTransactionConfirmations,
  waitForBitcoinTransactionOutputSatoshis,
} from '@argonprotocol/apps-core/__test__/helpers/bitcoinCli.ts';
import { sudoFundWallet } from '@argonprotocol/apps-core/__test__/helpers/sudoFundWallet.ts';
import { setMainchainClients } from '../stores/mainchain.ts';
import { createTestDb } from './helpers/db.ts';
import { createMockWalletKeys } from './helpers/wallet.ts';
import { Config } from '../lib/Config.ts';
import type IVaultingRules from '../interfaces/IVaultingRules.ts';
import { Vaults } from '../lib/Vaults.ts';
import { TransactionTracker } from '../lib/TransactionTracker.ts';
import BitcoinLocks from '../lib/BitcoinLocks.ts';
import BitcoinMempool from '../lib/BitcoinMempool.ts';
import { DEFAULT_MASTER_XPUB_PATH, MyVault } from '../lib/MyVault.ts';
import { BitcoinLockStatus, type IBitcoinLockRecord } from '../lib/db/BitcoinLocksTable.ts';
import { BitcoinUtxoStatus, type IBitcoinUtxoRecord } from '../lib/db/BitcoinUtxosTable.ts';
import { createBitcoinLockProgressStore } from '../stores/bitcoinLockProgress.ts';
import type { Db } from '../lib/Db.ts';
import type { WalletKeys } from '../lib/WalletKeys.ts';
import { setDbPromise } from '../stores/helpers/dbPromise.ts';

const skipE2E = Boolean(JSON.parse(process.env.SKIP_E2E ?? '0'));
const walletFundingMicrogons = 100_000_000n;
const defaultVaultRules: IVaultingRules = {
  ...(Config.getDefault('vaultingRules') as IVaultingRules),
  personalBtcPct: 0,
  securitizationRatio: 1,
  capitalForTreasuryPct: 50,
  capitalForSecuritizationPct: 50,
  baseMicrogonCommitment: 10_000_000n,
  baseMicronotCommitment: 0n,
  btcFlatFee: 100_000n,
  btcPctFee: 2.5,
  profitSharingPct: 5,
};

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
        const priceIndex = current.toJSON() as {
          btcUsdPrice?: string;
          argonUsdPrice?: string;
          tick?: string | number;
        };
        if (!priceIndex.btcUsdPrice || BigInt(priceIndex.btcUsdPrice) <= 0n) return;
        if (!priceIndex.argonUsdPrice || BigInt(priceIndex.argonUsdPrice) <= 0n) return;
        if (priceIndex.tick == null || BigInt(priceIndex.tick) <= 0n) return;
        return true;
      },
      { pollMs: 1e3 },
    );
    minerAddress = createBitcoinAddress();
  }, 240e3);

  it('accepts a mismatch candidate and persists the accepted funding record on chain and in the db', async () => {
    const harness = await createHarness();
    const progress = createBitcoinLockProgressStore({
      myVault: harness.myVault,
      bitcoinLocks: harness.bitcoinLocks,
      miningFrames: harness.miningFrames,
    });

    try {
      const lock = await createLock(harness);
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
    const harness = await createHarness();
    const progress = createBitcoinLockProgressStore({
      myVault: harness.myVault,
      bitcoinLocks: harness.bitcoinLocks,
      miningFrames: harness.miningFrames,
    });

    try {
      const initialAvailableBitcoinSpace = harness.myVault.createdVault!.availableBitcoinSpace();
      const lock = await createLock(harness);
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
    const harness = await createHarness();
    const progress = createBitcoinLockProgressStore({
      myVault: harness.myVault,
      bitcoinLocks: harness.bitcoinLocks,
      miningFrames: harness.miningFrames,
    });

    try {
      const lock = await createLock(harness);
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
          if (candidateRefs && [...candidateRefs.entries()].length > 0) return;

          return true;
        });
      } finally {
        stopTracking();
      }
    } finally {
      await cleanupHarness(harness);
    }
  });

  it('keeps a new funded lock isolated after a prior release and a prior mismatch return', async () => {
    const harness = await createHarness();
    const progress = createBitcoinLockProgressStore({
      myVault: harness.myVault,
      bitcoinLocks: harness.bitcoinLocks,
      miningFrames: harness.miningFrames,
    });

    try {
      const initialAvailableBitcoinSpace = harness.myVault.createdVault!.availableBitcoinSpace();
      const firstLock = await createLock(harness);
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

      const secondLock = await createLock(harness);
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

      const thirdLock = await createLock(harness);
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
});

type TestHarness = {
  db: Db;
  clients: MainchainClients;
  walletKeys: WalletKeys;
  vaults: Vaults;
  myVault: MyVault;
  bitcoinLocks: BitcoinLocks;
  miningFrames: MiningFrames;
};

async function createHarness(): Promise<TestHarness> {
  clients = new MainchainClients(network.archiveUrl);
  setMainchainClients(clients);

  const db = await createTestDb();
  setDbPromise(Promise.resolve(db));
  const walletKeys = createMockWalletKeys();
  await sudoFundWallet({
    address: walletKeys.vaultingAddress,
    microgons: walletFundingMicrogons,
    micronots: 0n,
    archiveUrl: network.archiveUrl,
  });
  console.log('[BitcoinLocks.integration] funded vault wallet', walletKeys.vaultingAddress);
  const archiveClient = await clients.archiveClientPromise;
  await waitFor(30e3, 'vault wallet finalized funding visibility', async () => {
    const finalizedHead = await archiveClient.rpc.chain.getFinalizedHead();
    const finalizedClient = await archiveClient.at(finalizedHead);
    const balance = await finalizedClient.query.system
      .account(walletKeys.vaultingAddress)
      .then(x => x.data.free.toBigInt());
    if (balance < walletFundingMicrogons) return;
    return balance;
  });

  const currency = new CurrencyBase(clients);
  await currency.fetchMainchainRates();
  const miningFrames = new MiningFrames(clients);
  const vaults = new Vaults('dev-docker', currency, miningFrames);
  Object.assign(vaults, {
    saveStats: async () => {},
    loadStatsFromFile: async () => undefined,
  });
  const transactionTracker = new TransactionTracker(Promise.resolve(db), miningFrames.blockWatch);
  const bitcoinLocks = new BitcoinLocks(
    Promise.resolve(db),
    walletKeys,
    miningFrames.blockWatch,
    currency,
    transactionTracker,
    new BitcoinMempool(network.networkConfigOverride.esploraHost),
  );
  const myVault = new MyVault(Promise.resolve(db), vaults, walletKeys, transactionTracker, bitcoinLocks, miningFrames);

  vi.spyOn(myVault.vaults, 'load').mockImplementation(async () => {});
  vi.spyOn(myVault.vaults, 'updateRevenue').mockResolvedValue({} as IAllVaultStats);

  const config = new Config(Promise.resolve(db), walletKeys);
  await config.load();
  await myVault.load();
  console.log('[BitcoinLocks.integration] loaded vault stores');
  const vaultCreation = await myVault.createNew({
    masterXpubPath: DEFAULT_MASTER_XPUB_PATH,
    rules: defaultVaultRules,
    config,
  });
  await vaultCreation.txResult.waitForFinalizedBlock;
  await vaultCreation.waitForPostProcessing;
  console.log('[BitcoinLocks.integration] created vault', myVault.createdVault?.vaultId);
  await myVault.subscribe();

  console.log('[BitcoinLocks.integration] securitization set during vault creation', myVault.createdVault?.vaultId);

  await waitFor(
    60e3,
    'vault securitization availability',
    () => (myVault.createdVault?.availableBitcoinSpace() ?? 0n) > 0n,
  );

  return {
    db,
    clients,
    walletKeys,
    vaults,
    myVault,
    bitcoinLocks,
    miningFrames,
  };
}

async function cleanupHarness(harness: TestHarness): Promise<void> {
  harness.myVault.unsubscribe();
  await harness.bitcoinLocks.shutdown();
  harness.miningFrames.blockWatch.stop();
  await harness.db.close();
  await harness.clients.disconnect();
}

async function createLock(harness: TestHarness, microgonLiquidity?: bigint): Promise<IBitcoinLockRecord> {
  const availableBitcoinSpace = harness.myVault.createdVault!.availableBitcoinSpace();
  const targetLiquidity = microgonLiquidity ?? (availableBitcoinSpace * 4n) / 5n;
  expect(targetLiquidity).toBeGreaterThan(0n);
  const satoshis = await harness.bitcoinLocks.satoshisForArgonLiquidity(targetLiquidity);

  await harness.myVault.startBitcoinLocking({ satoshis });
  return await waitFor(120e3, 'pending bitcoin lock finalization', () => {
    const lock = Object.values(harness.bitcoinLocks.data.locksByUtxoId)
      .filter(record => record.vaultId === harness.myVault.createdVault!.vaultId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
    if (!lock) return;
    if (lock.status !== BitcoinLockStatus.LockPendingFunding) return;
    return lock;
  });
}

async function observeMismatchCandidate(
  harness: TestHarness,
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
    60e3,
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
  return harness.bitcoinLocks.getMismatchViewState(lock).candidates.find(view => {
    return view.record.id === candidate.id;
  })?.returnRecord;
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
  const returnTx = await harness.bitcoinLocks.requestMismatchOrphanReturnOnArgon({
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
      if (candidateRefs && [...candidateRefs.entries()].length > 0) return;

      const pendingCosign = await chainClient.query.vaults.pendingCosignByVaultId(refreshed.vaultId);
      if (JSON.stringify(pendingCosign.toJSON()) !== '[]') return;

      const vault = await chainClient.query.vaults.vaultsById(refreshed.vaultId);
      if (!vault.isSome) return;
      if (vault.unwrap().securitizationLocked.toBigInt() <= 0n) return;

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
  harness: TestHarness,
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
    if (!chainVault.isSome) return;
    if (chainVault.unwrap().securitizationLocked.toBigInt() <= 0n) return;

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
  const expirationBitcoinHeight =
    observed.lock.lockDetails.createdAtHeight + expirationConfig.pendingConfirmationExpirationBlocks;
  await waitFor(
    60e3,
    'bitcoin lock expiration height',
    async () => {
      const chainClient = await clients.get(false);
      const currentBitcoinHeight = await BitcoinLock.getBitcoinConfirmedBlockHeight(chainClient);
      if (currentBitcoinHeight >= expirationBitcoinHeight) return true;
      mineBitcoinBlocks(expirationBitcoinHeight - currentBitcoinHeight, minerAddress);
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
      if (candidateRefs && [...candidateRefs.entries()].length > 0) return;

      const pendingCosign = await chainClient.query.vaults.pendingCosignByVaultId(currentLock.vaultId);
      if (JSON.stringify(pendingCosign.toJSON()) !== '[]') return;

      const vault = await chainClient.query.vaults.vaultsById(currentLock.vaultId);
      if (!vault.isSome) return;
      if (vault.unwrap().securitizationLocked.toBigInt() !== 0n) return;
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
  const returnTx = await harness.bitcoinLocks.requestMismatchOrphanReturnOnArgon({
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
      const record = harness.bitcoinLocks.getMismatchViewState(refreshed).candidates.find(candidate => {
        return candidate.record.id === expired.candidate.id;
      })?.returnRecord;
      if (!record) return;
      if (record.status !== BitcoinUtxoStatus.ReleaseComplete) return;
      if (!record.releaseTxid) return;
      if (record.releaseCosignHeight == null) return;
      if (!record.releaseCosignVaultSignature) return;

      const chainClient = await clients.get(false);
      const chainLock = await BitcoinLock.get(chainClient, refreshed.utxoId!);
      if (chainLock) return;

      const mismatchView = harness.bitcoinLocks.getMismatchViewState(refreshed);
      if (mismatchView.phase !== 'returned') return;
      if (
        refreshed.status !== BitcoinLockStatus.LockExpiredWaitingForFunding &&
        refreshed.status !== BitcoinLockStatus.LockExpiredWaitingForFundingAcknowledged
      ) {
        return;
      }

      const candidateRefs = await chainClient.query.bitcoinUtxos.candidateUtxoRefsByUtxoId(refreshed.utxoId!);
      if (candidateRefs && [...candidateRefs.entries()].length > 0) return;
      const pendingCosign = await chainClient.query.vaults.pendingCosignByVaultId(refreshed.vaultId);
      if (JSON.stringify(pendingCosign.toJSON()) !== '[]') return;
      const vault = await chainClient.query.vaults.vaultsById(refreshed.vaultId);
      if (!vault.isSome) return;
      if (vault.unwrap().securitizationLocked.toBigInt() !== 0n) return;
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
    if (!vault.isSome) return;
    if (vault.unwrap().securitizationLocked.toBigInt() !== 0n) return;
    if (JSON.stringify(pendingCosign.toJSON()) !== '[]') return;
    if (harness.myVault.createdVault?.availableBitcoinSpace() !== expectedAvailableBitcoinSpace) return;
    return true;
  });

  return seenOnBitcoin;
}

function getCurrentLock(harness: TestHarness, utxoId: number): IBitcoinLockRecord {
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
