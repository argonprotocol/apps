import {
  JsonExt,
  BitcoinLock,
  bitcoinCooperativeReleaseRequestSchema,
  verifyBitcoinCooperativeReleaseRequest,
  type ArgonCurrentQueryClient,
  type IBitcoinCooperativeReleaseMailboxRecord,
  type IBitcoinCooperativeReleaseRequest,
  type IBitcoinLockDetails,
  type BlockWatch,
  type SingleFileQueue,
} from '@argonprotocol/apps-core';
import { sha256AsU8a } from '@polkadot/util-crypto';
import type BitcoinMempool from './BitcoinMempool.ts';
import { CosignScript, BitcoinNetwork, Transaction } from '@argonprotocol/bitcoin';
import { OutScript } from '@scure/btc-signer';
import { RawOutput } from '@scure/btc-signer/script';
import { hexToU8a, u8aToHex } from '@argonprotocol/mainchain';
import {
  getHistoricalBitcoinLock,
  getHistoricalBitcoinFundingUtxos,
  summarizeBitcoinLockBlockEvents,
  toBitcoinLockDetails,
} from './recovery/BitcoinLockHistory.ts';
import type { ServerApiClient } from './ServerApiClient.ts';
import type { IBitcoinUtxoRecord } from '../interfaces/IBitcoinUtxoRecord.ts';

export class BitcoinCooperativeReleases {
  public data = {
    requests: [] as Array<IBitcoinCooperativeReleaseMailboxRecord & { verificationError?: string }>,
    isRefreshing: false,
    isSigning: false,
    refreshError: '',
    deliveryMessage: '',
  };

  #refreshPromise?: Promise<void>;
  #publicationRevision = 0;

  constructor(
    private readonly blockWatch: BlockWatch,
    private readonly mempool: BitcoinMempool,
  ) {}

  public async getDepositConfirmationWait({
    txid,
  }: Pick<IBitcoinUtxoRecord, 'txid'>): Promise<'Bitcoin' | 'Argon' | undefined> {
    const client = await this.blockWatch.getFinalizedApi();
    const cursor = await client.query.bitcoinUtxos.synchedBitcoinBlock();
    if (!cursor) throw new Error('Unable to check whether Argon has finished checking this deposit.');

    const status = await this.mempool.getTxStatus(txid, cursor.blockHeight);
    if (!status) throw new Error('Unable to check this deposit’s Bitcoin confirmation.');
    if (!status.isConfirmed) return 'Bitcoin';
    if (status.transactionBlockHeight >= cursor.blockHeight) return 'Argon';
  }

  public static getMinimumDestinationSatoshis(script: string): bigint {
    const scriptBytes = hexToU8a(script);
    let output: ReturnType<typeof OutScript.decode>;
    try {
      output = OutScript.decode(scriptBytes);
      // The decoder also accepts nonminimal pushes; payment addresses use the canonical encoding.
      if (u8aToHex(OutScript.encode(output)) !== u8aToHex(scriptBytes)) throw new Error('Noncanonical payment script');
    } catch {
      throw new CooperativeReleaseRejected('Use a standard Bitcoin payment address for this return.');
    }

    let spendingVbytes: number;
    switch (output.type) {
      case 'wpkh':
      case 'wsh':
      case 'tr':
        spendingVbytes = 67;
        break;
      case 'pkh':
      case 'sh':
        spendingVbytes = 148;
        break;
      default:
        throw new CooperativeReleaseRejected('Use a standard Bitcoin payment address for this return.');
    }

    // The installed Bitcoin libraries decode/serialize outputs but expose no per-script dust helper.
    // Apply Core's default dust policy to the serialized output plus its estimated spending cost.
    const outputBytes = RawOutput.encode({ amount: 0n, script: scriptBytes }).length;
    return BigInt(outputBytes + spendingVbytes) * 3n;
  }

