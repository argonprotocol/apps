import { BitcoinLock, type ArgonClient, type BlockWatch, type TxSigningAccount } from '@argonprotocol/apps-core';
import { BitcoinNetwork } from '@argonprotocol/bitcoin';
import type { SubmittableExtrinsic } from '@argonprotocol/mainchain';
import { describe, expect, it, vi } from 'vitest';

import { BitcoinLockStatus, type IBitcoinLockRecord } from '../interfaces/IBitcoinLockRecord.ts';
import { BitcoinReleaseKind, BitcoinReleaseStatus } from '../interfaces/IBitcoinReleaseRecord.ts';
import { BitcoinUtxoSpendStatus, BitcoinUtxoStatus } from '../interfaces/IBitcoinUtxoRecord.ts';
import BitcoinLocks from '../lib/BitcoinLocks.ts';
import type BitcoinMempool from '../lib/BitcoinMempool.ts';
import BitcoinReleases from '../lib/BitcoinReleases.ts';
import * as securitizationTerms from '../lib/BitcoinSecuritizationTerms.ts';
import BitcoinUtxoTracking from '../lib/BitcoinUtxoTracking.ts';
import type { TransactionTracker } from '../lib/TransactionTracker.ts';
import type { WalletKeys } from '../lib/WalletKeys.ts';
import { BitcoinLockRelease } from '../lib/txs/BitcoinLock.release.ts';
import { BitcoinOrphanRelease } from '../lib/txs/BitcoinOrphan.release.ts';
import * as mainchainStore from '../stores/mainchain.ts';
import { createCurrentLock, createStore, historyBlock, historyEvent } from './helpers/bitcoin.ts';
import { createTestDb } from './helpers/db.ts';

