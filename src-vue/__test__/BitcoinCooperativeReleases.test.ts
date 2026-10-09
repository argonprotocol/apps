import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BitcoinNetwork, CosignScript, HDKey, Transaction } from '@argonprotocol/bitcoin';
import { Keyring, hexToU8a, u8aToHex } from '@argonprotocol/mainchain';
import {
  type ArgonQueryClient,
  type ArgonClient,
  MoveTo,
  type BlockWatch,
  SingleFileQueue,
  createDeferred,
  signBitcoinCooperativeReleaseRequest,
  bitcoinCooperativeReleaseRequestSchema,
  type IBitcoinCooperativeReleaseRequest,
  type RuntimeSystemEventRecord,
  JsonExt,
  BitcoinLock,
  type MiningFrames,
} from '@argonprotocol/apps-core';
import { Metadata, TypeRegistry } from '@polkadot/types';
import { getBundledMetadata, getHistoricalEventFields, runtimeClient } from '@argonprotocol/runtime-client';
import type { BitcoinLocksLocksByIdResultSpec159 } from '@argonprotocol/runtime-client';
import BigNumber from 'bignumber.js';
import * as Vue from 'vue';
import { BitcoinCooperativeReleases } from '../lib/BitcoinCooperativeReleases.ts';
import BitcoinMempool from '../lib/BitcoinMempool.ts';
import type { ServerApiClient } from '../lib/ServerApiClient.ts';
import { Db } from '../../router/src/Db.ts';
import { createTestDb } from './helpers/db.ts';
import { createStore, historyBlock, historyEvent } from './helpers/bitcoin.ts';
import { publishBitcoinHistoryReplay } from '../lib/recovery/index.ts';
import { BitcoinLockStatus } from '../interfaces/IBitcoinLockRecord.ts';
import { BitcoinReleaseStatus } from '../interfaces/IBitcoinReleaseRecord.ts';
import { BitcoinUtxoSpendStatus } from '../interfaces/IBitcoinUtxoRecord.ts';
import { UpstreamOperatorClient } from '../lib/UpstreamOperatorClient.ts';
import type { ServerAuthClient } from '../lib/ServerAuthClient.ts';
import type { WalletKeys } from '../lib/WalletKeys.ts';
import { MyVault } from '../lib/MyVault.ts';
import { WalletForBitcoin } from '../lib/WalletForBitcoin.ts';
import type { Vaults } from '../lib/Vaults.ts';
import type { GlobalCouncil } from '../lib/GlobalCouncil.ts';
import type { MintingAuthorities } from '../lib/MintingAuthorities.ts';
import type { TransactionTracker } from '../lib/TransactionTracker.ts';
import * as mainchain from '../stores/mainchain.ts';
import runtime159 from '../../runtime-client/__test__/fixtures/runtime-159.json' with { type: 'json' };

const bitcoinServers: Server[] = [];
const databases: Db[] = [];
afterEach(async () => {
  await Promise.all(
    bitcoinServers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))),
  );
  for (const db of databases.splice(0)) db.close();
  vi.restoreAllMocks();
});