  public async refresh({
    finalizedClient,
    server,
    vaultId,
  }: {
    finalizedClient?: ArgonCurrentQueryClient;
    server?: ServerApiClient;
    vaultId: number;
  }): Promise<void> {
    if (this.#refreshPromise) return this.#refreshPromise;
    if (!server?.canAccessServer) return;
    this.data.isRefreshing = true;
    const revision = this.#publicationRevision;
    this.#refreshPromise = (async () => {
      try {
        finalizedClient ??= await this.blockWatch.getFinalizedApi();
        const requests = await server.getPendingBitcoinCooperativeReleases();
        const verified: BitcoinCooperativeReleases['data']['requests'] = [];
        for (const record of requests) {
          const entry: (typeof verified)[number] = { ...record };
          try {
            if (record.request.vaultId !== vaultId)
              throw new CooperativeReleaseRejected('This request belongs to another vault.');
            await this.verifyRequest(record.request, finalizedClient);
          } catch (error) {
            try {
              if (await this.deliverRejection(record.request, error, server)) continue;
            } catch (deliveryError) {
              error = deliveryError;
            }
            entry.verificationError = error instanceof Error ? error.message : String(error);
          }
          verified.push(entry);
        }
        if (revision !== this.#publicationRevision) return;
        this.data.requests = verified;
        this.data.refreshError = '';
        if (!this.data.isSigning) this.data.deliveryMessage = '';
      } catch (error) {
        this.data.refreshError = error instanceof Error ? error.message : String(error);
      } finally {
        this.data.isRefreshing = false;
        this.#refreshPromise = undefined;
      }
    })();
    return this.#refreshPromise;
  }

  public async signAndDeliver({
    approved,
    server,
    vaultId,
    sign,
    cosignQueue,
  }: {
    approved: readonly IBitcoinCooperativeReleaseMailboxRecord[];
    server?: ServerApiClient;
    vaultId: number;
    cosignQueue: SingleFileQueue;
    sign: (request: IBitcoinCooperativeReleaseRequest, lock: IBitcoinLockDetails) => Promise<string>;
  }): Promise<void> {
    if (!approved.length) return;
    const requests = JsonExt.parse<IBitcoinCooperativeReleaseMailboxRecord[]>(JsonExt.stringify(approved));
    this.#publicationRevision += 1;
    this.data.isSigning = true;
    let failedCount = 0;
    try {
      for (const { request } of requests) {
        this.data.deliveryMessage = `Signing return ${request.releaseId}...`;
        try {
          if (!server) throw new Error('The operator server is unavailable.');
          const vaultSignatureHex = await this.sign({ request, vaultId, cosignQueue, sign });
          const response = await server.respondToBitcoinCooperativeRelease(request.releaseId, { vaultSignatureHex });
          if (!response.vaultSignatureHex) throw new Error('The server did not store the vault signature.');
          this.#publicationRevision += 1;
          this.data.requests = this.data.requests.filter(record => record.request.releaseId !== request.releaseId);
        } catch (error) {
          try {
            if (await this.deliverRejection(request, error, server)) {
              this.#publicationRevision += 1;
              this.data.requests = this.data.requests.filter(record => record.request.releaseId !== request.releaseId);
              continue;
            }
          } catch (deliveryError) {
            error = deliveryError;
          }
          failedCount += 1;
          const message = error instanceof Error ? error.message : String(error);
          const current = this.data.requests.find(record => record.request.releaseId === request.releaseId);
          if (current) current.verificationError = message;
        }
      }
      if (failedCount) {
        this.data.deliveryMessage = 'Remaining requests will retry on the next check.';
      } else {
        this.data.deliveryMessage = 'Cooperative release requests processed.';
      }
    } finally {
      this.data.isSigning = false;
    }
  }

  public async sign({
    request,
    vaultId,
    cosignQueue,
    sign,
  }: {
    request: IBitcoinCooperativeReleaseRequest;
    vaultId: number;
    cosignQueue: SingleFileQueue;
    sign: (request: IBitcoinCooperativeReleaseRequest, lock: IBitcoinLockDetails) => Promise<string>;
  }): Promise<string> {
    // Freeze the approved terms before verification or queueing can yield to another caller.
    request = JsonExt.parse(JsonExt.stringify(request));
    if (request.vaultId !== vaultId) throw new CooperativeReleaseRejected('This request belongs to another vault.');
    return cosignQueue.add(async () => {
      // Verify after waiting for other cosigns so ordinary scan progress cannot stale the approval.
      const finalizedClient = await this.blockWatch.getFinalizedApi();
      const lock = await this.verifyRequest(request, finalizedClient);
      const verifiedScan = await finalizedClient.query.bitcoinUtxos.synchedBitcoinBlock();
      const cursor = await this.verifyUnattachedDeposit(request, lock, await this.blockWatch.getFinalizedApi());
      if (cursor.blockHeight !== verifiedScan?.blockHeight || cursor.blockHash !== verifiedScan.blockHash)
        throw new Error('The Bitcoin scan checkpoint changed. Check the return again before signing.');
      return sign(request, lock);
    }).promise;
  }