describe('Bitcoin lock release', () => {
  it('refuses to release Bitcoin that is still allocated to a Liquid', async () => {
    const lock = { lockId: 11, status: BitcoinLockStatus.LockFunded } as IBitcoinLockRecord;
    const getLock = vi.spyOn(BitcoinLock, 'get').mockResolvedValue({
      fundedSatoshis: 1_000n,
      fissionedSatoshis: 1_000n,
    } as BitcoinLock);
    const release = new BitcoinLockRelease(
      {
        bitcoinNetwork: 'regtest',
        getLockById: () => lock,
        isLockFunded: () => true,
        releases: { getActiveForLock: () => undefined },
      } as unknown as BitcoinLocks,
      {} as TransactionTracker,
    );

    try {
      await expect(
        release.prepare({
          lockId: 11,
          destinationSatoshis: 500n,
          bitcoinNetworkFee: 500n,
          toScriptPubkey: 'unused-before-active-liquid-guard',
          txSigner: { address: 'owner-account' } as TxSigningAccount,
          client: {} as ArgonClient,
        }),
      ).rejects.toThrow('Close its Liquid before releasing this Bitcoin lock.');
    } finally {
      getLock.mockRestore();
    }
  });

  it('persists, broadcasts, and atomically settles a partial multi-input Lock release', async () => {
    const db = await createTestDb();
    const pendingLock = await db.bitcoinLocksTable.insertPending({
      uuid: 'release-lock',
      status: BitcoinLockStatus.LockPendingFunding,
      securitizedSatoshis: 1_000n,
      cosignVersion: 'v1',
      network: 'regtest',
      hdPath: "m/84'/1'/0'/0/1",
      vaultId: 3,
    });
    await db.execute('UPDATE BitcoinLocks SET lockId = ?, status = ?, fundedSatoshis = ? WHERE uuid = ?', [
      7,
      BitcoinLockStatus.LockFunded,
      1_000n,
      pendingLock.uuid,
    ]);

    const firstInput = await db.bitcoinUtxosTable.insert({
      lockId: 7,
      txid: '1'.repeat(64),
      vout: 0,
      satoshis: 400n,
      network: 'regtest',
      status: BitcoinUtxoStatus.FundingUtxo,
      spendStatus: BitcoinUtxoSpendStatus.Unspent,
      firstSeenAt: new Date('2026-09-11T00:00:00Z'),
      firstSeenBitcoinHeight: 100,
    });
    const secondInput = await db.bitcoinUtxosTable.insert({
      lockId: 7,
      txid: '2'.repeat(64),
      vout: 1,
      satoshis: 600n,
      network: 'regtest',
      status: BitcoinUtxoStatus.FundingUtxo,
      spendStatus: BitcoinUtxoSpendStatus.Unspent,
      firstSeenAt: new Date('2026-09-11T00:01:00Z'),
      firstSeenBitcoinHeight: 100,
    });
    await db.execute('UPDATE BitcoinLocks SET fundingUtxoIds = ? WHERE uuid = ?', [
      [firstInput.id, secondInput.id],
      pendingLock.uuid,
    ]);
    const originalLock = new BitcoinLock(
      createCurrentLock({
        lockId: 7,
        vaultId: 3,
        ownerAccount: 'owner-account',
        fundedSatoshis: 1_000n,
        securitizedSatoshis: 1_000n,
        securitizationCoverageMicrogons: 1_000n,
        securityFees: 50n,
        couponFeesPaid: 5n,
      }),
    );
    await securitizationTerms.recordFinalizedSecuritization(db.bitcoinSecuritizationHistoryTable, {
      block: historyBlock(100),
      extrinsicIndex: 1,
      lock: originalLock,
      origin: 'created',
    });
    await db.bitcoinFissionsTable.replaceRecord({
      ownerAccount: 'owner-account',
      origin: 'created',
      fissionId: 1,
      liquidId: 1,
      lockId: 7,
      satoshis: 300n,
      microgonsAtTargetPerBtc: 1_000n,
      liquidityPromised: 300n,
      createdAtArgonBlock: 100,
      ratchetNumber: 0,
      lastUpdatedArgonBlock: 100,
      ratchets: [],
      createdAt: new Date('2026-09-11T00:00:00Z'),
      updatedAt: new Date('2026-09-11T00:00:00Z'),
    });

    const destinationScript = `0x0020${'ab'.repeat(32)}`;
    const destinationAddress = BitcoinLocks.formatP2wshAddress(destinationScript, BitcoinNetwork.Regtest);

    const submitAndWatch = vi.fn(async () => {
      const persistedRelease = await db.bitcoinReleasesTable.getById('lock:7:1');
      const persistedLock = await db.bitcoinLocksTable.getByLockId(7);
      const persistedInputs = await db.bitcoinUtxosTable.fetchByLockId(7);

      expect(persistedRelease).toMatchObject({
        id: 'lock:7:1',
        kind: BitcoinReleaseKind.Lock,
        status: BitcoinReleaseStatus.SubmittingRequestOnArgon,
        inputUtxoIds: [firstInput.id, secondInput.id],
        toScriptPubkey: destinationAddress,
      });
      expect(persistedLock).toMatchObject({
        status: BitcoinLockStatus.Releasing,
        activeReleaseId: 'lock:7:1',
      });
      expect(persistedInputs.map(input => input.activeReleaseId)).toEqual(['lock:7:1', 'lock:7:1']);
      throw new Error('Argon submission unavailable');
    });
    const transactionTracker = {
      findLatestTxAttempt: vi.fn().mockResolvedValue(undefined),
      submitAndWatch,
    } as unknown as TransactionTracker;
    const bitcoinLocks = await loadBitcoinLocksState(db, transactionTracker);
    const lock = bitcoinLocks.getLockById(7)!;
    const releases = bitcoinLocks.releases;
    const operation = new BitcoinLockRelease(bitcoinLocks, transactionTracker);
    const txSigner = { address: 'owner-account' } as TxSigningAccount;
    const tx = {} as SubmittableExtrinsic;

    await expect(
      operation.submit(
        {
          lockId: 7,
          destinationSatoshis: 575n,
          bitcoinNetworkFee: 25n,
          toScriptPubkey: 'unused-for-prepared-operation',
          txSigner,
          client: {} as ArgonClient,
        },
        {
          client: {} as ArgonClient,
          lock,
          txs: [tx],
          txSigner,
          metadata: {
            releaseId: 'lock:7:1',
            sendId: 'lock:7:1',
            releaseNumber: 1,
            lockId: 7,
            inputUtxoIds: [firstInput.id, secondInput.id],
            toScriptPubkey: destinationAddress,
            bitcoinNetworkFee: 25n,
            destinationSatoshis: 575n,
            changeSatoshis: 400n,
          },
          operationKey: 'owner-account:7:575:25:unused-for-prepared-operation',
          tx,
          txFeePlusTip: 1n,
          availableBalance: 1_000n,
          canAfford: true,
        },
      ),
    ).rejects.toThrow('Argon submission unavailable');

    expect(submitAndWatch).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ toScriptPubkey: destinationAddress }) }),
    );
    expect(releases.getById('lock:7:1')?.statusError).toBe('Error: Argon submission unavailable');

    let restarted = await loadReleaseState(db);
    const staleSubmittingRelease = { ...restarted.release };
    await restarted.releases.finalizeLockRequest(restarted.lock, {
      releaseId: restarted.release.id,
      request: {
        lockId: 7,
        vaultId: 3,
        releaseNumber: 1,
        toScriptPubkey: destinationAddress,
        bitcoinNetworkFee: 25n,
        destinationSatoshis: 575n,
        changeSatoshis: 400n,
        cosignDueFrame: 120,
        expectedTransactionId: `0x${'a'.repeat(64)}`,
        securitizationAtRisk: 900n,
      },
      inputUtxoIds: [firstInput.id, secondInput.id],
      requestedReleaseAtTick: 101,
      argonTxFeeMicrogons: 3n,
    });
    restarted = await loadReleaseState(db);
    expect(restarted.release).toMatchObject({
      status: BitcoinReleaseStatus.WaitingForVaultCosign,
      requestedReleaseAtTick: 101,
      insuredMicrogons: 900n,
      cosignDueFrame: 120,
      expectedTransactionId: `0x${'a'.repeat(64)}`,
    });
    const staleWaitingRelease = { ...restarted.release };

    const vaultSignatures = [new Uint8Array([1]), new Uint8Array([2])];
    const findVaultCosignatures = vi.spyOn(BitcoinLock, 'findVaultCosignatures').mockResolvedValue({
      blockHeight: 110,
      signatures: vaultSignatures,
    });
    const getMainchainClient = vi.spyOn(mainchainStore, 'getMainchainClient').mockResolvedValue({} as ArgonClient);
    const finalTx = {
      isFinal: true,
      hash: 'a'.repeat(64),
      toBytes: () => new Uint8Array([1, 2, 3]),
    };
    const walletKeys = {
      canSign: true,
      defaultArgonAddress: 'owner-account',
      getBitcoinChildXpriv: vi.fn().mockResolvedValue({}),
    } as unknown as WalletKeys;
    const mempool = {
      getTxStatus: vi.fn().mockResolvedValue(undefined),
      broadcastTx: vi.fn().mockResolvedValue(`0x${'a'.repeat(64)}`),
      getTipHeight: vi.fn().mockResolvedValue(120),
    } as unknown as BitcoinMempool;
    restarted = await loadReleaseState(db, { walletKeys, mempool });
    vi.spyOn(restarted.bitcoinLocks, 'createCosignScript').mockReturnValue({
      cosignAndGenerateTx: () => finalTx,
    } as never);
    await restarted.releases.reconcileLockRelease(restarted.lock, false);
    findVaultCosignatures.mockRestore();
    getMainchainClient.mockRestore();
    restarted = await loadReleaseState(db);
    expect(restarted.release).toMatchObject({
      status: BitcoinReleaseStatus.ConfirmingOnBitcoin,
      inputUtxoIds: [firstInput.id, secondInput.id],
      vaultSignatures,
      bitcoinTxid: `0x${'a'.repeat(64)}`,
    });

    await restarted.releases.recordBitcoinConfirmation(restarted.release, { bitcoinConfirmedHeight: 126 });
    restarted = await loadReleaseState(db);
    expect(restarted.release.status).toBe(BitcoinReleaseStatus.WaitingForArgonRecognition);

    await restarted.releases.recordArgonRequest(restarted.release, {
      requestedReleaseAtTick: 101,
      insuredMicrogons: 900n,
      argonTxFeeMicrogons: 3n,
    });
    restarted = await loadReleaseState(db);
    expect(restarted.release.status).toBe(BitcoinReleaseStatus.WaitingForArgonRecognition);

    await restarted.releases.failRelease(staleSubmittingRelease, 'late transaction failure');
    restarted = await loadReleaseState(db);
    expect(restarted.release.status).toBe(BitcoinReleaseStatus.WaitingForArgonRecognition);
    expect(restarted.lock).toMatchObject({
      status: BitcoinLockStatus.Releasing,
      activeReleaseId: 'lock:7:1',
    });

    const currentLock = new BitcoinLock(
      createCurrentLock({
        lockId: 7,
        vaultId: 3,
        ownerAccount: 'owner-account',
        fundedSatoshis: 400n,
        securitizedSatoshis: 400n,
        securitizationCoverageMicrogons: 400n,
        securityFees: 50n,
        couponFeesPaid: 5n,
        fissionedSatoshis: 300n,
        fundingUtxos: [{ utxoRef: { txid: `0x${'a'.repeat(64)}`, vout: 1 }, satoshis: 400n }],
      }),
    );
    const getCurrentLock = vi.spyOn(BitcoinLock, 'get').mockResolvedValue(currentLock);
    const settlementBlock = historyBlock(130);
    const settlementEvent = historyEvent(159, 'bitcoinLocks', 'BitcoinSpentAfterRelease', {
      lockId: 7,
      vaultId: 3,
      releaseNumber: 1,
      bitcoinHeight: 126n,
    });
    const historyFailure = vi
      .spyOn(securitizationTerms, 'recordFinalizedSecuritization')
      .mockRejectedValueOnce(new Error('history write unavailable'));
    await expect(
      restarted.releases.completeLockReleaseFromArgon(
        restarted.lock,
        restarted.release,
        settlementBlock,
        {} as ArgonClient,
        settlementEvent,
      ),
    ).rejects.toThrow('history write unavailable');
    expect(restarted.release.status).toBe(BitcoinReleaseStatus.WaitingForArgonRecognition);
    expect(restarted.lock).toMatchObject({
      status: BitcoinLockStatus.Releasing,
      activeReleaseId: 'lock:7:1',
      fundedSatoshis: 1_000n,
    });
    expect(await db.bitcoinUtxosTable.getByLockOutpoint(7, `0x${'a'.repeat(64)}`, 1)).toBeUndefined();
    expect((await db.bitcoinUtxosTable.fetchByLockId(7)).every(input => input.spendStatus === 'Unspent')).toBe(true);
    historyFailure.mockRestore();

    const finalizedBlock = historyBlock(132);
    const pendingPartialReleaseByLockId = vi
      .fn()
      .mockResolvedValueOnce({ releaseNumber: 1 })
      .mockResolvedValueOnce(null);
    const finalizedApi = {
      query: { bitcoinLocks: { pendingPartialReleaseByLockId } },
    } as unknown as ArgonClient;
    const blockWatch = {
      finalizedBlockHeader: finalizedBlock,
      getApi: vi.fn(async () => finalizedApi),
      getHeaderByBlockNumber: vi.fn(async (blockNumber: number) => historyBlock(blockNumber)),
      getEventsWithSpec: vi.fn(async (block: ReturnType<typeof historyBlock>) => ({
        api: {} as ArgonClient,
        specVersion: 159,
        events:
          block.blockNumber === settlementBlock.blockNumber
            ? [settlementEvent]
            : block.blockNumber === settlementBlock.blockNumber - 1
              ? [
                  historyEvent(159, 'bitcoinLocks', 'BitcoinSpentAfterRelease', {
                    lockId: 7,
                    vaultId: 3,
                    releaseNumber: 2,
                    bitcoinHeight: 126n,
                  }),
                ]
              : [],
      })),
    } as unknown as BlockWatch;
    restarted = await loadReleaseState(db, { blockWatch });
    await restarted.releases.reconcileLockRelease(restarted.lock, false);
    expect(restarted.release.status).toBe(BitcoinReleaseStatus.WaitingForArgonRecognition);
    expect(blockWatch.getHeaderByBlockNumber).not.toHaveBeenCalled();

    await restarted.releases.reconcileLockRelease(restarted.lock, false);
    getCurrentLock.mockRestore();
    expect(restarted.release.status).toBe(BitcoinReleaseStatus.Complete);
    expect(restarted.lock).toMatchObject({
      status: BitcoinLockStatus.LockFunded,
      activeReleaseId: undefined,
      fundedSatoshis: 400n,
      fundingUtxoIds: [expect.any(Number)],
    });
    expect(restarted.tracking.getUtxoRecord(7, `0x${'a'.repeat(64)}`, 1)).toMatchObject({
      spendStatus: BitcoinUtxoSpendStatus.Unspent,
      createdByReleaseId: 'lock:7:1',
    });
    await restarted.releases.recordVaultCosign(staleWaitingRelease, { vaultSignatures });

    restarted = await loadReleaseState(db);
    expect(restarted.release.status).toBe(BitcoinReleaseStatus.Complete);
    expect(restarted.lock).toMatchObject({
      status: BitcoinLockStatus.LockFunded,
      activeReleaseId: undefined,
      fundedSatoshis: 400n,
      securitizedSatoshis: 400n,
    });
    expect(restarted.tracking.getUtxosForLock(7)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ spendStatus: BitcoinUtxoSpendStatus.Spent, spentByReleaseId: 'lock:7:1' }),
        expect.objectContaining({ spendStatus: BitcoinUtxoSpendStatus.Spent, spentByReleaseId: 'lock:7:1' }),
        expect.objectContaining({
          txid: `0x${'a'.repeat(64)}`,
          vout: 1,
          satoshis: 400n,
          status: BitcoinUtxoStatus.FundingUtxo,
          spendStatus: BitcoinUtxoSpendStatus.Unspent,
          createdByReleaseId: 'lock:7:1',
        }),
      ]),
    );
    const retainedFission = await db.bitcoinFissionsTable.getByFissionId('owner-account', 1);
    expect(retainedFission).toMatchObject({ liquidityPromised: 300n });
    expect(retainedFission).not.toHaveProperty('closeReason');
    await expect(db.bitcoinSecuritizationHistoryTable.getPublishedSnapshot('owner-account')).resolves.toMatchObject({
      terms: [
        expect.objectContaining({
          origin: 'created',
          securitizedSatoshis: 1_000n,
          cumulativeNetSecurityFee: 45n,
          endReason: 'partial-release',
        }),
        expect.objectContaining({
          origin: 'partial-release',
          securitizedSatoshis: 400n,
          cumulativeNetSecurityFee: 45n,
          addedNetSecurityFee: 0n,
        }),
      ],
    });
  });

  it('atomically completes a full Lock release and closes its securitization term', async () => {
    const db = await createTestDb();
    const pendingLock = await db.bitcoinLocksTable.insertPending({
      uuid: 'full-release-lock',
      status: BitcoinLockStatus.LockPendingFunding,
      securitizedSatoshis: 1_000n,
      cosignVersion: 'v1',
      network: 'regtest',
      hdPath: "m/84'/1'/0'/0/3",
      vaultId: 3,
    });
    const currentLock = createCurrentLock({
      lockId: 7,
      ownerAccount: '5owner',
      fundedSatoshis: 1_000n,
      securitizedSatoshis: 1_000n,
      securitizationCoverageMicrogons: 1_000n,
    });
    const lock = await db.bitcoinLocksTable.finalizePending({ uuid: pendingLock.uuid, lock: currentLock });
    await db.bitcoinLocksTable.setStatus(lock, BitcoinLockStatus.LockFunded);
    const input = await db.bitcoinUtxosTable.insert({
      lockId: 7,
      txid: '5'.repeat(64),
      vout: 0,
      satoshis: 1_000n,
      network: 'regtest',
      status: BitcoinUtxoStatus.FundingUtxo,
      spendStatus: BitcoinUtxoSpendStatus.Unspent,
      firstSeenAt: new Date('2026-09-11T00:00:00Z'),
      firstSeenBitcoinHeight: 100,
    });
    lock.fundingUtxoIds = [input.id];
    await db.execute('UPDATE BitcoinLocks SET fundingUtxoIds = ? WHERE uuid = ?', [[input.id], lock.uuid]);
    await securitizationTerms.recordFinalizedSecuritization(db.bitcoinSecuritizationHistoryTable, {
      block: historyBlock(100),
      extrinsicIndex: 1,
      lock: currentLock,
      origin: 'created',
    });

    const setup = await loadBitcoinLocksState(db);
    const release = await setup.releases.createLockRelease(setup.getLockById(7)!, {
      id: 'lock:7:1',
      kind: BitcoinReleaseKind.Lock,
      lockId: 7,
      sendId: 'lock:7:1',
      releaseNumber: 1,
      status: BitcoinReleaseStatus.WaitingForArgonRecognition,
      inputUtxoIds: [input.id],
      toScriptPubkey: `0x0020${'ab'.repeat(32)}`,
      bitcoinNetworkFee: 100n,
      destinationSatoshis: 900n,
      changeSatoshis: 0n,
      vaultSignatures: [],
      cosignBlockNumber: 230,
    });
    const settlementBlock = historyBlock(230);
    const blockWatch = {
      getHeaderByBlockNumber: vi.fn().mockResolvedValue(settlementBlock),
      getEventsWithSpec: vi.fn().mockResolvedValue({
        api: {} as ArgonClient,
        specVersion: 159,
        events: [
          historyEvent(159, 'bitcoinLocks', 'BitcoinUtxoCosigned', {
            lockId: 7,
            vaultId: 3,
            releaseNumber: 1,
            signatures: ['0x01'],
          }),
        ],
      }),
    } as unknown as BlockWatch;
    const bitcoinLocks = await loadBitcoinLocksState(db, undefined, { blockWatch });
    await bitcoinLocks.releases.reconcileLockRelease(bitcoinLocks.getLockById(7)!, false);

    expect(await db.bitcoinReleasesTable.getById(release.id)).toMatchObject({
      status: BitcoinReleaseStatus.Complete,
      argonCompletionBlockNumber: 230,
      argonCompletionBlockHash: '0x230',
      argonCompletionExtrinsicIndex: 2,
    });
    expect(await db.bitcoinLocksTable.getByLockId(7)).toMatchObject({
      status: BitcoinLockStatus.Released,
      activeReleaseId: undefined,
      removalReason: 'released',
      removalBlockNumber: 230,
    });
    expect((await db.bitcoinUtxosTable.fetchByLockId(7)).find(utxo => utxo.id === input.id)).toMatchObject({
      spendStatus: BitcoinUtxoSpendStatus.Spent,
      activeReleaseId: undefined,
      spentByReleaseId: release.id,
    });
    expect((await db.bitcoinSecuritizationHistoryTable.getPublishedSnapshot('5owner'))?.terms).toEqual([
      expect.objectContaining({
        endTick: 230,
        endBlockNumber: 230,
        endBlockHash: '0x230',
        endExtrinsicIndex: 2,
        endReason: 'released',
      }),
    ]);
  });

  it('keeps an Orphan return separate from Lock funding through restart and completion', async () => {
    const db = await createTestDb();
    const pendingLock = await db.bitcoinLocksTable.insertPending({
      uuid: 'orphan-lock',
      status: BitcoinLockStatus.LockPendingFunding,
      securitizedSatoshis: 1_000n,
      cosignVersion: 'v1',
      network: 'regtest',
      hdPath: "m/84'/1'/0'/0/2",
      vaultId: 3,
    });
    await db.execute('UPDATE BitcoinLocks SET lockId = ?, status = ?, fundedSatoshis = ? WHERE uuid = ?', [
      8,
      BitcoinLockStatus.LockFunded,
      600n,
      pendingLock.uuid,
    ]);
    const fundingUtxo = await db.bitcoinUtxosTable.insert({
      lockId: 8,
      txid: '3'.repeat(64),
      vout: 0,
      satoshis: 600n,
      network: 'regtest',
      status: BitcoinUtxoStatus.FundingUtxo,
      spendStatus: BitcoinUtxoSpendStatus.Unspent,
      firstSeenAt: new Date('2026-09-11T00:00:00Z'),
      firstSeenBitcoinHeight: 100,
    });
    const orphanUtxo = await db.bitcoinUtxosTable.insert({
      lockId: 8,
      txid: '4'.repeat(64),
      vout: 1,
      satoshis: 400n,
      network: 'regtest',
      status: BitcoinUtxoStatus.Orphaned,
      spendStatus: BitcoinUtxoSpendStatus.Unspent,
      firstSeenAt: new Date('2026-09-11T00:01:00Z'),
      firstSeenBitcoinHeight: 101,
    });
    await db.execute('UPDATE BitcoinLocks SET fundingUtxoIds = ? WHERE uuid = ?', [[fundingUtxo.id], pendingLock.uuid]);

    const lock = (await db.bitcoinLocksTable.getByLockId(8))!;
    const tracking = createUtxoTracking(db);
    tracking.load(await db.bitcoinUtxosTable.fetchAll());
    const releases = new BitcoinReleases(
      {} as BitcoinLocks,
      Promise.resolve(db),
      tracking,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    await releases.load();
    const trackedOrphan = tracking.getUtxoRecordById(orphanUtxo.id)!;
    const destinationScript = `0x0020${'cd'.repeat(32)}`;
    const destinationAddress = BitcoinLocks.formatP2wshAddress(destinationScript, BitcoinNetwork.Regtest);
    const submitAndWatch = vi.fn(async () => {
      expect(await db.bitcoinReleasesTable.getById('orphan-release-1')).toMatchObject({
        kind: BitcoinReleaseKind.Orphan,
        status: BitcoinReleaseStatus.SubmittingRequestOnArgon,
        inputUtxoIds: [orphanUtxo.id],
        toScriptPubkey: destinationScript,
      });
      expect(await db.bitcoinUtxosTable.getByLockOutpoint(8, orphanUtxo.txid, orphanUtxo.vout)).toMatchObject({
        status: BitcoinUtxoStatus.Orphaned,
        activeReleaseId: 'orphan-release-1',
      });
      expect(await db.bitcoinLocksTable.getByLockId(8)).toMatchObject({
        status: BitcoinLockStatus.LockFunded,
        fundingUtxoIds: [fundingUtxo.id],
        activeReleaseId: undefined,
      });
      throw new Error('Argon submission unavailable');
    });
    const transactionTracker = {
      findLatestTxAttempt: vi.fn().mockResolvedValue(undefined),
      submitAndWatch,
    } as unknown as TransactionTracker;
    const bitcoinLocks = {
      bitcoinNetwork: BitcoinNetwork.Regtest,
      getLockById: () => lock,
      ensureBitcoinActionsAvailable: () => undefined,
      runInQueueForLock: async (_lock: IBitcoinLockRecord, task: () => Promise<unknown>) => await task(),
      utxoTracking: tracking,
      releases,
    } as unknown as BitcoinLocks;
    const operation = new BitcoinOrphanRelease(bitcoinLocks, transactionTracker);
    const txSigner = { address: 'owner-account' } as TxSigningAccount;
    const tx = {} as SubmittableExtrinsic;

    await expect(
      operation.submit(
        {
          lock,
          record: trackedOrphan,
          toScriptPubkey: destinationAddress,
          bitcoinNetworkFee: 25n,
          txSigner,
          client: {} as ArgonClient,
        },
        {
          client: {} as ArgonClient,
          txs: [tx],
          txSigner,
          metadata: {
            releaseId: 'orphan-release-1',
            releaseKind: 'Orphan',
            lockId: 8,
            utxoRecordId: orphanUtxo.id,
            utxoRef: { txid: orphanUtxo.txid, vout: orphanUtxo.vout },
            toScriptPubkey: destinationAddress,
            bitcoinNetworkFee: 25n,
          },
          operationKey: `owner-account:8:${orphanUtxo.txid}:${orphanUtxo.vout}`,
          tx,
          txFeePlusTip: 1n,
          availableBalance: 1_000n,
          canAfford: true,
        },
      ),
    ).rejects.toThrow('Argon submission unavailable');

    let restarted = await loadOrphanReleaseState(db, orphanUtxo.id);
    await restarted.releases.recordArgonRequest(restarted.release, { requestedReleaseAtTick: 101 });
    await restarted.releases.recordVaultCosign(restarted.release, {
      vaultSignatures: [new Uint8Array([1])],
      cosignBlockNumber: 110,
    });
    await restarted.releases.recordBitcoinBroadcast(restarted.release, {
      bitcoinTxid: 'orphan-return',
      bitcoinFirstSeenAt: new Date('2026-09-11T01:00:00Z'),
      bitcoinFirstSeenHeight: 120,
      bitcoinFirstSeenOracleHeight: 115,
    });
    await restarted.releases.completeOrphanRelease(restarted.orphan, restarted.release, 126);

    restarted = await loadOrphanReleaseState(db, orphanUtxo.id);
    expect(restarted.release).toMatchObject({
      status: BitcoinReleaseStatus.Complete,
      bitcoinConfirmedHeight: 126,
    });
    expect(restarted.orphan).toMatchObject({
      status: BitcoinUtxoStatus.Orphaned,
      spendStatus: BitcoinUtxoSpendStatus.Spent,
      activeReleaseId: undefined,
      spentByReleaseId: 'orphan-release-1',
    });
    expect(restarted.lock).toMatchObject({
      status: BitcoinLockStatus.LockFunded,
      fundingUtxoIds: [fundingUtxo.id],
      activeReleaseId: undefined,
    });
    expect(restarted.releases.getLatestForLock(restarted.lock)).toBeUndefined();
  });
});

