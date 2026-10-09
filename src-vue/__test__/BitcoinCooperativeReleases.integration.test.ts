import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import Path from 'node:path';
import { describe, expect, inject, it, onTestFinished, vi } from 'vitest';
import { integrationNetwork } from '@argonprotocol/apps-core/__test__/integration.setup.ts';
import {
  BitcoinLock,
  UserRole,
  signBitcoinCooperativeReleaseRequest,
  type IBitcoinCooperativeReleaseRequest,
} from '@argonprotocol/apps-core';
import { sha256AsU8a } from '@polkadot/util-crypto';
import { Keyring, toFixedNumber, u8aToHex } from '@argonprotocol/mainchain';
import { toRuntimeEvent } from '@argonprotocol/runtime-client';
import { integrationAccountUri } from '@argonprotocol/apps-core/__test__/integrationNetwork.ts';
import { submitAndFinalize, sudoSubmitAndFinalize } from '@argonprotocol/apps-core/__test__/helpers/mainchain.ts';
import { sudoFundWallet } from '@argonprotocol/apps-core/__test__/helpers/sudoFundWallet.ts';
import { waitFor } from '@argonprotocol/apps-core/__test__/helpers/waitFor.ts';
import {
  createBitcoinAddress,
  generateBlocks,
  sendBitcoinToAddress,
  waitForBitcoinTransactionOutputSatoshis,
} from '@argonprotocol/apps-core/__test__/helpers/bitcoinCli.ts';
import { BitcoinLockStatus } from '../lib/db/BitcoinLocksTable.ts';
import { BitcoinUtxoSpendStatus } from '../lib/db/BitcoinUtxosTable.ts';
import { BitcoinReleaseStatus } from '../interfaces/IBitcoinReleaseRecord.ts';
import {
  createBitcoinLocksHarness as createHarness,
  cleanupBitcoinLocksHarness as cleanupHarness,
  createBitcoinLocksClientHarness,
  cleanupBitcoinLocksClientHarness,
  defaultVaultSetup,
} from './helpers/bitcoinLocksHarness.ts';
import { createMockWalletKeys } from './helpers/wallet.ts';
import BitcoinMempool from '../lib/BitcoinMempool.ts';
import { ServerApiClient } from '../lib/ServerApiClient.ts';
import { ServerAuthClient } from '../lib/ServerAuthClient.ts';
import { UpstreamOperatorClient } from '../lib/UpstreamOperatorClient.ts';
import { ServerType } from '../interfaces/IConfig.ts';
import { Db as RouterDb } from '../../router/src/Db.ts';
import { RouterServer } from '../../router/src/RouterServer.ts';
import { AppVaultOperator } from '../../e2e/actors/AppVaultOperator.ts';

const skipE2E = Boolean(JSON.parse(process.env.SKIP_E2E ?? '0'));