  public async verifyRequest(
    request: IBitcoinCooperativeReleaseRequest,
    finalizedClient: ArgonCurrentQueryClient,
  ): Promise<IBitcoinLockDetails> {
    if (!bitcoinCooperativeReleaseRequestSchema.safeParse(request).success) {
      throw new CooperativeReleaseRejected('Invalid cooperative release request.');
    }
    if (!verifyBitcoinCooperativeReleaseRequest(request))
      throw new CooperativeReleaseRejected('The owner authorization does not match these return terms.');
    const finalizedHeight = await finalizedClient.query.system.number();
    if (request.createdAtArgonBlock > finalizedHeight) throw new Error('The original lock must be finalized on Argon.');

    // Establish the owner's original lock and signing script from the known creation block.
    const client = await this.blockWatch.getRpcClient(request.createdAtArgonBlock);
    const hash = await client.rpc.chain.getBlockHash(request.createdAtArgonBlock);
    const original = await getHistoricalBitcoinLock(await client.at(hash), request.lockId);
    if (!original || original.ownerAccount !== request.ownerAccount || original.vaultId !== request.vaultId) {
      throw new CooperativeReleaseRejected('Unable to verify the original lock owner and signing terms.');
    }

    if (original.createdAtArgonBlock) {
      if (original.createdAtArgonBlock !== request.createdAtArgonBlock)
        throw new CooperativeReleaseRejected('The supplied block did not create this lock.');
    } else {
      // Early locks did not store their Argon creation block; use the event in that exact block.
      const { events } = await this.blockWatch.getEventsWithSpec({
        blockNumber: request.createdAtArgonBlock,
        blockHash: hash.toHex(),
      });
      if (!summarizeBitcoinLockBlockEvents(events, request.lockId).lockWasCreated)
        throw new CooperativeReleaseRejected('The supplied block did not create this lock.');
    }

    const lock = toBitcoinLockDetails(original);
    const network = await finalizedClient.query.bitcoinUtxos.bitcoinNetwork();
    const cosign = new CosignScript(lock, BitcoinNetwork[network.type]);
    if (cosign.calculateScriptPubkey() !== lock.p2wshScriptHashHex)
      throw new CooperativeReleaseRejected('The original Bitcoin script does not match the lock.');

    const { utxoRef } = request;
    const cursor = await this.verifyUnattachedDeposit(request, lock, finalizedClient);

    // Verify the actual Bitcoin output and its canonical, unspent confirmation.
    const mempool = this.mempool;
    const previous = Transaction.fromRaw(hexToU8a(await mempool.getRawTransaction(utxoRef.txid)), {
      allowUnknownOutputs: true,
    });
    if (`0x${previous.hash}` !== utxoRef.txid) throw new Error('The Bitcoin deposit transaction ID does not match.');
    if (utxoRef.outputIndex >= previous.outputsLength)
      throw new CooperativeReleaseRejected('The Bitcoin deposit output does not exist.');
    const output = previous.getOutput(utxoRef.outputIndex);
    if (output.amount !== request.satoshis || !output.script || u8aToHex(output.script) !== lock.p2wshScriptHashHex)
      throw new CooperativeReleaseRejected('The Bitcoin deposit amount or script does not match.');
    const status = await mempool.getTxStatus(utxoRef.txid, cursor.blockHeight);
    if (!status?.isConfirmed || !status.transactionBlockHash)
      throw new Error('The deposit must be confirmed on Bitcoin.');
    if (status.transactionBlockHeight >= cursor.blockHeight)
      throw new Error('Argon is still checking this deposit. Please try returning it again later.');
    if ((await mempool.getBlockHash(cursor.blockHeight)) !== cursor.blockHash)
      throw new Error('The Argon Bitcoin checkpoint is not canonical.');
    if ((await mempool.getBlockHash(status.transactionBlockHeight)) !== status.transactionBlockHash)
      throw new Error('The deposit confirmation is not canonical.');
    const spend = await mempool.getOutspendStatus(utxoRef.txid, utxoRef.outputIndex, cursor.blockHeight);
    if (spend?.isConfirmed) throw new CooperativeReleaseRejected('This Bitcoin deposit is already spent.');
    if (spend) throw new Error('Wait for the pending Bitcoin spend to resolve.');

    // Rebuild the exact approved payment, including its fee and spendable destination amount.
    if (request.changeSatoshis !== 0n || request.destinationSatoshis + request.bitcoinNetworkFee !== request.satoshis)
      throw new CooperativeReleaseRejected('The return amounts do not match the deposit.');
    const script = request.toScriptPubkey;
    const dust = BitcoinCooperativeReleases.getMinimumDestinationSatoshis(script);
    if (request.destinationSatoshis < dust)
      throw new CooperativeReleaseRejected('This deposit is too small to pay the fee and create a spendable return.');
    if (cosign.calculateFee(request.feeRatePerSatVb, 1, script, false) !== request.bitcoinNetworkFee)
      throw new CooperativeReleaseRejected('The Bitcoin fee does not match the approved fee rate.');
    const psbt = cosign.getCosignPsbt({
      releaseRequest: request,
      utxos: [{ utxoRef: { txid: utxoRef.txid, vout: utxoRef.outputIndex }, satoshis: request.satoshis }],
    });
    // Bitcoin txids use double SHA-256; the PSBT's hash getter requires finalization.
    // Check the owner's approved unsigned transaction before allowing the vault to sign.
    const transactionId = u8aToHex(sha256AsU8a(sha256AsU8a(psbt.unsignedTx)));
    if (transactionId !== request.expectedTransactionId)
      throw new CooperativeReleaseRejected('The rebuilt transaction does not match the approved return.');
    return lock;
  }