async function loadReleaseState(
  db: Awaited<ReturnType<typeof createTestDb>>,
  options: { walletKeys?: WalletKeys; mempool?: BitcoinMempool; blockWatch?: BlockWatch } = {},
) {
  const bitcoinLocks = await loadBitcoinLocksState(db, undefined, options);
  return {
    bitcoinLocks,
    lock: bitcoinLocks.getLockById(7)!,
    release: bitcoinLocks.releases.getById('lock:7:1')!,
    releases: bitcoinLocks.releases,
    tracking: bitcoinLocks.utxoTracking,
  };
}

async function loadBitcoinLocksState(
  db: Awaited<ReturnType<typeof createTestDb>>,
  transactionTracker?: TransactionTracker,
  options: { walletKeys?: WalletKeys; mempool?: BitcoinMempool; blockWatch?: BlockWatch } = {},
): Promise<BitcoinLocks> {
  const bitcoinLocks = createStore({ db, transactionTracker, ...options });
  bitcoinLocks.data.bitcoinNetwork = BitcoinNetwork.Regtest;
  const lock = await db.bitcoinLocksTable.getByLockId(7);
  if (lock) bitcoinLocks.data.locksByLockId[7] = lock;
  bitcoinLocks.utxoTracking.load(await db.bitcoinUtxosTable.fetchAll());
  await bitcoinLocks.releases.load();
  return bitcoinLocks;
}

async function loadOrphanReleaseState(db: Awaited<ReturnType<typeof createTestDb>>, orphanUtxoId: number) {
  const tracking = createUtxoTracking(db);
  tracking.load(await db.bitcoinUtxosTable.fetchAll());
  const releases = new BitcoinReleases(
    {} as BitcoinLocks,
    Promise.resolve(db),
    tracking,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  await releases.load();
  return {
    lock: (await db.bitcoinLocksTable.getByLockId(8))!,
    orphan: tracking.getUtxoRecordById(orphanUtxoId)!,
    release: releases.getById('orphan-release-1')!,
    releases,
  };
}

function createUtxoTracking(db: Awaited<ReturnType<typeof createTestDb>>): BitcoinUtxoTracking {
  return new BitcoinUtxoTracking({
    dbPromise: Promise.resolve(db),
    getBitcoinNetwork: () => BitcoinNetwork.Regtest,
    getOracleBitcoinBlockHeight: () => 100,
    getConfig: () => undefined,
    getMainchainClient: async () => ({}) as ArgonClient,
    mempool: {} as never,
  });
}