// Component scenarios use real application state, SQLite, and signing with simulated chain observations.
// BitcoinCooperativeReleases.integration.test.ts exercises the return and compensation boundary on both real test chains.
describe('cooperative release approval with simulated chain observations', () => {
  it('uses standard payment output sizes and rejects nonminimal encodings', () => {
    const keyHash = '77'.repeat(20);
    const scriptHash = '88'.repeat(32);
    expect(BitcoinCooperativeReleases.getMinimumDestinationSatoshis(`0x0014${keyHash}`)).toBe(294n);
    expect(BitcoinCooperativeReleases.getMinimumDestinationSatoshis(`0x0020${scriptHash}`)).toBe(330n);
    expect(BitcoinCooperativeReleases.getMinimumDestinationSatoshis(`0x5120${scriptHash}`)).toBe(330n);
    expect(BitcoinCooperativeReleases.getMinimumDestinationSatoshis(`0x76a914${keyHash}88ac`)).toBe(546n);
    expect(BitcoinCooperativeReleases.getMinimumDestinationSatoshis(`0xa914${keyHash}87`)).toBe(540n);

    // These decode to known script types, but Bitcoin payment addresses do not produce these encodings.
    expect(() => BitcoinCooperativeReleases.getMinimumDestinationSatoshis(`0x004c14${keyHash}`)).toThrow('standard');
    expect(() => BitcoinCooperativeReleases.getMinimumDestinationSatoshis(`0xa94c14${keyHash}87`)).toThrow('standard');
  });

  it.each([110, 130, 158, 159])(
    'returns a skipped small output from a removed lock, but excludes compensated funding under spec %s',
    async specVersion => {
      const fixture = await createFixture(2_000n, specVersion);
      fixture.currentLock = null;
      const request = { ...fixture.request, removalBlockNumber: 180 };
      request.requestSignature = signBitcoinCooperativeReleaseRequest(fixture.account, request);
      // Full-release penalty: the accepted input stays unspent while Argon removes the lock and tracking.
      fixture.parentLock = {
        ...fixture.storage,
        fundedSatoshis: 2_000n,
        fundingUtxos: [[{ ...request.utxoRef, outputIndex: 1 }, 2_000n]],
      };
      await expect(fixture.cooperative.verifyRequest(request, fixture.client)).resolves.toMatchObject({ lockId: 42 });
      if (specVersion < 145) {
        const creation = fixture.creationEvents.splice(0);
        await expect(fixture.cooperative.verifyRequest(request, fixture.client)).rejects.toThrow('did not create');
        fixture.creationEvents.push(...creation);
      }
      fixture.parentLock = { ...fixture.parentLock, fundingUtxos: [[request.utxoRef, 2_000n]] };
      // A later minimum increase cannot turn previously compensated funding into a returnable output.
      await expect(fixture.cooperative.verifyRequest(request, fixture.client)).rejects.toThrow(
        'was funding it when removed',
      );
    },
  );

  it('returns a terminal rejection for an early mismatch penalty with no retained funding reference', async () => {
    const fixture = await createFixture(50_000n, 130, 100_000n);
    fixture.currentLock = null;
    fixture.parentRejectedNeedsRelease = true;
    fixture.removalEvents.push(
      historyEvent(130, 'bitcoinLocks', 'BitcoinCosignPastDue', {
        utxoId: 42,
        vaultId: 7,
        compensationAmount: 100n,
        compensatedAccountId: fixture.account.address,
      }),
    );
    const approved = fixture.db.bitcoinCooperativeReleasesTable.insert({
      ...fixture.request,
      removalBlockNumber: 180,
    });
    let reachedSigningKey = false;
    await fixture.cooperative.signAndDeliver({
      approved: [approved],
      server: fixture.server,
      vaultId: 7,
      cosignQueue: new SingleFileQueue(),
      sign: async () => {
        reachedSigningKey = true;
        throw new Error('Compensated Bitcoin must never reach the signing key.');
      },
    });
    expect(reachedSigningKey).toBe(false);
    expect(fixture.db.bitcoinCooperativeReleasesTable.fetch(approved.request.releaseId)).toMatchObject({
      operatorError: 'This lock paid Bitcoin compensation without a funding reference to exclude.',
    });
    expect(fixture.db.bitcoinCooperativeReleasesTable.pending(7).requests).toEqual([]);
  });

  it.each([false, true])(
    'refuses an accepted input resurrected after a partial-release reorg (removed=%s)',
    async removed => {
      const fixture = await createFixture();
      const request = { ...fixture.request, ...(removed ? { removalBlockNumber: 180 } : {}) };
      request.requestSignature = signBitcoinCooperativeReleaseRequest(fixture.account, request);
      const partial = {
        ...request,
        destinationSatoshis: 10_000n,
        changeSatoshis: request.satoshis - request.bitcoinNetworkFee - 10_000n,
      };
      const psbt = fixture.cosign.getCosignPsbt({
        releaseRequest: partial,
        utxos: [{ utxoRef: { txid: request.utxoRef.txid, vout: 0 }, satoshis: request.satoshis }],
      });
      const signature = fixture.cosign.vaultCosignPsbt(psbt, fixture.lock, fixture.vaultKey).getInput(0)
        .partialSig![0][1];
      const change = fixture.cosign.cosignAndGenerateTx({
        releaseRequest: partial,
        utxos: [{ utxoRef: { txid: request.utxoRef.txid, vout: 0 }, satoshis: request.satoshis }],
        vaultCosignatures: [signature],
        ownerXpriv: fixture.ownerKey,
      });
      // Argon replaces all accepted inputs with change, even without a submitted Argon cosign.
      const snapshot = {
        ...fixture.storage,
        fundedSatoshis: partial.changeSatoshis,
        fundingUtxos: [[{ txid: `0x${change.hash}`, outputIndex: 1 }, partial.changeSatoshis]],
      } as NonNullable<BitcoinLocksLocksByIdResultSpec159>;
      fixture.currentLock = removed ? null : snapshot;
      fixture.parentLock = snapshot;
      fixture.reorgedFundingTxid = `0x${change.hash}`;
      // Bitcoin undoes that spend; the original deposit and a later scanner checkpoint remain canonical.
      await expect(fixture.cooperative.verifyRequest(request, fixture.client)).rejects.toThrow('funding transaction');
      expect(fixture.db.bitcoinCooperativeReleasesTable.fetch(request.releaseId)).toBeUndefined();
    },
  );

  it.each([130, 158, 159])(
    'declines removed-lock funding changes and runtime upgrades under spec %s',
    async specVersion => {
      const fixture = await createFixture(50_000n, specVersion);
      fixture.currentLock = null;
      const request = { ...fixture.request, removalBlockNumber: 180 };
      request.requestSignature = signBitcoinCooperativeReleaseRequest(fixture.account, request);
      if (specVersion >= 159) {
        fixture.removalEvents.push(
          historyEvent(159, 'bitcoinUtxos', 'UtxoDetected', {
            lockId: 42,
            utxoRef: request.utxoRef,
            satoshisReceived: request.satoshis,
            bitcoinHeight: 100,
          }),
        );
      } else if (specVersion >= 147) {
        // Candidate promotion, followed by full release/cosign in this block, leaves neither lock nor ref.
        fixture.removalEvents.push(
          historyEvent(158, 'bitcoinLocks', 'UtxoFundedFromCandidate', {
            utxoId: 42,
            utxoRef: request.utxoRef,
            vaultId: 7,
            accountId: request.ownerAccount,
          }),
        );
      } else {
        const verified = { utxoId: 42, ...(specVersion >= 145 ? { satoshisReceived: request.satoshis } : {}) };
        fixture.removalEvents.push(historyEvent(specVersion, 'bitcoinUtxos', 'UtxoVerified', verified));
      }
      await expect(fixture.cooperative.verifyRequest(request, fixture.client)).rejects.toThrow('funding changes');
      fixture.removalEvents.splice(0);
      fixture.removalEvents.push(historyEvent(159, 'system', 'CodeUpdated', {}));
      await expect(fixture.cooperative.verifyRequest(request, fixture.client)).rejects.toThrow('runtime upgrade');
    },
  );

  it.each([false, true])(
    'resumes an owner return after restart and retires a rejected request (own vault=%s)',
    async ownVault => {
      const fixture = await createFixture(50_000n, ownVault ? 159 : 130);
      vi.spyOn(mainchain, 'getMainchainClient').mockResolvedValue(
        fixture.client as Awaited<ReturnType<typeof mainchain.getMainchainClient>>,
      );
      const appDb = await createTestDb();
      const walletKeys = {
        canSign: true,
        defaultArgonAddress: fixture.account.address,
        getBitcoinChildXpriv: async (path: string) => (path === 'vault' ? fixture.vaultKey : fixture.ownerKey),
      } as unknown as WalletKeys;
      const operator = new UpstreamOperatorClient(
        { getMemberSessionId: async () => 'synthetic-session' } as unknown as ServerAuthClient,
        () => fixture.bitcoinHost,
      );
      const store = createStore({
        db: appDb,
        blockWatch: fixture.blockWatch,
        mempool: fixture.mempool,
        walletKeys,
        upstreamOperator: operator,
      });
      store.data.bitcoinNetwork = BitcoinNetwork.Regtest;
      store.utxoTracking.data = Vue.reactive(store.utxoTracking.data);
      store.releases.data = Vue.reactive(store.releases.data);
      const pending = await appDb.bitcoinLocksTable.insertPending({
        uuid: 'cooperative-owner-lock',
        vaultId: 7,
        securitizedSatoshis: 50_000n,
        hdPath: 'owner',
        cosignVersion: 'v1',
        network: 'regtest',
        status: BitcoinLockStatus.LockPendingFunding,
      });
      const storedLock = BitcoinLock.fromRuntime(42, fixture.storage);
      let lock = await appDb.bitcoinLocksTable.finalizePending({
        uuid: pending.uuid,
        lock: storedLock,
      });
      store.data.locksByLockId[42] = lock;
      if (!ownVault) {
        await appDb.bitcoinLocksTable.setHistoryRecoveryPending(lock.uuid, true);
        lock.isHistoryRecoveryPending = true;
        await store.recovery.beginHistoryReplay({ lockScope: 'all' });
        await store.recovery.recoverBlock(historyBlock(123), fixture.creationEvents);
        await publishBitcoinHistoryReplay({ bitcoinLocks: store, asOfBlock: 123 });
        lock = store.getLockById(42)!;
        expect(lock.isHistoryRecoveryPending).toBeFalsy();
        expect(lock.createdAtArgonBlock).toBe(123);
        await store.utxoTracking.syncFundingUtxos(lock, BitcoinLock.fromRuntime(42, fixture.storage));
        expect(lock.createdAtArgonBlock).toBe(123);
        expect((await appDb.bitcoinLocksTable.getByLockId(42))?.createdAtArgonBlock).toBe(123);
      }
      const discovered = await store.utxoTracking.upsertUtxoRecord(
        lock,
        { txid: fixture.request.utxoRef.txid, vout: 0, satoshis: fixture.request.satoshis },
        { minimumSatoshis: 100_000n },
      );
      const input = store.utxoTracking.getUtxoRecordById(discovered.id)!;
      // Quote before an address is supplied. A valid return needs both its fee and a non-dust payment.
      const preview = { lock, record: input, feeRatePerSatVb: 5n };
      const { releaseRequest: quote } = store.releases.prepareCooperativeRelease(preview);
      expect(quote.bitcoinNetworkFee).toBe(fixture.request.bitcoinNetworkFee);
      const smallestReturn = { ...input, satoshis: quote.bitcoinNetworkFee + 294n };
      expect(
        store.releases.prepareCooperativeRelease({ ...preview, record: smallestReturn }).releaseRequest
          .destinationSatoshis,
      ).toBe(294n);
      expect(() =>
        store.releases.prepareCooperativeRelease({
          ...preview,
          record: { ...smallestReturn, satoshis: smallestReturn.satoshis - 1n },
        }),
      ).toThrow('spendable return');
      expect(() =>
        store.releases.prepareCooperativeRelease({ ...preview, record: smallestReturn, feeRatePerSatVb: 10n }),
      ).toThrow();
      expect(
        store.releases.prepareCooperativeRelease({ ...preview, record: smallestReturn, feeRatePerSatVb: 1n })
          .releaseRequest.destinationSatoshis,
      ).toBeGreaterThan(294n);
      expect(await appDb.bitcoinReleasesTable.fetchAll()).toEqual([]);

      const wallet = new WalletForBitcoin(
        () => store,
        () => fixture.account.address,
        {} as never,
      );
      const pendingFunding = Vue.computed(() => wallet.getPendingInboundUtxos());
      expect(pendingFunding.value.map(record => record.id)).toEqual([input.id]);
      if (ownVault) {
        const vault = new MyVault(
          Promise.resolve(appDb),
          {} as Vaults,
          walletKeys,
          {} as TransactionTracker,
          store,
          { blockWatch: fixture.blockWatch } as MiningFrames,
          {} as GlobalCouncil,
          {} as MintingAuthorities,
        );
        vault.data.createdVault = { vaultId: 7 } as NonNullable<typeof vault.data.createdVault>;
        vault.data.metadata = { id: 7, hdPath: 'vault' } as NonNullable<typeof vault.data.metadata>;
        fixture.failBitcoinBroadcast = true;
      } else fixture.loseMailboxResponse = true;
      const terms = {
        lock,
        record: input,
        toScriptPubkey: fixture.request.toScriptPubkey,
        feeRatePerSatVb: 5n,
        owner: fixture.account,
      };
      if (ownVault)
        await expect(store.releases.requestCooperativeRelease(terms)).rejects.toThrow('broadcast interrupted');
      else await store.releases.requestCooperativeRelease(terms);
      const persisted = (await appDb.bitcoinReleasesTable.fetchAll())[0];
      expect(persisted.cooperativeRequest?.requestSignature).toBeTruthy();
      expect((await appDb.bitcoinUtxosTable.fetchAll())[0].activeReleaseId).toBe(persisted.id);
      expect(pendingFunding.value).toEqual([]);
      if (!ownVault) {
        expect(persisted.status).toBe(BitcoinReleaseStatus.WaitingForVaultCosign);
        expect(fixture.db.bitcoinCooperativeReleasesTable.fetch(persisted.id)?.request).toEqual(
          persisted.cooperativeRequest,
        );
        fixture.currentLock = null;
        await fixture.cooperative.refresh({ server: fixture.server, vaultId: 7 });
        expect(fixture.db.bitcoinCooperativeReleasesTable.fetch(persisted.id)?.operatorError).toBeUndefined();
        expect(fixture.cooperative.data.requests[0].verificationError).toContain('known removal block');
        lock.removalBlockNumber = 180;
        await store.releases.reconcileDepositReleases(lock);
        const amended = fixture.db.bitcoinCooperativeReleasesTable.fetch(persisted.id)!;
        expect(amended.request.removalBlockNumber).toBe(180);
        expect(amended.request.requestSignature).toBe(persisted.cooperativeRequest?.requestSignature);
        expect(amended.request.expectedTransactionId).toBe(persisted.expectedTransactionId);

        const operatorDb = await createTestDb();
        const operatorStore = createStore({
          db: operatorDb,
          blockWatch: fixture.blockWatch,
          mempool: fixture.mempool,
          walletKeys,
        });
        const submitAndWatch = vi.fn();
        const tracker = {
          submitAndWatch,
          load: async () => undefined,
          pendingBlockTxInfosAtLoad: [],
          data: { txInfosByType: {} },
        } as unknown as TransactionTracker;
        const council = {
          load: async () => undefined,
          refresh: async () => [],
          data: { pendingApprovals: [] },
        } as unknown as GlobalCouncil;
        const operatorVaults = {
          vaultsById: { 7: { vaultId: 7 } },
          load: async () => undefined,
          updateVaultRevenue: async () => undefined,
        } as unknown as Vaults;
        const vault = new MyVault(
          Promise.resolve(operatorDb),
          operatorVaults,
          walletKeys,
          tracker,
          operatorStore,
          {
            blockWatch: fixture.blockWatch,
            load: async () => undefined,
            currentFrameId: 0,
            getFrameDate: () => new Date('2026-10-06T12:00:00Z'),
          } as unknown as MiningFrames,
          council,
          { load: async () => undefined } as unknown as MintingAuthorities,
          () => fixture.server,
        );
        await operatorDb.vaultsTable.insert({ id: 7, hdPath: 'vault', createdAtBlockHeight: 1, isClosed: false });
        await vault.load();
        vi.spyOn(mainchain, 'getFinalizedClient').mockResolvedValue(fixture.client);
        await operatorStore.cooperativeReleases.refresh({ server: fixture.server, vaultId: 7 });
        await expect(vault.collect({ moveTo: MoveTo.DefaultArgon })).resolves.toBeUndefined();
        const delivered = fixture.db.bitcoinCooperativeReleasesTable.fetch(persisted.id)!;
        expect(delivered.vaultSignatureHex).toBeTruthy();
        expect(submitAndWatch).not.toHaveBeenCalled();
        expect(vault.data.bitcoinCosignRefreshError).toBe('');
        expect(operatorStore.cooperativeReleases.data.isSigning).toBe(false);
      } else {
        expect(persisted.status).toBe(BitcoinReleaseStatus.ReadyForBitcoinBroadcast);
        expect(persisted.bitcoinTxid).toBe(persisted.cooperativeRequest?.expectedTransactionId);
        expect(fixture.db.bitcoinCooperativeReleasesTable.pending(7).requests).toEqual([]);
      }
      const restarted = createStore({
        db: appDb,
        blockWatch: fixture.blockWatch,
        mempool: fixture.mempool,
        walletKeys,
        upstreamOperator: operator,
      });
      restarted.data.bitcoinNetwork = BitcoinNetwork.Regtest;
      restarted.utxoTracking.data = Vue.reactive(restarted.utxoTracking.data);
      restarted.releases.data = Vue.reactive(restarted.releases.data);
      restarted.data.locksByLockId[42] = (await appDb.bitcoinLocksTable.getByLockId(42))!;
      expect(restarted.data.locksByLockId[42].createdAtArgonBlock).toBe(123);
      restarted.utxoTracking.load(await appDb.bitcoinUtxosTable.fetchAll());
      await restarted.releases.load();
      const restartedWallet = new WalletForBitcoin(
        () => restarted,
        () => fixture.account.address,
        {} as never,
      );
      const restartedFunding = Vue.computed(() => restartedWallet.getPendingInboundUtxos());
      expect(restartedFunding.value).toEqual([]);
      await restarted.releases.reconcileDepositReleases(restarted.data.locksByLockId[42]);
      const resumed = restarted.releases.getById(persisted.id)!;
      expect(resumed.cooperativeRequest).toEqual({
        ...persisted.cooperativeRequest,
        ...(ownVault ? {} : { removalBlockNumber: 180 }),
      });
      expect(resumed.status).toBe(BitcoinReleaseStatus.ConfirmingOnBitcoin);
      const sent = Transaction.fromRaw(hexToU8a(fixture.broadcasts.at(-1)));
      expect(`0x${sent.hash}`).toBe(persisted.cooperativeRequest?.expectedTransactionId);
      expect(sent.getOutput(0).amount).toBe(persisted.destinationSatoshis);
      fixture.returnConfirmed = true;
      await restarted.releases.syncDepositBitcoinProcessing(120);
      expect(await appDb.bitcoinReleasesTable.fetchAll()).toEqual([
        expect.objectContaining({ status: BitcoinReleaseStatus.Complete }),
      ]);
      expect((await appDb.bitcoinUtxosTable.fetchAll())[0]).toMatchObject({
        spendStatus: BitcoinUtxoSpendStatus.Spent,
        spentByReleaseId: persisted.id,
      });
      expect(restarted.utxoTracking.getUtxoRecordById(input.id)?.activeReleaseId).toBeUndefined();
      expect(restartedFunding.value).toEqual([]);

      if (ownVault) return;
      const secondInput = await restarted.utxoTracking.upsertUtxoRecord(
        lock,
        { txid: fixture.request.utxoRef.txid, vout: 1, satoshis: fixture.request.satoshis },
        { minimumSatoshis: 100_000n },
      );
      const rejected = await restarted.releases.requestCooperativeRelease({ ...terms, record: secondInput });
      // Argon accepts the second output while the owner waits, so the vault must refuse it.
      const acceptedFunding: NonNullable<BitcoinLocksLocksByIdResultSpec159> = {
        ...fixture.storage,
        fundedSatoshis: secondInput.satoshis,
        fundingUtxos: [
          [{ txid: secondInput.txid, outputIndex: 1 }, secondInput.satoshis],
        ] as NonNullable<BitcoinLocksLocksByIdResultSpec159>['fundingUtxos'],
      };
      fixture.currentLock = acceptedFunding;
      await fixture.cooperative.refresh({ finalizedClient: fixture.client, server: fixture.server, vaultId: 7 });
      await restarted.releases.reconcileDepositReleases(lock);
      expect(await appDb.bitcoinReleasesTable.getById(rejected.id)).toMatchObject({
        status: BitcoinReleaseStatus.Failed,
        statusError: 'This deposit is funding the lock or was funding it when removed.',
        cooperativeRequest: rejected.cooperativeRequest,
      });
      expect(
        (await appDb.bitcoinUtxosTable.getByLockOutpoint(42, secondInput.txid, 1))?.activeReleaseId,
      ).toBeUndefined();
      expect(fixture.broadcasts).toHaveLength(1);

      const afterRejection = createStore({ db: appDb });
      afterRejection.utxoTracking.data = Vue.reactive(afterRejection.utxoTracking.data);
      afterRejection.releases.data = Vue.reactive(afterRejection.releases.data);
      afterRejection.data.locksByLockId[42] = (await appDb.bitcoinLocksTable.getByLockId(42))!;
      afterRejection.utxoTracking.load(await appDb.bitcoinUtxosTable.fetchAll());
      await afterRejection.releases.load();
      const reloadedInput = afterRejection.utxoTracking.getUtxoRecordById(secondInput.id)!;
      expect(afterRejection.releases.getLatestForUtxo(reloadedInput)).toMatchObject({
        status: BitcoinReleaseStatus.Failed,
        cooperativeRequest: rejected.cooperativeRequest,
      });
      expect(afterRejection.releases.canRequestDepositReturn(lock, reloadedInput)).toBe(false);
      const reloadedWallet = new WalletForBitcoin(
        () => afterRejection,
        () => fixture.account.address,
        {} as never,
      );
      const fundingAfterRejection = Vue.computed(() => reloadedWallet.getPendingInboundUtxos());
      const unattachedAfterRejection = Vue.computed(() => reloadedWallet.getUnattachedDeposits());
      expect(fundingAfterRejection.value.map(record => record.id)).toEqual([secondInput.id]);
      expect(unattachedAfterRejection.value.map(record => record.id)).toEqual([secondInput.id]);
      await afterRejection.utxoTracking.syncFundingUtxos(
        afterRejection.data.locksByLockId[42],
        BitcoinLock.fromRuntime(42, acceptedFunding),
      );
      expect(fundingAfterRejection.value).toEqual([]);
      expect(unattachedAfterRejection.value).toEqual([]);
      expect(await appDb.bitcoinReleasesTable.getById(rejected.id)).toMatchObject({
        status: BitcoinReleaseStatus.Failed,
        cooperativeRequest: rejected.cooperativeRequest,
      });
    },
  );
  it('signs the exact approved Bitcoin transaction when an unrelated runtime version changes while queued', async () => {
    const fixture = await createFixture();
    const { cooperative, client, server, db, request, cosign, vaultKey, ownerKey } = fixture;
    const second = { ...request, releaseId: 'later-return', utxoRef: { ...request.utxoRef, outputIndex: 1 } };
    const secondPsbt = cosign.getCosignPsbt({
      releaseRequest: second,
      utxos: [{ utxoRef: { txid: second.utxoRef.txid, vout: 1 }, satoshis: second.satoshis }],
    });
    second.expectedTransactionId = `0x${createHash('sha256').update(createHash('sha256').update(secondPsbt.unsignedTx).digest()).digest('hex')}`;
    second.requestSignature = signBitcoinCooperativeReleaseRequest(fixture.account, second);
    db.bitcoinCooperativeReleasesTable.insert(request);
    db.bitcoinCooperativeReleasesTable.insert(second);
    await cooperative.refresh({ finalizedClient: client, server, vaultId: 7 });
    expect(cooperative.data.requests.every(record => !record.verificationError)).toBe(true);
    const approved = cooperative.data.requests.slice(0, 1);
    const queue = new SingleFileQueue();
    const queuedWork = createDeferred();
    const previous = queue.add(() => queuedWork.promise).promise;
    const queuedSigning = vi.spyOn(queue, 'add');
    const delivery = cooperative.signAndDeliver({
      approved,
      server,
      vaultId: 7,
      cosignQueue: queue,
      sign: async (terms, verifiedLock) => {
        const signer = new CosignScript(verifiedLock, BitcoinNetwork.Regtest);
        const psbt = signer.getCosignPsbt({
          releaseRequest: terms,
          utxos: [{ utxoRef: { txid: terms.utxoRef.txid, vout: terms.utxoRef.outputIndex }, satoshis: terms.satoshis }],
        });
        const [publicKey, signature] = signer.vaultCosignPsbt(psbt, verifiedLock, vaultKey).getInput(0).partialSig![0];
        expect(u8aToHex(publicKey)).toBe(verifiedLock.vaultPubkey);
        expect(u8aToHex(publicKey)).not.toBe(verifiedLock.vaultClaimPubkey);
        expect(signature.at(-1)).toBe(1); // SIGHASH_ALL binds every input and output.
        return u8aToHex(signature);
      },
    });
    await vi.waitFor(() => expect(queuedSigning).toHaveBeenCalledOnce());
    // Only the version number changes; the queried Bitcoin state and native storage codecs are unchanged.
    fixture.currentRuntimeSpecVersion = client.runtimeVersion.specVersion.toNumber() + 2;
    queuedWork.resolve();
    await previous;
    await delivery;
    const delivered = db.bitcoinCooperativeReleasesTable.fetch(request.releaseId)!;
    expect(delivered.vaultSignatureHex).toBeDefined();
    const transaction = cosign.cosignAndGenerateTx({
      releaseRequest: request,
      vaultCosignatures: [hexToU8a(delivered.vaultSignatureHex)],
      utxos: [{ utxoRef: { txid: request.utxoRef.txid, vout: 0 }, satoshis: request.satoshis }],
      ownerXpriv: ownerKey,
    });
    expect(transaction.isFinal).toBe(true);
    expect(`0x${transaction.hash}`).toBe(request.expectedTransactionId);
    expect(transaction.getOutput(0).amount).toBe(request.destinationSatoshis);
    expect(transaction.outputsLength).toBe(1);
    expect(cooperative.data.requests.map(record => record.request.releaseId)).toEqual(['later-return']);
    expect(db.bitcoinCooperativeReleasesTable.fetch(second.releaseId)?.vaultSignatureHex).toBeUndefined();

    expect(cooperative.data.isSigning).toBe(false);
  });

  it('rejects an owner-approved deposit to an altered claim script before accessing the vault key', async () => {
    const fixture = await createFixture();
    const { cooperative, server, db, cosign } = fixture;
    const request = {
      ...fixture.request,
      utxoRef: { ...fixture.request.utxoRef, outputIndex: 2 },
    };
    const psbt = cosign.getCosignPsbt({
      releaseRequest: request,
      utxos: [{ utxoRef: { txid: request.utxoRef.txid, vout: 2 }, satoshis: request.satoshis }],
    });
    request.expectedTransactionId = `0x${createHash('sha256').update(createHash('sha256').update(psbt.unsignedTx).digest()).digest('hex')}`;
    request.requestSignature = signBitcoinCooperativeReleaseRequest(fixture.account, request);
    const approved = db.bitcoinCooperativeReleasesTable.insert(request);
    let reachedSigningKey = false;

    await cooperative.signAndDeliver({
      approved: [approved],
      server,
      vaultId: 7,
      cosignQueue: new SingleFileQueue(),
      sign: async () => {
        reachedSigningKey = true;
        throw new Error('A foreign Bitcoin script must never reach the signing key.');
      },
    });

    const response = db.bitcoinCooperativeReleasesTable.fetch(request.releaseId)!;
    expect(response.operatorError).toContain('amount or script does not match');
    expect(response.vaultSignatureHex).toBeUndefined();
    expect(db.bitcoinCooperativeReleasesTable.pending(7).requests).toEqual([]);
    expect(reachedSigningKey).toBe(false);
  });

  it.each(['funding accepted', 'lock removed after penalty'])(
    'rejects a previously checked request when %s before signing',
    async state => {
      const fixture = await createFixture();
      const { cooperative, client, server, db } = fixture;
      const request = { ...fixture.request, removalBlockNumber: 180 };
      db.bitcoinCooperativeReleasesTable.insert(request);
      await cooperative.refresh({ finalizedClient: client, server, vaultId: 7 });
      expect(cooperative.data.requests[0].verificationError).toBeUndefined();
      const approved = cooperative.data.requests.slice();
      const queue = new SingleFileQueue();
      const queuedWork = createDeferred();
      const previous = queue.add(() => queuedWork.promise).promise;
      const queuedSigning = vi.spyOn(queue, 'add');
      let reachedSigningKey = false;
      const signing = cooperative.signAndDeliver({
        approved,
        server,
        vaultId: 7,
        cosignQueue: queue,
        sign: async () => {
          reachedSigningKey = true;
          throw new Error('Managed Bitcoin must use the on-chain release flow.');
        },
      });
      await vi.waitFor(() => expect(queuedSigning).toHaveBeenCalledOnce());

      // A request that was safe to approve can become managed while waiting for another cosign.
      if (state === 'funding accepted') {
        fixture.currentLock = {
          ...fixture.storage,
          fundedSatoshis: request.satoshis,
          fundingUtxos: [[request.utxoRef, request.satoshis]],
        };
      } else {
        // The full-release penalty removes the lock from finalized runtime storage.
        fixture.currentLock = null;
        fixture.parentLock = {
          ...fixture.storage,
          fundedSatoshis: request.satoshis,
          fundingUtxos: [[request.utxoRef, request.satoshis]],
        };
      }
      queuedWork.resolve();
      await previous;
      await signing;

      const response = db.bitcoinCooperativeReleasesTable.fetch(request.releaseId)!;
      if (state === 'funding accepted') expect(response.operatorError).toContain('funding the lock');
      else expect(response.operatorError).toContain('was funding it when removed');
      expect(response.vaultSignatureHex).toBeUndefined();
      expect(db.bitcoinCooperativeReleasesTable.pending(7).requests).toEqual([]);
      expect(cooperative.data.requests).toEqual([]);
      expect(reachedSigningKey).toBe(false);
    },
  );

  it('preserves displayed requests after transport failure and rejects the cursor boundary, removed locks, altered terms, and false amounts', async () => {
    const fixture = await createFixture();
    const { cooperative, client, server, request, db } = fixture;
    db.bitcoinCooperativeReleasesTable.insert(request);
    await cooperative.refresh({ finalizedClient: client, server, vaultId: 7 });
    expect(cooperative.data.requests[0].verificationError).toBeUndefined();
    const read = vi
      .spyOn(server, 'getPendingBitcoinCooperativeReleases')
      .mockRejectedValue(new Error('Server unavailable.'));
    await cooperative.refresh({ finalizedClient: client, server, vaultId: 7 });
    expect(cooperative.data.requests[0].request.releaseId).toBe(request.releaseId);
    expect(cooperative.data.refreshError).toBe('Server unavailable.');
    expect(cooperative.data.isRefreshing).toBe(false);
    read.mockRestore();
    fixture.cursor.blockHeight = 100;
    fixture.depositConfirmed = false;
    await expect(cooperative.getDepositConfirmationWait({ txid: request.utxoRef.txid })).resolves.toBe('Bitcoin');
    fixture.depositConfirmed = true;
    await expect(cooperative.getDepositConfirmationWait({ txid: request.utxoRef.txid })).resolves.toBe('Argon');
    await cooperative.refresh({ finalizedClient: client, server, vaultId: 7 });
    expect(cooperative.data.requests[0].verificationError).toContain('Argon is still checking this deposit.');
    expect(db.bitcoinCooperativeReleasesTable.fetch(request.releaseId)?.operatorError).toBeUndefined();
    expect(db.bitcoinCooperativeReleasesTable.pending(7).requests).toHaveLength(1);
    fixture.cursor.blockHeight = 101;
    await expect(cooperative.getDepositConfirmationWait({ txid: request.utxoRef.txid })).resolves.toBeUndefined();
    fixture.currentLock = null;
    await expect(cooperative.verifyRequest(request, client)).rejects.toThrow('known removal block');
    fixture.currentLock = fixture.storage;
    await expect(
      cooperative.verifyRequest({ ...request, destinationSatoshis: request.destinationSatoshis - 1n }, client),
    ).rejects.toThrow('authorization');
    const small = { ...request, satoshis: 500n, destinationSatoshis: 1n, bitcoinNetworkFee: 499n };
    small.requestSignature = signBitcoinCooperativeReleaseRequest(fixture.account, small);
    // Actual prevout verification comes before fee/dust rejection, so false claimed amounts cannot reach signing.
    await expect(cooperative.verifyRequest(small, client)).rejects.toThrow('amount or script');
    await cooperative.refresh({ finalizedClient: client, server, vaultId: 7 });
    expect(cooperative.data.refreshError).toBe('');
    expect(cooperative.data.requests[0].verificationError).toBeUndefined();
  });
  it('retries a failed rejection delivery, then returns the terminal dust rejection to the sender', async () => {
    const normal = await createFixture();
    const fixture = await createFixture(normal.request.bitcoinNetworkFee + 100n);
    const { cooperative, client, server, request, db } = fixture;
    db.bitcoinCooperativeReleasesTable.insert(request);
    const delivery = vi
      .spyOn(server, 'respondToBitcoinCooperativeRelease')
      .mockRejectedValueOnce(new Error('Mailbox unavailable.'));
    await cooperative.refresh({ finalizedClient: client, server, vaultId: 7 });
    expect(cooperative.data.requests[0].verificationError).toBe('Mailbox unavailable.');
    expect(db.bitcoinCooperativeReleasesTable.fetch(request.releaseId)?.operatorError).toBeUndefined();
    expect(db.bitcoinCooperativeReleasesTable.pending(7).requests).toHaveLength(1);
    delivery.mockRestore();

    await cooperative.refresh({ finalizedClient: client, server, vaultId: 7 });
    expect(db.bitcoinCooperativeReleasesTable.fetch(request.releaseId)?.operatorError).toContain('too small');
    expect(db.bitcoinCooperativeReleasesTable.pending(7).requests).toEqual([]);
    expect(cooperative.data.requests).toEqual([]);
  });

  it('keeps the signature durable when delivery acknowledgment is lost and reconciles it on the next mailbox check', async () => {
    const fixture = await createFixture();
    const { cooperative, client, server, request, db, vaultKey, cosign, ownerKey } = fixture;
    db.bitcoinCooperativeReleasesTable.insert(request);
    await cooperative.refresh({ finalizedClient: client, server, vaultId: 7 });
    const respond = vi.spyOn(server, 'respondToBitcoinCooperativeRelease').mockImplementation(async (id, response) => {
      db.bitcoinCooperativeReleasesTable.respond(id, response);
      throw new Error('Connection lost after the server stored the response.');
    });
    await cooperative.signAndDeliver({
      approved: cooperative.data.requests,
      server,
      vaultId: 7,
      cosignQueue: new SingleFileQueue(),
      sign: async (terms, verifiedLock) => {
        const signer = new CosignScript(verifiedLock, BitcoinNetwork.Regtest);
        const psbt = signer.getCosignPsbt({
          releaseRequest: terms,
          utxos: [{ utxoRef: { txid: terms.utxoRef.txid, vout: terms.utxoRef.outputIndex }, satoshis: terms.satoshis }],
        });
        return u8aToHex(signer.vaultCosignPsbt(psbt, verifiedLock, vaultKey).getInput(0).partialSig![0][1]);
      },
    });
    const delivered = db.bitcoinCooperativeReleasesTable.fetch(request.releaseId)!;
    expect(cooperative.data.requests[0].verificationError).toContain('Connection lost');
    expect(cooperative.data.deliveryMessage).toContain('next check');
    expect(cooperative.data.isSigning).toBe(false);
    const transaction = cosign.cosignAndGenerateTx({
      releaseRequest: request,
      vaultCosignatures: [hexToU8a(delivered.vaultSignatureHex)],
      utxos: [{ utxoRef: { txid: request.utxoRef.txid, vout: 0 }, satoshis: request.satoshis }],
      ownerXpriv: ownerKey,
    });
    expect(`0x${transaction.hash}`).toBe(request.expectedTransactionId);
    expect(delivered.operatorError).toBeUndefined();

    respond.mockRestore();
    await cooperative.refresh({ finalizedClient: client, server, vaultId: 7 });
    expect(cooperative.data.requests).toEqual([]);
    expect(cooperative.data.refreshError).toBe('');
    expect(cooperative.data.deliveryMessage).toBe('');
    expect(db.bitcoinCooperativeReleasesTable.fetch(request.releaseId)?.vaultSignatureHex).toBe(
      delivered.vaultSignatureHex,
    );
  });
  it('leaves loading with an actionable error when Bitcoin sends headers but stalls the transaction body', async () => {
    const fixture = await createFixture();
    const { cooperative, client, server, request, db } = fixture;
    db.bitcoinCooperativeReleasesTable.insert(request);
    fixture.stallRawTransaction = true;
    await cooperative.refresh({ finalizedClient: client, server, vaultId: 7 });
    expect(cooperative.data.isRefreshing).toBe(false);
    expect(cooperative.data.requests[0].verificationError).toContain('timeout');
    expect(db.bitcoinCooperativeReleasesTable.fetch(request.releaseId)?.vaultSignatureHex).toBeUndefined();
    expect(db.bitcoinCooperativeReleasesTable.fetch(request.releaseId)?.operatorError).toBeUndefined();
    fixture.stallRawTransaction = false;
    await cooperative.refresh({ finalizedClient: client, server, vaultId: 7 });
    expect(cooperative.data.requests[0].verificationError).toBeUndefined();
  });
  it('delivers a cosignature using the fresh Bitcoin scan after waiting in the signing queue', async () => {
    const fixture = await createFixture();
    const { cooperative, request, server, db, client, cosign, vaultKey, ownerKey } = fixture;
    db.bitcoinCooperativeReleasesTable.insert(request);
    await cooperative.refresh({ finalizedClient: client, server, vaultId: 7 });
    const queue = new SingleFileQueue();
    const queuedWork = createDeferred();
    const previous = queue.add(() => queuedWork.promise).promise;
    const queuedSigning = vi.spyOn(queue, 'add');
    const signing = cooperative.signAndDeliver({
      approved: [db.bitcoinCooperativeReleasesTable.fetch(request.releaseId)!],
      server,
      vaultId: 7,
      cosignQueue: queue,
      sign: async (terms, verifiedLock) => {
        const signer = new CosignScript(verifiedLock, BitcoinNetwork.Regtest);
        const psbt = signer.getCosignPsbt({
          releaseRequest: terms,
          utxos: [{ utxoRef: { txid: terms.utxoRef.txid, vout: terms.utxoRef.outputIndex }, satoshis: terms.satoshis }],
        });
        return u8aToHex(signer.vaultCosignPsbt(psbt, verifiedLock, vaultKey).getInput(0).partialSig![0][1]);
      },
    });
    await vi.waitFor(() => expect(queuedSigning).toHaveBeenCalledOnce());
    fixture.cursor.blockHeight = 102;
    fixture.cursor.blockHash = `0x${'46'.repeat(32)}`;
    queuedWork.resolve();
    await previous;
    await signing;
    const delivered = db.bitcoinCooperativeReleasesTable.fetch(request.releaseId)!;
    expect(delivered.vaultSignatureHex).toBeDefined();
    expect(db.bitcoinCooperativeReleasesTable.fetch(request.releaseId)?.operatorError).toBeUndefined();
    const transaction = cosign.cosignAndGenerateTx({
      releaseRequest: request,
      vaultCosignatures: [hexToU8a(delivered.vaultSignatureHex)],
      utxos: [{ utxoRef: { txid: request.utxoRef.txid, vout: 0 }, satoshis: request.satoshis }],
      ownerXpriv: ownerKey,
    });
    expect(transaction.isFinal).toBe(true);
    expect(`0x${transaction.hash}`).toBe(request.expectedTransactionId);
    expect(transaction.getOutput(0).amount).toBe(request.destinationSatoshis);
    expect(db.bitcoinCooperativeReleasesTable.pending(7).requests).toEqual([]);
    expect(cooperative.data.requests).toEqual([]);
    expect(cooperative.data.isSigning).toBe(false);
    await cooperative.refresh({ finalizedClient: client, server, vaultId: 7 });
    expect(cooperative.data.requests).toEqual([]);
  });
});