describe.skipIf(skipE2E).sequential('Bitcoin cooperative releases on real chains', () => {
  it(
    'returns own-vault and mailbox deposits, excluding compensated funding after lock removal',
    { tags: ['exclusive-argon-network'], timeout: 600e3 },
    async () => {
      const network = integrationNetwork;
      const minerAddress = createBitcoinAddress();
      const walletKeys = createMockWalletKeys(
        integrationAccountUri(inject('argonIntegrationRunId'), import.meta.filename, 'cooperative-return'),
      );
      let operatorServer: ServerApiClient | undefined;
      const harness = await createHarness({
        archiveUrl: network.archiveUrl,
        esploraHost: network.networkConfigOverride.esploraHost,
        network: 'dev-docker',
        walletKeys,
        vaultSetup: { ...defaultVaultSetup, securitizationMicrogons: 20_000_000n },
        getOperatorServer: () => operatorServer,
      });

      // Finish hooks run in reverse order: restore chain settings before closing the signing harness.
      onTestFinished(async () => {
        try {
          await cleanupHarness(harness);
        } finally {
          vi.restoreAllMocks();
        }
      });
      const client = await harness.clients.get(false);
      const originalMinimum = await client.raw.query.bitcoinLocks.minimumSatoshis();
      onTestFinished(async () => {
        try {
          // The genesis value is below the admin call's dust floor; restore its SCALE-encoded storage value.
          const restored = await sudoSubmitAndFinalize(
            client,
            client.tx.system.setStorage([
              [client.raw.query.bitcoinLocks.minimumSatoshis.key(), originalMinimum.toHex(true)],
            ]),
          );
          if (restored.extrinsicError) throw restored.extrinsicError;
          const finalized = await client.at(await client.rpc.chain.getFinalizedHead());
          expect(await finalized.query.bitcoinLocks.minimumSatoshis()).toBe(originalMinimum.toBigInt());
        } catch (error) {
          // Use the shared harness's existing quarantine if cleanup cannot restore the chain.
          const { lockDirectory } = inject('argonIntegrationSession');
          await writeFile(Path.join(lockDirectory, 'network-unavailable'), 'Bitcoin minimum could not be restored.\n');
          throw error;
        }
      });

      // Raise the test minimum above dust while this scenario owns exclusive access to the shared chain.
      const changed = await sudoSubmitAndFinalize(client, client.tx.bitcoinLocks.adminModifyMinimumLockedSats(5_000n));
      if (changed.extrinsicError) throw changed.extrinsicError;

      const owner = await walletKeys.getLiquidLockingKeypair();
      // Use the production lock submission and its finalized, published record.
      const vault = harness.myVault.createdVault!;
      const microgonsAtTargetPerBtc = (await client.query.bitcoinLocks.microgonPerBtcHistory()).at(-1)![1];
      const satoshis = await harness.bitcoinLocks.satoshisForArgonLiquidity(
        vault.availableBitcoinSpace() / 2n,
        microgonsAtTargetPerBtc,
      );
      const creation = await harness.bitcoinLockCreate.submit({
        satoshis,
        vault,
        microgonsAtTargetPerBtc,
        txSigner: owner,
      });
      await creation.txResult.waitForFinalizedBlock;
      await creation.waitForPostProcessing;
      const lock = harness.bitcoinLocks.getLockByUuid(creation.tx.metadataJson.bitcoin.uuid)!;
      expect(lock.status).toBe(BitcoinLockStatus.LockPendingFunding);
      const lockId = lock.lockId!;
      const fundingAddress = harness.bitcoinLocks.formatP2wshAddress(lock.scriptDetails!.p2wshScriptHashHex);
      const mempool = new BitcoinMempool(network.networkConfigOverride.esploraHost);

      // Bitcoin confirms this output, but the real Argon scanner must skip it below the runtime minimum.
      const minimumSatoshis = await client.query.bitcoinLocks.minimumSatoshis();
      const smallSatoshis = minimumSatoshis - 1n;
      expect(smallSatoshis).toBeGreaterThan(1_000n);
      sendBitcoinToAddress(fundingAddress, smallSatoshis);
      generateBlocks(8, minerAddress);
      const deposit = await waitFor(90e3, 'real below-minimum deposit after finalized scanning', async () => {
        const finalized = await harness.miningFrames.blockWatch.getFinalizedApi();
        await harness.bitcoinLocks.utxoTracking.observeMempoolFunding(lock, finalized);
        const record = harness.bitcoinLocks.utxoTracking
          .getUtxosForLock(lockId)
          .find(x => x.satoshis === smallSatoshis);
        const cursor = await finalized.query.bitcoinUtxos.synchedBitcoinBlock();
        if (!record?.mempoolObservation?.isConfirmed || !cursor) return;
        if (cursor.blockHeight <= record.mempoolObservation.transactionBlockHeight) return;
        expect((await BitcoinLock.get(finalized, lockId))?.fundingUtxos).toEqual([]);
        expect(await finalized.query.bitcoinUtxos.utxoRefsByLockId(lockId)).toEqual([]);
        expect(
          await finalized.query.bitcoinLocks.orphanedUtxosByAccount(owner.address, {
            txid: record.txid,
            outputIndex: record.vout,
          }),
        ).toBeNull();
        return record;
      });
      expect(deposit.fundingRejectionReason).toBe('BelowMinimum');

      // The production owner flow obtains the real vault signature, broadcasts, and records Bitcoin completion.
      const destination = createBitcoinAddress();
      const release = await harness.bitcoinLocks.releases.requestCooperativeRelease({
        lock,
        record: deposit,
        toScriptPubkey: destination,
        feeRatePerSatVb: 1n,
        owner,
      });
      const broadcast = await waitFor(60e3, 'real cooperative return broadcast', () => {
        const current = harness.bitcoinLocks.releases.getById(release.id);
        if (current?.statusError) throw new Error(current.statusError);
        return current?.bitcoinTxid ? current : undefined;
      });
      expect(broadcast.bitcoinTxid).toBe(broadcast.cooperativeRequest!.expectedTransactionId);
      expect(broadcast.vaultSignatures).toHaveLength(1);
      const received = await waitForBitcoinTransactionOutputSatoshis({
        flowName: 'BitcoinCooperativeReleases',
        txid: broadcast.bitcoinTxid!,
        address: destination,
        minimumSatoshis: broadcast.destinationSatoshis,
        minerAddress,
        timeoutMs: 30e3,
        pollMs: 500,
      });
      expect(received).toBe(smallSatoshis - broadcast.bitcoinNetworkFee);
      generateBlocks(8, minerAddress);
      await waitFor(90e3, 'durable cooperative return completion', async () => {
        await harness.bitcoinLocks.releases.reconcileDepositReleases(lock);
        const current = await harness.db.bitcoinReleasesTable.getById(release.id);
        if (current?.status !== BitcoinReleaseStatus.Complete) return;
        expect(await harness.db.bitcoinUtxosTable.getByLockOutpoint(lockId, deposit.txid, deposit.vout)).toMatchObject({
          spendStatus: BitcoinUtxoSpendStatus.Spent,
          spentByReleaseId: release.id,
        });
        return current;
      });

      // A separate owner's request must cross real HTTP authentication, router storage, and Collect.
      const downstreamWallet = createMockWalletKeys(
        integrationAccountUri(inject('argonIntegrationRunId'), import.meta.filename, 'downstream-owner'),
      );
      const routerDb = new RouterDb(
        Path.join(await mkdtemp(Path.join(tmpdir(), 'cooperative-mailbox-')), 'router.sqlite'),
      );
      routerDb.migrate();
      onTestFinished(() => routerDb.close());
      const member = routerDb.usersTable.insertUser({ role: UserRole.Member, name: 'Synthetic deposit owner' });
      const invite = routerDb.userInvitesTable.insertInvite(member.id, 'cooperative-owner', 'Synthetic operator');
      routerDb.userInvitesTable.claimInvite(
        invite.id,
        downstreamWallet.defaultArgonAddress,
        (await downstreamWallet.getUpstreamOperatorAuthKeypair()).address,
      );

      const router = new RouterServer({
        db: routerDb,
        port: 0,
        botInternalUrl: 'http://127.0.0.1:9',
        localNodeUrl: network.archiveUrl,
        mainNodeUrl: network.archiveUrl,
        vaultOperatorAddress: vault.operatorAccountId,
        auth: { adminOperatorAccountId: walletKeys.operationalAddress },
      });
      onTestFinished(async () => {
        operatorServer = undefined;
        await router.close();
      });
      router.start();
      await router.waitForListening();
      const routerAddress = router.getAddress();
      const routerHost = `http://${routerAddress.host}:${routerAddress.port}`;
      // Production gateways terminate TLS; this fixture connects directly to the local HTTP router.
      vi.spyOn(ServerApiClient, 'getGatewayHttpUrl').mockImplementation((_details, path = '', sessionId) => {
        const url = new URL(path, routerHost);
        if (sessionId) url.searchParams.set('sessionId', sessionId);
        if (!path) return url.origin;
        return url.toString();
      });
      operatorServer = new ServerApiClient(
        () => ({ ipAddress: routerAddress.host, gatewayPort: routerAddress.port, type: ServerType.LocalComputer }),
        new ServerAuthClient(() => walletKeys),
        walletKeys,
      );
      const upstream = new UpstreamOperatorClient(new ServerAuthClient(() => downstreamWallet), () => routerHost);
      const downstream = await createBitcoinLocksClientHarness({
        archiveUrl: network.archiveUrl,
        esploraHost: network.networkConfigOverride.esploraHost,
        network: 'dev-docker',
        walletKeys: downstreamWallet,
        upstreamOperatorClient: upstream,
      });
      onTestFinished(() => cleanupBitcoinLocksClientHarness(downstream));
      await sudoFundWallet({
        address: downstreamWallet.defaultArgonAddress,
        microgons: 100_000_000n,
        micronots: 0n,
        archiveUrl: network.archiveUrl,
      });
      const downstreamOwner = await downstreamWallet.getLiquidLockingKeypair();
      expect(downstreamOwner.address).not.toBe(owner.address);
      const downstreamSatoshis = await downstream.bitcoinLocks.satoshisForArgonLiquidity(
        (harness.myVault.createdVault!.availableBitcoinSpace() * 4n) / 5n,
        microgonsAtTargetPerBtc,
      );
      expect(downstreamSatoshis).toBeGreaterThan(minimumSatoshis);
      const downstreamCreation = await downstream.bitcoinLockCreate.submit({
        satoshis: downstreamSatoshis,
        vault: harness.myVault.createdVault!,
        microgonsAtTargetPerBtc,
        txSigner: downstreamOwner,
      });
      await downstreamCreation.txResult.waitForFinalizedBlock;
      await downstreamCreation.waitForPostProcessing;
      const downstreamLock = downstream.bitcoinLocks.getLockByUuid(downstreamCreation.tx.metadataJson.bitcoin.uuid)!;
      const downstreamLockId = downstreamLock.lockId!;
      const downstreamAddress = downstream.bitcoinLocks.formatP2wshAddress(
        downstreamLock.scriptDetails!.p2wshScriptHashHex,
      );
      sendBitcoinToAddress(downstreamAddress, smallSatoshis);
      generateBlocks(8, minerAddress);
      const downstreamDeposit = await waitFor(90e3, 'discovered downstream deposit after scanning', async () => {
        const finalized = await downstream.miningFrames.blockWatch.getFinalizedApi();
        await downstream.bitcoinLocks.utxoTracking.observeMempoolFunding(downstreamLock, finalized);
        const record = downstream.bitcoinLocks.utxoTracking
          .getUtxosForLock(downstreamLockId)
          .find(x => x.satoshis === smallSatoshis);
        const cursor = await finalized.query.bitcoinUtxos.synchedBitcoinBlock();
        if (!record?.mempoolObservation?.isConfirmed || !cursor) return;
        if (cursor.blockHeight <= record.mempoolObservation.transactionBlockHeight) return;
        return record;
      });
      const waitingReturn = await downstream.bitcoinLocks.releases.requestCooperativeRelease({
        lock: downstreamLock,
        record: downstreamDeposit,
        toScriptPubkey: destination,
        feeRatePerSatVb: 1n,
        owner: downstreamOwner,
      });
      expect(waitingReturn.status).toBe(BitcoinReleaseStatus.WaitingForVaultCosign);
      expect(routerDb.bitcoinCooperativeReleasesTable.fetch(waitingReturn.id)?.request).toEqual(
        waitingReturn.cooperativeRequest,
      );
      await waitFor(30e3, 'operator discovers the owner request', async () => {
        const mailbox = harness.bitcoinLocks.cooperativeReleases;
        await mailbox.refresh({ vaultId: vault.vaultId, server: operatorServer });
        if (mailbox.data.refreshError) throw new Error(mailbox.data.refreshError);
        const rejection = routerDb.bitcoinCooperativeReleasesTable.fetch(waitingReturn.id)?.operatorError;
        if (rejection) throw new Error(rejection);
        const entry = mailbox.data.requests.find(x => x.request.releaseId === waitingReturn.id);
        if (entry?.verificationError) throw new Error(entry.verificationError);
        return entry;
      });

      // Accept another output for that owner, then let an ordinary full-release request incur compensation.
      sendBitcoinToAddress(downstreamAddress, downstreamLock.securitizedSatoshis);
      generateBlocks(8, minerAddress);
      const funded = await waitFor(90e3, 'real accepted lock funding', async () => {
        const finalized = await harness.miningFrames.blockWatch.getFinalizedApi();
        const current = await BitcoinLock.get(finalized, downstreamLockId);
        return current?.fundedSatoshis === downstreamLock.securitizedSatoshis ? current : undefined;
      });
      await downstream.bitcoinLocks.syncCurrentLocks({ requireComplete: true });
      const funding = downstream.bitcoinLocks.getFundingUtxos(
        downstream.bitcoinLocks.getLockById(downstreamLockId)!,
      )[0];
      const { cosign, releaseRequest } = downstream.bitcoinLocks.releases.prepareCooperativeRelease({
        lock: downstreamLock,
        record: funding,
        toScriptPubkey: destination,
        feeRatePerSatVb: 1n,
      });
      const request: IBitcoinCooperativeReleaseRequest = {
        ...waitingReturn.cooperativeRequest!,
        ...releaseRequest,
        releaseId: 'compensated-deposit',
        utxoRef: { txid: funding.txid, outputIndex: funding.vout },
        satoshis: funding.satoshis,
      };
      const psbt = cosign.getCosignPsbt({
        releaseRequest: request,
        utxos: funded.fundingUtxos,
      });
      request.expectedTransactionId = u8aToHex(sha256AsU8a(sha256AsU8a(psbt.unsignedTx)));
      request.requestSignature = signBitcoinCooperativeReleaseRequest(downstreamOwner, request);

      // Exclusive network access pauses the oracle; refresh its unchanged prices before the normal release.
      const prices = (await client.query.priceIndex.current())!;
      const freshTick = await waitFor(30e3, 'fresh oracle observation tick', async () => {
        const tick = await client.query.ticks.currentTick();
        return tick > prices.tick ? tick : undefined;
      });
      const observation = await submitAndFinalize(
        client,
        client.tx.priceIndex.submit(
          {
            btcUsdPrice: toFixedNumber(prices.btcUsdPrice, 18),
            argonUsdPrice: toFixedNumber(prices.argonUsdPrice, 18),
            argonotUsdPrice: toFixedNumber(prices.argonotUsdPrice, 18),
            argonUsdTargetPrice: toFixedNumber(prices.argonUsdTargetPrice, 18),
            argonTimeWeightedAverageLiquidity: toFixedNumber(prices.argonTimeWeightedAverageLiquidity, 18),
            tick: BigInt(freshTick),
          },
          null,
        ),
        new Keyring({ type: 'sr25519' }).addFromUri('//Eve//oracle'),
        { useLatestNonce: true },
      );
      if (observation.extrinsicError) throw observation.extrinsicError;

      const requested = await submitAndFinalize(
        client,
        BitcoinLock.createReleaseTx({ client, lockId: downstreamLockId, ...releaseRequest }),
        downstreamOwner,
      );
      if (requested.extrinsicError) throw requested.extrinsicError;

      // Leave the release unsigned and let its real deadline trigger runtime compensation and removal.
      let checkedThrough = requested.blockNumber!;
      const compensated = await waitFor(300e3, 'runtime compensation event', async () => {
        const finalized = await harness.miningFrames.blockWatch.getFinalizedApi();
        const height = await finalized.query.system.number();
        for (; checkedThrough < height; checkedThrough += 1) {
          const blockNumber = checkedThrough + 1;
          const blockHash = await client.rpc.chain.getBlockHash(blockNumber);
          const { events } = await harness.miningFrames.blockWatch.getEventsWithSpec({
            blockNumber,
            blockHash: blockHash.toHex(),
          });
          for (const { event } of events) {
            const change = toRuntimeEvent(event);
            if (
              change?.section === 'bitcoinLocks' &&
              change.method === 'BitcoinCosignPastDue' &&
              change.data.lockId === downstreamLockId
            ) {
              return { blockNumber, amount: change.data.compensationAmount };
            }
          }
        }
      });
      expect(compensated.amount).toBeGreaterThan(0n);
      const afterPenalty = await harness.miningFrames.blockWatch.getFinalizedApi();
      expect(await BitcoinLock.get(afterPenalty, downstreamLockId)).toBeUndefined();
      expect(await afterPenalty.query.bitcoinUtxos.utxoRefsByLockId(downstreamLockId)).toEqual([]);
      const checkpoint = await afterPenalty.query.bitcoinUtxos.synchedBitcoinBlock();
      expect(await mempool.getOutspendStatus(funding.txid, funding.vout, checkpoint!.blockHeight)).toBeUndefined();

      // An owner-approved request cannot turn compensated, still-unspent Bitcoin into a cooperative return.
      request.removalBlockNumber = compensated.blockNumber;
      const keyAccess = vi.spyOn(walletKeys, 'getBitcoinChildXpriv');
      await expect(harness.myVault.createVaultSignatureForCooperativeRelease(request)).rejects.toThrow(
        'was funding it when removed',
      );
      expect(keyAccess).not.toHaveBeenCalled();

      await upstream.submitBitcoinCooperativeRelease(request);
      await harness.bitcoinLocks.cooperativeReleases.refresh({ vaultId: vault.vaultId, server: operatorServer });
      const rejected = await upstream.submitBitcoinCooperativeRelease(request);
      expect(rejected.operatorError).toContain('was funding it when removed');
      expect(rejected.vaultSignatureHex).toBeUndefined();
      expect(keyAccess).not.toHaveBeenCalled();
      keyAccess.mockRestore();

      // Live removal publication supplies the hint without changing the owner's approved payment.
      const removedLock = await waitFor(60e3, 'owner lock removal publication', () => {
        const current = downstream.bitcoinLocks.getLockById(downstreamLockId);
        return current?.removalBlockNumber === compensated.blockNumber ? current : undefined;
      });
      await downstream.bitcoinLocks.releases.reconcileDepositReleases(removedLock);
      const amended = routerDb.bitcoinCooperativeReleasesTable.fetch(waitingReturn.id)!;
      expect(amended.request.removalBlockNumber).toBe(compensated.blockNumber);
      expect(amended.request.requestSignature).toBe(waitingReturn.cooperativeRequest!.requestSignature);
      expect(amended.request.expectedTransactionId).toBe(waitingReturn.expectedTransactionId);
      expect(amended.vaultSignatureHex).toBeUndefined();

      // The normal dev upstream handler discovers and signs the return through its Collect loop.
      const operator = await AppVaultOperator.load({
        clients: harness.clients,
        walletKeys,
        serverApiClient: operatorServer,
      });
      onTestFinished(() => operator.dispose());
      await operator.ensureVaultReady();
      expect(operator.myVault.createdVault?.vaultId).toBe(vault.vaultId);

      const stopOperator = new AbortController();
      const operatorLoop = operator.pollVaultAlerts({ signal: stopOperator.signal });
      // Vitest runs cleanup in reverse order, so stop polling before disposing the operator.
      onTestFinished(async () => {
        stopOperator.abort();
        await operatorLoop;
      });
      await waitFor(
        30e3,
        'dev upstream delivers the cooperative vault signature',
        () => routerDb.bitcoinCooperativeReleasesTable.fetch(waitingReturn.id)?.vaultSignatureHex,
      );
      expect(routerDb.bitcoinCooperativeReleasesTable.fetch(waitingReturn.id)?.vaultSignatureHex).toBeTruthy();
      expect(routerDb.bitcoinCooperativeReleasesTable.pending(vault.vaultId).requests).toEqual([]);
      const coordinated = await waitFor(60e3, 'owner receives signature and broadcasts return', async () => {
        await downstream.bitcoinLocks.releases.reconcileDepositReleases(removedLock);
        const current = downstream.bitcoinLocks.releases.getById(waitingReturn.id);
        if (current?.statusError) throw new Error(current.statusError);
        return current?.bitcoinTxid ? current : undefined;
      });
      expect(coordinated.bitcoinTxid).toBe(waitingReturn.expectedTransactionId);
      const downstreamReceived = await waitForBitcoinTransactionOutputSatoshis({
        flowName: 'BitcoinCooperativeReleases.mailbox',
        txid: coordinated.bitcoinTxid!,
        address: destination,
        minimumSatoshis: coordinated.destinationSatoshis,
        minerAddress,
        timeoutMs: 30e3,
        pollMs: 500,
      });
      expect(downstreamReceived).toBe(smallSatoshis - coordinated.bitcoinNetworkFee);
      generateBlocks(8, minerAddress);
      await waitFor(90e3, 'durable mailbox return completion', async () => {
        await downstream.bitcoinLocks.releases.reconcileDepositReleases(removedLock);
        const current = await downstream.db.bitcoinReleasesTable.getById(waitingReturn.id);
        if (current?.status !== BitcoinReleaseStatus.Complete) return;
        expect(
          await downstream.db.bitcoinUtxosTable.getByLockOutpoint(
            downstreamLockId,
            downstreamDeposit.txid,
            downstreamDeposit.vout,
          ),
        ).toMatchObject({ spendStatus: BitcoinUtxoSpendStatus.Spent, spentByReleaseId: waitingReturn.id });
        return current;
      });
    },
  );
});