  private async deliverRejection(
    request: IBitcoinCooperativeReleaseRequest,
    error: unknown,
    server?: ServerApiClient,
  ): Promise<boolean> {
    if (!(error instanceof CooperativeReleaseRejected) || !server) return false;
    const response = await server.respondToBitcoinCooperativeRelease(request.releaseId, { error: error.message });
    if (!response.operatorError && !response.vaultSignatureHex)
      throw new Error('The server did not store the rejection.');
    return true;
  }

  private async verifyUnattachedDeposit(
    request: IBitcoinCooperativeReleaseRequest,
    lock: IBitcoinLockDetails,
    finalizedClient: ArgonCurrentQueryClient,
  ) {
    if (!('locksById' in finalizedClient.query.bitcoinLocks))
      throw new Error('Update this app to verify cooperative deposit returns with this Bitcoin lock storage.');
    let current: IBitcoinLockDetails | undefined = await BitcoinLock.get(finalizedClient, request.lockId);
    if (!current) {
      const { removalBlockNumber, lockId, createdAtArgonBlock } = request;
      if (!removalBlockNumber)
        throw new Error('Waiting for the owner to supply the known removal block for this lock.');
      if (removalBlockNumber <= createdAtArgonBlock)
        throw new CooperativeReleaseRejected('The removal block must follow the original lock creation.');
      if (removalBlockNumber > (await finalizedClient.query.system.number()))
        throw new Error('Wait for the lock removal to finalize on Argon.');

      // Inspect only the supplied transition. Ambiguous funding changes require the existing recovery flow.
      const client = await this.blockWatch.getRpcClient(removalBlockNumber);
      const blockHash = await client.rpc.chain.getBlockHash(removalBlockNumber);
      const header = await client.rpc.chain.getHeader(blockHash);
      const parentBlock = { blockNumber: removalBlockNumber - 1, blockHash: header.parentHash.toHex() };
      const removalBlock = { blockNumber: removalBlockNumber, blockHash: blockHash.toHex() };
      const [parent, removed] = await Promise.all([
        this.blockWatch.getEventsWithSpec(parentBlock),
        this.blockWatch.getEventsWithSpec(removalBlock),
      ]);
      for (const { event } of [...parent.events, ...removed.events]) {
        if (event.section === 'system' && event.method === 'CodeUpdated')
          throw new CooperativeReleaseRejected('Cooperative returns cannot verify removal during a runtime upgrade.');
      }
      if (await getHistoricalBitcoinLock(removed.api, lockId))
        throw new CooperativeReleaseRejected('The supplied block did not remove this lock.');
      const beforeRemoval = await getHistoricalBitcoinLock(parent.api, lockId);
      if (!beforeRemoval)
        throw new CooperativeReleaseRejected('The lock was not present immediately before the supplied removal block.');
      if (beforeRemoval.createdAtArgonBlock && beforeRemoval.createdAtArgonBlock !== createdAtArgonBlock)
        throw new CooperativeReleaseRejected('The lock before removal does not match the original creation block.');
      current = {
        ...toBitcoinLockDetails(beforeRemoval),
        fundingUtxos: await getHistoricalBitcoinFundingUtxos(parent.api, lockId, beforeRemoval.fundedSatoshis),
      };
      const pendingPartial = await parent.api.query.bitcoinLocks.pendingPartialReleaseByLockId(lockId);
      const parentRelease = await parent.api.query.bitcoinLocks.lockReleaseRequestsById(lockId);
      if (pendingPartial || (parentRelease?.changeSatoshis ?? 0n) > 0n)
        throw new CooperativeReleaseRejected(
          'Cooperative returns cannot verify a lock removed during a partial release.',
        );

      const removalSummary = summarizeBitcoinLockBlockEvents(removed.events, lockId);
      if (removalSummary.fundingWasAccepted)
        throw new CooperativeReleaseRejected('Cooperative returns cannot verify funding changes in the removal block.');

      // Early mismatch returns could compensate Bitcoin without retaining its funding reference.
      if (removalSummary.compensationWasPaid && beforeRemoval.fundedSatoshis === 0n)
        throw new CooperativeReleaseRejected(
          'This lock paid Bitcoin compensation without a funding reference to exclude.',
        );
    }
    if (
      current.p2wshScriptHashHex !== lock.p2wshScriptHashHex ||
      current.ownerAccount !== lock.ownerAccount ||
      current.vaultId !== lock.vaultId
    )
      throw new CooperativeReleaseRejected('The current lock does not match the original lock.');
    const { utxoRef } = request;
    const [tracked, orphan, release, partial, cursor] = await Promise.all([
      finalizedClient.query.bitcoinUtxos.utxoRefsByLockId(request.lockId),
      finalizedClient.query.bitcoinLocks.orphanedUtxosByAccount(request.ownerAccount, utxoRef),
      finalizedClient.query.bitcoinLocks.lockReleaseRequestsById(request.lockId),
      finalizedClient.query.bitcoinLocks.pendingPartialReleaseByLockId(request.lockId),
      finalizedClient.query.bitcoinUtxos.synchedBitcoinBlock(),
    ]);
    if (
      current.fundingUtxos.some(
        input => input.utxoRef.txid === utxoRef.txid && input.utxoRef.vout === utxoRef.outputIndex,
      )
    )
      throw new CooperativeReleaseRejected('This deposit is funding the lock or was funding it when removed.');
    if (orphan) throw new CooperativeReleaseRejected('This deposit must use the existing Argon orphan return.');
    if (tracked?.some(ref => ref.txid === utxoRef.txid && ref.outputIndex === utxoRef.outputIndex))
      throw new Error('This deposit is still tracked by Argon.');
    if (release || partial)
      throw new Error('Wait for the current lock release to finish before returning another deposit.');
    if (!cursor) throw new Error('The Bitcoin scan checkpoint is unavailable.');
    const retainedFundingSatoshis = current.fundingUtxos.reduce((sum, input) => sum + input.satoshis, 0n);
    if (retainedFundingSatoshis !== current.fundedSatoshis)
      throw new Error('The accepted funding references do not account for this lock funding.');

    // Partial releases replace every accepted input with change. If Bitcoin undoes that spend,
    // the replacement funding transaction cannot remain canonical, even after Argon drops old references.
    for (const { utxoRef: funding } of current.fundingUtxos) {
      const status = await this.mempool.getTxStatus(funding.txid, cursor.blockHeight);
      if (!status?.isConfirmed || !status.transactionBlockHash)
        throw new Error('Wait for the lock funding transaction to be confirmed on canonical Bitcoin.');
      if ((await this.mempool.getBlockHash(status.transactionBlockHeight)) !== status.transactionBlockHash)
        throw new Error('The lock funding transaction is no longer on canonical Bitcoin.');
    }

    return cursor;
  }
}

export class CooperativeReleaseRejected extends Error {}