async function createFixture(inputSatoshis = 50_000n, historicalSpecVersion = 159, requestedSatoshis = inputSatoshis) {
  const vaultKey = HDKey.fromMasterSeed(new Uint8Array(32).fill(1));
  const ownerKey = HDKey.fromMasterSeed(new Uint8Array(32).fill(2));
  const account = new Keyring({ type: 'sr25519' }).addFromUri('//CooperativeReleaseOwner');
  const lock = {
    lockId: 42,
    vaultId: 7,
    ownerAccount: account.address,
    createdAtArgonBlock: 123,
    createdAtHeight: 50,
    vaultClaimHeight: 1_000,
    openClaimHeight: 2_000,
    fundedSatoshis: 0n,
    securitizedSatoshis: requestedSatoshis,
    vaultPubkey: u8aToHex(vaultKey.deriveChild(0).publicKey),
    vaultClaimPubkey: u8aToHex(vaultKey.deriveChild(1).publicKey),
    ownerPubkey: u8aToHex(ownerKey.publicKey),
    vaultXpubSources: { parentFingerprint: vaultKey.identifier!.slice(0, 4), cosignHdIndex: 0, claimHdIndex: 1 },
    p2wshScriptHashHex: '',
  };
  const cosign = new CosignScript(lock, BitcoinNetwork.Regtest);
  lock.p2wshScriptHashHex = cosign.calculateScriptPubkey();
  const storage: NonNullable<BitcoinLocksLocksByIdResultSpec159> = {
    vaultId: 7,
    ownerAccount: account.address,
    securitizationBasis: { satoshis: requestedSatoshis, microgonsAtTargetPerBtc: 1_000n },
    securitizationCoverageMicrogons: 0n,
    securitizationTick: 123,
    fundedSatoshis: 0n,
    fundingUtxos: [],
    fissionedSatoshis: 0n,
    securitizationRatio: new BigNumber(1),
    securityFees: 0n,
    couponPaidFees: 0n,
    vaultPubkey: lock.vaultPubkey,
    vaultClaimPubkey: lock.vaultClaimPubkey,
    ownerPubkey: lock.ownerPubkey,
    vaultXpubSources: [u8aToHex(lock.vaultXpubSources.parentFingerprint), 0, 1],
    vaultClaimHeight: 1_000,
    openClaimHeight: 2_000,
    createdAtHeight: 50,
    securitizationHoldExpirationBitcoinHeight: 200,
    createdAtArgonBlock: historicalSpecVersion < 145 ? 0 : 123,
    isFlexible: false,
    fundHoldExtensions: {},
    utxoScriptPubkey: { type: 'P2WSH', value: { wscriptHash: `0x${lock.p2wshScriptHashHex.slice(-64)}` } },
  };
  const previous = new Transaction({ allowUnknownInputs: true, allowUnknownOutputs: true });
  previous.addInput({ txid: new Uint8Array(32).fill(3), index: 0 });
  previous.addOutput({ amount: inputSatoshis, script: hexToU8a(lock.p2wshScriptHashHex) });
  previous.addOutput({ amount: inputSatoshis, script: hexToU8a(lock.p2wshScriptHashHex) });
  // The same vault keys can participate in a different script; only the Argon lock's exact script is eligible.
  const outsideScript = new CosignScript(
    { ...lock, vaultClaimHeight: lock.vaultClaimHeight + 1 },
    BitcoinNetwork.Regtest,
  );
  previous.addOutput({ amount: inputSatoshis, script: hexToU8a(outsideScript.calculateScriptPubkey()) });
  previous.updateInput(0, { finalScriptSig: new Uint8Array([0x51]) });
  const destination = `0x0014${'12'.repeat(20)}`;
  const fee = cosign.calculateFee(5n, 1, destination, false);
  const request: IBitcoinCooperativeReleaseRequest = {
    version: 1,
    releaseId: 'approved-return',
    lockId: 42,
    vaultId: 7,
    ownerAccount: account.address,
    createdAtArgonBlock: 123,
    utxoRef: { txid: `0x${previous.hash}`, outputIndex: 0 },
    satoshis: inputSatoshis,
    toScriptPubkey: destination,
    bitcoinNetworkFee: fee,
    feeRatePerSatVb: 5n,
    destinationSatoshis: inputSatoshis - fee,
    changeSatoshis: 0n,
    expectedTransactionId: '',
    requestSignature: '',
  };
  const psbt = cosign.getCosignPsbt({
    releaseRequest: request,
    utxos: [{ utxoRef: { txid: request.utxoRef.txid, vout: 0 }, satoshis: request.satoshis }],
  });
  request.expectedTransactionId = `0x${createHash('sha256').update(createHash('sha256').update(psbt.unsignedTx).digest()).digest('hex')}`;
  request.requestSignature = signBitcoinCooperativeReleaseRequest(account, request);
  const cursor = { blockHeight: 101, blockHash: `0x${'45'.repeat(32)}` };
  const fixture = {
    currentLock: storage as BitcoinLocksLocksByIdResultSpec159,
    parentLock: { ...storage },
    parentRejectedNeedsRelease: false,
    removalEvents: [] as RuntimeSystemEventRecord[],
    stallRawTransaction: false,
    loseMailboxResponse: false,
    failBitcoinBroadcast: false,
    returnConfirmed: false,
    depositConfirmed: true,
    broadcasts: [] as string[],
    reorgedFundingTxid: '',
    currentRuntimeSpecVersion: 159,
  };
  const query = {
    system: { number: async () => 200 },
    vaults: {
      pendingCosignByVaultId: async () => [],
      orphanedUtxoAccountsByVaultId: { entries: async () => [] },
      revenuePerFrameByVault: async () => [],
      argonotCommitmentByVaultId: async () => null,
    },
    bitcoinLocks: {
      locksById: Object.assign(async () => fixture.currentLock, { multi: async () => [] }),
      lockIdsByVaultId: { keys: async () => [] },
      orphanedUtxosByAccount: async () => null,
      lockReleaseRequestsById: async () => null,
      pendingPartialReleaseByLockId: async () => null,
      minimumSatoshis: async () => 100_000n,
    },
    bitcoinUtxos: {
      bitcoinNetwork: async () => ({ type: 'Regtest' }),
      utxoRefsByLockId: async () => [],
      synchedBitcoinBlock: async () => ({ ...cursor }),
    },
  };
  // Decode real storage codecs through the production runtime client, including every historical shape.
  const metadataByRuntime = getBundledMetadata();
  const historicalRegistry = new TypeRegistry();
  const historicalMetadata = Object.entries(metadataByRuntime).find(([key]) =>
    key.endsWith(`-${historicalSpecVersion}`),
  )![1];
  historicalRegistry.setMetadata(new Metadata(historicalRegistry, historicalMetadata), undefined, undefined, true);

  const liveRegistry = new TypeRegistry();
  const liveMetadata = Object.entries(metadataByRuntime).find(([key]) =>
    key.endsWith(`-${runtime159.specVersion}`),
  )![1];
  liveRegistry.setMetadata(new Metadata(liveRegistry, liveMetadata), undefined, undefined, true);

  const lockCodec = (codecRegistry: TypeRegistry, snapshot: BitcoinLocksLocksByIdResultSpec159) => {
    const pallet = codecRegistry.metadata.pallets.find(pallet => pallet.name.eq('BitcoinLocks'))!;
    const item = pallet.storage
      .unwrap()
      .items.find(item => item.name.eq('LocksById') || item.name.eq('LocksByUtxoId'))!;
    const type = `Option<Lookup${item.type.asMap.value.toNumber()}>`;
    if (!snapshot) return codecRegistry.createType(type, null);
    return codecRegistry.createType(type, {
      ...snapshot,
      fundingUtxos: new Map(snapshot.fundingUtxos),
      obligationId: 1n,
      lockPrice: snapshot.securitizationBasis.microgonsAtTargetPerBtc,
      peggedPrice: snapshot.securitizationBasis.microgonsAtTargetPerBtc,
      lockedMarketRate: snapshot.securitizationBasis.microgonsAtTargetPerBtc,
      lockedTargetPrice: snapshot.securitizationBasis.microgonsAtTargetPerBtc,
      liquidityPromised: 0n,
      satoshis: snapshot.securitizationBasis.satoshis,
      utxoSatoshis: snapshot.fundedSatoshis || null,
      isVerified: snapshot.fundedSatoshis > 0n,
      isFunded: snapshot.fundedSatoshis > 0n,
      isRejectedNeedsRelease: snapshot === fixture.parentLock && fixture.parentRejectedNeedsRelease,
      securitizationRatio: 1_000_000_000_000_000_000n,
      utxoScriptPubkey: { P2WSH: snapshot.utxoScriptPubkey.value },
    });
  };
  const live = runtimeClient({
    query: {
      ...query,
      ticks: { genesisTicker: async () => ({ tickDurationMillis: 60_000 }) },
      vaults: {
        ...query.vaults,
        vaultsById: async () => liveRegistry.createType('ArgonPrimitivesVault'),
      },
      bitcoinLocks: {
        ...query.bitcoinLocks,
        locksById: Object.assign(async () => lockCodec(liveRegistry, fixture.currentLock), { multi: async () => [] }),
      },
    },
    get runtimeVersion() {
      return liveRegistry.createType('RuntimeVersion', {
        ...runtime159,
        specVersion: fixture.currentRuntimeSpecVersion,
      });
    },
    consts: {
      vaults: { revenueCollectionExpirationFrames: liveRegistry.createType('u32', 10) },
      operationalAccounts: { operationalMinimumVaultSecuritization: liveRegistry.createType('u128', 0) },
    },
  });
  const historicalStorageName = historicalSpecVersion >= 159 ? 'locksById' : 'locksByUtxoId';
  const original = runtimeClient({
    query: {
      bitcoinLocks: {
        [historicalStorageName]: async () =>
          lockCodec(historicalRegistry, { ...storage, fundingUtxos: [], fundedSatoshis: 0n }),
      },
    },
  });
  const registry = new TypeRegistry();
  const client = live as unknown as ArgonClient;
  const parent = runtimeClient({
    query: {
      bitcoinLocks: {
        [historicalStorageName]: async () => lockCodec(historicalRegistry, fixture.parentLock),
      },
      bitcoinUtxos: {
        [historicalSpecVersion < 147 ? 'utxoIdToRef' : 'utxoIdToFundingUtxoRef']: async () =>
          fixture.parentLock.fundingUtxos[0]?.[0] ?? null,
      },
    },
  });
  const removed = runtimeClient({
    query: { bitcoinLocks: { [historicalStorageName]: async () => lockCodec(historicalRegistry, null) } },
  });
  const creationFields = getHistoricalEventFields(historicalSpecVersion, 'bitcoinLocks', 'BitcoinLockCreated')!;
  const creationValues: Record<string, unknown> = {
    utxoId: 42,
    lockId: 42,
    vaultId: 7,
    accountId: account.address,
    obligationId: 1n,
    lockPrice: 1_000n,
    peggedPrice: 1_000n,
    lockedMarketRate: 1_000n,
    lockedTargetPrice: 1_000n,
    liquidityPromised: 0n,
    securityFee: 0n,
    securitization: 0n,
    securitizationBasis: storage.securitizationBasis,
    collateralRequired: 0n,
  };
  const creationEvents = [
    historyEvent(
      historicalSpecVersion,
      'bitcoinLocks',
      'BitcoinLockCreated',
      Object.fromEntries(creationFields.map(field => [field, creationValues[field]])),
    ),
  ];
  const blockWatch = {
    bestBlockHeader: historyBlock(200),
    getFinalizedApi: async () => client,
    getApi: async () => live,
    getRpcClient: async () => ({
      rpc: {
        chain: {
          getBlockHash: async () => registry.createType('Hash', `0x${'66'.repeat(32)}`),
          getHeader: async () => ({ parentHash: registry.createType('Hash', `0x${'77'.repeat(32)}`) }),
        },
      },
      at: async () => original,
    }),
    getEventsWithSpec: async ({ blockNumber }: { blockNumber: number }) => {
      if (blockNumber === 123) return { specVersion: historicalSpecVersion, events: creationEvents, api: original };
      if (blockNumber === 180)
        return { specVersion: historicalSpecVersion, events: fixture.removalEvents, api: removed };
      return { specVersion: historicalSpecVersion, events: [], api: parent };
    },
  } as unknown as BlockWatch;
  const bitcoinOutspendRequested = createDeferred();
  const bitcoinServer = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    const path = new URL(req.url!, 'http://localhost').pathname;
    if (path === '/') res.end(JsonExt.stringify({ bitcoinCooperativeReleaseMailboxVersion: 1 }));
    else if (path === '/bitcoin-cooperative-releases' && req.method === 'POST') {
      let body = '';
      req.on('data', (data: Buffer) => (body += data.toString()));
      req.on('end', () => {
        const record = db.bitcoinCooperativeReleasesTable.insert(
          bitcoinCooperativeReleaseRequestSchema.parse(JsonExt.parse(body)),
        );
        if (fixture.loseMailboxResponse) {
          fixture.loseMailboxResponse = false;
          res.destroy();
        } else res.end(JsonExt.stringify({ bitcoinCooperativeRelease: record }));
      });
    } else if (path === '/tx' && req.method === 'POST') {
      let body = '';
      req.on('data', (data: Buffer) => (body += data.toString()));
      req.on('end', () => {
        if (fixture.failBitcoinBroadcast) {
          fixture.failBitcoinBroadcast = false;
          res.statusCode = 503;
          res.end('broadcast interrupted');
          return;
        }
        fixture.broadcasts.push(body);
        res.end(
          Buffer.from(Transaction.fromRaw(hexToU8a(body)).hash, 'hex')
            .reverse()
            .toString('hex'),
        );
      });
    } else if (path === '/blocks/tip/height') res.end('110');
    else if (path.endsWith('/hex')) {
      if (fixture.stallRawTransaction) {
        res.writeHead(200);
        res.write('00');
      } else res.end(Buffer.from(previous.toBytes(true)).toString('hex'));
    } else if (path === `/tx/${Buffer.from(previous.hash, 'hex').reverse().toString('hex')}/status`)
      res.end(
        JSON.stringify({
          confirmed: fixture.depositConfirmed,
          block_height: 100,
          block_time: 1,
          block_hash: '34'.repeat(32),
        }),
      );
    else if (
      fixture.reorgedFundingTxid &&
      path === `/tx/${Buffer.from(fixture.reorgedFundingTxid.slice(2), 'hex').reverse().toString('hex')}/status`
    ) {
      res.end(JSON.stringify({ confirmed: false }));
    } else if (path.endsWith('/status')) {
      if (!fixture.broadcasts.length) {
        res.statusCode = 404;
        res.end();
      } else
        res.end(
          JSON.stringify({
            confirmed: fixture.returnConfirmed,
            block_height: 115,
            block_time: 1,
            block_hash: '34'.repeat(32),
          }),
        );
    } else if (path.includes('/outspend/')) {
      bitcoinOutspendRequested.resolve();
      res.end(JSON.stringify({ spent: false }));
    } else if (path === '/block-height/100') res.end('34'.repeat(32));
    else if (path === '/block-height/101') res.end('45'.repeat(32));
    else if (path === '/block-height/102') res.end('46'.repeat(32));
    else {
      res.statusCode = 404;
      res.end();
    }
  });
  bitcoinServers.push(bitcoinServer);
  await new Promise<void>(resolve => bitcoinServer.listen(0, '127.0.0.1', resolve));
  const mempool = new BitcoinMempool(`http://127.0.0.1:${(bitcoinServer.address() as AddressInfo).port}`);
  const cooperative = new BitcoinCooperativeReleases(blockWatch, mempool);
  const db = new Db(':memory:');
  db.migrate();
  databases.push(db);
  const server = {
    canAccessServer: true,
    getPendingBitcoinCooperativeReleases: async () => db.bitcoinCooperativeReleasesTable.pending(7).requests,
    respondToBitcoinCooperativeRelease: async (id, response) =>
      db.bitcoinCooperativeReleasesTable.respond(id, response),
  } satisfies Pick<
    ServerApiClient,
    'canAccessServer' | 'getPendingBitcoinCooperativeReleases' | 'respondToBitcoinCooperativeRelease'
  >;
  return {
    cooperative,
    client,
    bitcoinOutspendRequested,
    server: server as ServerApiClient,
    db,
    request,
    cosign,
    vaultKey,
    ownerKey,
    account,
    lock,
    storage,
    blockWatch,
    mempool,
    bitcoinHost: `http://127.0.0.1:${(bitcoinServer.address() as AddressInfo).port}`,
    removalEvents: fixture.removalEvents,
    creationEvents,
    broadcasts: fixture.broadcasts,
    set parentLock(value: NonNullable<BitcoinLocksLocksByIdResultSpec159>) {
      fixture.parentLock = value;
    },
    set parentRejectedNeedsRelease(value: boolean) {
      fixture.parentRejectedNeedsRelease = value;
    },
    get parentLock() {
      return fixture.parentLock;
    },
    set loseMailboxResponse(value: boolean) {
      fixture.loseMailboxResponse = value;
    },
    set failBitcoinBroadcast(value: boolean) {
      fixture.failBitcoinBroadcast = value;
    },
    set returnConfirmed(value: boolean) {
      fixture.returnConfirmed = value;
    },
    set depositConfirmed(value: boolean) {
      fixture.depositConfirmed = value;
    },
    cursor,
    set currentRuntimeSpecVersion(value: number) {
      fixture.currentRuntimeSpecVersion = value;
    },
    set reorgedFundingTxid(value: string) {
      fixture.reorgedFundingTxid = value;
    },
    set stallRawTransaction(value: boolean) {
      fixture.stallRawTransaction = value;
    },
    get currentLock() {
      return fixture.currentLock;
    },
    set currentLock(value: BitcoinLocksLocksByIdResultSpec159) {
      fixture.currentLock = value;
    },
  };
}
