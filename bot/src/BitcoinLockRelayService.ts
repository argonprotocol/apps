import {
  bigNumberToBigInt,
  BlockWatch,
  type IBitcoinLockRelayJobRequest,
  type IBitcoinLockRelayRecord,
  MainchainClients,
  NetworkConfig,
  SATOSHIS_PER_BITCOIN,
  TransactionEvents,
} from '@argonprotocol/apps-core';
import {
  type ArgonClient,
  type FrameSystemEventRecord,
  type GenericEvent,
  type KeyringPair,
  type SignedBlock,
  Vault,
} from '@argonprotocol/mainchain';
import type { ISubmittableResult } from '@polkadot/types/types/extrinsic';
import type { Db } from './Db.ts';
import { HttpError } from './HttpError.ts';

type IRelayPreflight =
  | {
      canSubmit: true;
      securitizationUsedMicrogons: bigint;
    }
  | {
      canSubmit: false;
      reason: string;
      statusCode: number;
    };

type IRelayEventData = {
  txFeePlusTip: bigint;
  txTip: bigint;
  extrinsicError?: Error;
  inBlockHeight: number;
  blockHashHex: string;
  createdUtxoId?: number;
};

const RELAY_FINALIZATION_CONFIRMATIONS = 4;
const RELAY_MORTALITY_BLOCKS = 8;

export class BitcoinLockRelayService {
  private readonly blockCache = new Map<string, SignedBlock>();
  private readonly relayWatchUnsubscribes = new Map<number, () => void>();
  private readonly inflightByOfferCode = new Map<
    string,
    { request: IBitcoinLockRelayJobRequest; promise: Promise<IBitcoinLockRelayRecord> }
  >();

  private startedPromise?: Promise<void>;
  private stopVaultSubscription?: () => void;
  private vaultId?: number;
  private latestVault?: Vault;
  private isReconciling = false;
  private bestBlocksUnsub?: () => void;
  private nextNonce?: number;
  private submitLock: Promise<void> = Promise.resolve();

  constructor(
    private readonly db: Db,
    private readonly clients: MainchainClients,
    private readonly blockWatch: BlockWatch,
    private readonly vaultOperatorAddress: string,
    private readonly bitcoinInitializerDelegateKeypair: KeyringPair,
  ) {}

  public async start(): Promise<void> {
    this.startedPromise ??= this.startInternal();
    return this.startedPromise;
  }

  public async queueRelay(request: IBitcoinLockRelayJobRequest): Promise<IBitcoinLockRelayRecord> {
    await this.start();

    const { offerCode } = request;
    if (this.vaultId == null) {
      throw new HttpError('Bitcoin lock relay vault is not loaded.', 503);
    }

    const existingRelay = this.db.bitcoinLockRelaysTable.fetchByOfferCode(offerCode);
    if (existingRelay) {
      assertMatchingRelayRequest(existingRelay, request);
      return existingRelay;
    }

    const inflight = this.inflightByOfferCode.get(offerCode);
    if (inflight) {
      assertMatchingRelayRequest(inflight.request, request);
      return inflight.promise;
    }

    const promise = this.submitNewRelay(request);
    this.inflightByOfferCode.set(offerCode, { request, promise });

    try {
      return await promise;
    } finally {
      const current = this.inflightByOfferCode.get(offerCode);
      if (current?.promise === promise) {
        this.inflightByOfferCode.delete(offerCode);
      }
    }
  }

  public async getBitcoinLockStatus(offerCode: string): Promise<IBitcoinLockRelayRecord> {
    await this.start();

    const relay = this.db.bitcoinLockRelaysTable.fetchByOfferCode(offerCode);
    if (!relay) {
      throw new HttpError('Bitcoin lock not found.', 404);
    }

    return relay;
  }

  public async getLatestBitcoinLockStatuses(): Promise<IBitcoinLockRelayRecord[]> {
    await this.start();
    return this.db.bitcoinLockRelaysTable.fetchAll();
  }

  public async shutdown(): Promise<void> {
    this.bestBlocksUnsub?.();
    this.bestBlocksUnsub = undefined;

    this.stopVaultSubscription?.();
    this.stopVaultSubscription = undefined;

    for (const unsubscribe of this.relayWatchUnsubscribes.values()) {
      unsubscribe();
    }
    this.relayWatchUnsubscribes.clear();
  }

  public get delegateAddress(): string {
    return this.bitcoinInitializerDelegateKeypair.address;
  }

  private async startInternal(): Promise<void> {
    await this.blockWatch.start();
    await this.loadVault();

    this.bestBlocksUnsub = this.blockWatch.events.on('best-blocks', () => {
      void this.reconcileNonTerminalRelays();
    });

    await this.reconcileNonTerminalRelays();
  }

  private submitNewRelay(request: IBitcoinLockRelayJobRequest): Promise<IBitcoinLockRelayRecord> {
    return this.runWithSubmitLock(async () => {
      const { offerCode, requestedSatoshis, ownerAccountAddress, ownerBitcoinPubkey, microgonsPerBtc } = request;
      const existingRelay = this.db.bitcoinLockRelaysTable.fetchByOfferCode(offerCode);
      if (existingRelay) {
        assertMatchingRelayRequest(existingRelay, request);
        return existingRelay;
      }

      const preflight = await this.checkRelayCapacity(request);
      if (!preflight.canSubmit) {
        throw new HttpError(preflight.reason, preflight.statusCode);
      }

      const client = await this.clients.get(false);
      const tx = client.tx.bitcoinLocks.initializeFor(
        ownerAccountAddress,
        this.vaultId!,
        requestedSatoshis,
        ownerBitcoinPubkey,
        { V1: { microgonsPerBtc } },
      );
      const submittedAtBlockHeight = this.blockWatch.bestBlockHeader.blockNumber;
      const submittedAtTime = new Date();
      const expiresAtBlockHeight = submittedAtBlockHeight + RELAY_MORTALITY_BLOCKS;
      const nonce = await this.getNextNonce(client);
      const signedTx = await tx.signAsync(this.bitcoinInitializerDelegateKeypair, {
        nonce,
        era: RELAY_MORTALITY_BLOCKS,
      });

      const relay = this.db.bitcoinLockRelaysTable.insertRelay({
        ...request,
        vaultId: this.vaultId!,
        status: 'Submitted',
        securitizationUsedMicrogons: preflight.securitizationUsedMicrogons,
        delegateAddress: this.delegateAddress,
        extrinsicHash: signedTx.hash.toHex(),
        extrinsicMethodJson: signedTx.method.toHuman(),
        nonce,
        submittedAtBlockHeight,
        submittedAtTime,
        expiresAtBlockHeight,
      });

      let unsubscribe: () => void;
      try {
        unsubscribe = await signedTx.send(result => {
          void this.handleSubmissionUpdate(relay.id, client, result);
        });
      } catch (error) {
        this.nextNonce = undefined;
        const message = error instanceof Error ? error.message : String(error);
        return this.failRelay(relay.id, message);
      }

      const latestRelay = this.getRequiredRelay(relay.id);
      if (latestRelay.status === 'Failed' || latestRelay.status === 'Finalized') {
        unsubscribe();
      } else {
        this.relayWatchUnsubscribes.set(relay.id, unsubscribe);
      }

      return this.getRequiredRelay(relay.id);
    });
  }

  private async checkRelayCapacity(request: IBitcoinLockRelayJobRequest): Promise<IRelayPreflight> {
    const { expirationTick, maxSatoshis, requestedSatoshis, microgonsPerBtc } = request;
    const latestVault = this.latestVault;
    if (!latestVault) {
      throw new Error('Bitcoin lock relay vault failed to load.');
    }
    if (requestedSatoshis > maxSatoshis) {
      return {
        canSubmit: false,
        reason: 'Requested satoshis exceed this offer limit.',
        statusCode: 400,
      };
    }

    if (this.blockWatch.bestBlockHeader.tick >= expirationTick) {
      return {
        canSubmit: false,
        reason: 'This bitcoin lock coupon has expired.',
        statusCode: 400,
      };
    }

    if (latestVault.bitcoinLockDelegateAccount !== this.delegateAddress) {
      return {
        canSubmit: false,
        reason: 'The configured vault delegate is not registered on this vault.',
        statusCode: 400,
      };
    }

    const pendingSubmittedRelays = this.db.bitcoinLockRelaysTable
      .fetchNonTerminal()
      .filter(relay => relay.status === 'Submitted');
    const requiredLiquidity = (requestedSatoshis * microgonsPerBtc) / SATOSHIS_PER_BITCOIN;
    const requiredSecuritization = bigNumberToBigInt(
      latestVault.securitizationRatioBN().multipliedBy(requiredLiquidity),
    );
    const pendingSubmittedSecuritization = pendingSubmittedRelays.reduce(
      (total, relay) => total + relay.securitizationUsedMicrogons,
      0n,
    );

    if (latestVault.availableSecuritization() < requiredSecuritization + pendingSubmittedSecuritization) {
      return {
        canSubmit: false,
        reason: 'Vault securitization is currently exhausted for this lock request.',
        statusCode: 409,
      };
    }

    return {
      canSubmit: true,
      securitizationUsedMicrogons: requiredSecuritization,
    };
  }

  private async handleSubmissionUpdate(
    relayId: number,
    client: ArgonClient,
    result: ISubmittableResult,
  ): Promise<void> {
    const relay = this.db.bitcoinLockRelaysTable.fetchById(relayId);
    if (!relay || relay.status === 'Failed' || relay.status === 'Finalized') {
      this.stopRelayWatch(relayId);
      return;
    }

    const status = result.status;
    if (status.isRetracted) {
      if (relay.status === 'InBlock') {
        this.db.bitcoinLockRelaysTable.update(relayId, {
          status: 'Submitted',
          inBlockHeight: null,
          inBlockHash: null,
          txFeePlusTip: null,
          txTip: null,
          utxoId: null,
        });
        return;
      }
      this.nextNonce = undefined;
      this.failRelay(relayId, 'Relay was retracted before it was included in a block.');
      return;
    }

    if (status.isUsurped) {
      this.nextNonce = undefined;
      this.failRelay(relayId, `Relay was usurped by ${status.asUsurped.toHex()}.`);
      return;
    }

    if (status.isDropped) {
      this.nextNonce = undefined;
      this.failRelay(relayId, 'Relay was dropped before it was included in a block.');
      return;
    }

    if (status.isInvalid) {
      this.nextNonce = undefined;
      this.failRelay(relayId, 'Relay was rejected as invalid by the node.');
      return;
    }

    if (status.isInBlock) {
      const eventData = await this.getRelayEventData(client, result, status.asInBlock.toHex());
      if (eventData.extrinsicError) {
        this.failRelay(relayId, eventData.extrinsicError.message, {
          inBlockHeight: eventData.inBlockHeight,
          inBlockHash: eventData.blockHashHex,
          txFeePlusTip: eventData.txFeePlusTip,
          txTip: eventData.txTip,
          utxoId: eventData.createdUtxoId ?? relay.utxoId ?? null,
        });
        return;
      }

      this.db.bitcoinLockRelaysTable.update(relayId, {
        status: 'InBlock',
        inBlockHeight: eventData.inBlockHeight,
        inBlockHash: eventData.blockHashHex,
        txFeePlusTip: eventData.txFeePlusTip,
        txTip: eventData.txTip,
        utxoId: eventData.createdUtxoId ?? relay.utxoId ?? null,
      });
      return;
    }

    if (status.isFinalized) {
      await this.tryFinalizeRelay(relayId);
    }
  }

  private async reconcileNonTerminalRelays(): Promise<void> {
    if (this.isReconciling) return;
    this.isReconciling = true;

    try {
      const bestHeight = this.blockWatch.bestBlockHeader.blockNumber;
      const finalizedHeight = this.blockWatch.finalizedBlockHeader.blockNumber;

      for (const relay of this.db.bitcoinLockRelaysTable.fetchNonTerminal()) {
        if (relay.status === 'Submitted') {
          if (!relay.extrinsicHash || relay.submittedAtBlockHeight == null || relay.expiresAtBlockHeight == null) {
            this.failRelay(relay.id, 'Relay submission metadata is incomplete.');
            continue;
          }

          const inBlock = await TransactionEvents.findByExtrinsicHash({
            blockWatch: this.blockWatch,
            extrinsicHash: relay.extrinsicHash,
            searchStartBlockHeight: relay.submittedAtBlockHeight,
            bestBlockHeight: bestHeight,
            blockCache: this.blockCache,
            ignoreHeaderErrors: true,
          });

          if (inBlock) {
            const client = await this.blockWatch.getRpcClient(inBlock.blockNumber);
            const createdUtxoId = extractCreatedLockEvent(client, inBlock.extrinsicEvents);

            this.db.bitcoinLockRelaysTable.update(relay.id, {
              status: 'InBlock',
              inBlockHeight: inBlock.blockNumber,
              inBlockHash: inBlock.blockHash,
              txFeePlusTip: inBlock.fee + inBlock.tip,
              txTip: inBlock.tip,
              utxoId: createdUtxoId ?? relay.utxoId ?? null,
            });
            continue;
          }

          if (bestHeight >= relay.expiresAtBlockHeight) {
            this.failRelay(relay.id, 'Relay expired before it was included in a block.');
          }
          continue;
        }

        if (relay.status === 'InBlock' && relay.inBlockHeight != null && relay.inBlockHash) {
          const header = await this.blockWatch.getHeader(relay.inBlockHeight).catch(() => undefined);
          if (header && header.blockHash !== relay.inBlockHash) {
            this.db.bitcoinLockRelaysTable.update(relay.id, {
              status: 'Submitted',
              inBlockHeight: null,
              inBlockHash: null,
              txFeePlusTip: null,
              txTip: null,
              utxoId: null,
            });
            continue;
          }

          if (finalizedHeight >= relay.inBlockHeight + RELAY_FINALIZATION_CONFIRMATIONS) {
            await this.tryFinalizeRelay(relay.id);
          }
        }
      }
    } finally {
      this.isReconciling = false;
    }
  }

  private async tryFinalizeRelay(relayId: number): Promise<void> {
    const relay = this.getRequiredRelay(relayId);
    if (relay.status === 'Finalized' || relay.status === 'Failed') return;

    if (!relay.utxoId) {
      this.failRelay(relayId, 'Relay finalized without a created bitcoin lock event.');
      return;
    }

    this.db.bitcoinLockRelaysTable.update(relayId, {
      status: 'Finalized',
      finalizedHeight: this.blockWatch.finalizedBlockHeader.blockNumber,
    });
    this.stopRelayWatch(relayId);
  }

  private async loadVault(): Promise<void> {
    const client = await this.clients.get(false);
    const vaultIdOption = await client.query.vaults.vaultIdByOperator(this.vaultOperatorAddress);
    if (!vaultIdOption.isSome) {
      throw new HttpError(`No vault was found for operator ${this.vaultOperatorAddress}.`, 404);
    }

    this.vaultId = vaultIdOption.unwrap().toNumber();

    const vaultOption = await client.query.vaults.vaultsById(this.vaultId);
    if (!vaultOption.isSome) {
      throw new HttpError(`Vault ${this.vaultId} was not found on chain.`, 404);
    }

    this.latestVault = new Vault(this.vaultId, vaultOption.unwrap(), NetworkConfig.tickMillis);

    this.stopVaultSubscription?.();
    this.stopVaultSubscription = await client.query.vaults.vaultsById(this.vaultId, nextVaultOption => {
      if (!nextVaultOption.isSome) return;

      this.latestVault = new Vault(this.vaultId!, nextVaultOption.unwrap(), NetworkConfig.tickMillis);
    });
  }

  private getRequiredRelay(relayId: number): IBitcoinLockRelayRecord {
    const relay = this.db.bitcoinLockRelaysTable.fetchById(relayId);
    if (!relay) {
      throw new Error(`Relay ${relayId} was not found.`);
    }
    return relay;
  }

  private failRelay(
    relayId: number,
    error: string,
    fields?: {
      inBlockHeight?: number | null;
      inBlockHash?: string | null;
      txFeePlusTip?: bigint | null;
      txTip?: bigint | null;
      utxoId?: number | null;
    },
  ): IBitcoinLockRelayRecord {
    this.stopRelayWatch(relayId);

    return this.db.bitcoinLockRelaysTable.update(relayId, {
      status: 'Failed',
      error,
      ...fields,
    });
  }

  private stopRelayWatch(relayId: number): void {
    this.relayWatchUnsubscribes.get(relayId)?.();
    this.relayWatchUnsubscribes.delete(relayId);
  }

  private async runWithSubmitLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.submitLock.then(fn, fn);
    this.submitLock = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async getNextNonce(client: ArgonClient): Promise<number> {
    const nonce = this.nextNonce ?? (await client.rpc.system.accountNextIndex(this.delegateAddress)).toNumber();
    this.nextNonce = nonce + 1;
    return nonce;
  }

  private async getRelayEventData(
    client: ArgonClient,
    result: ISubmittableResult,
    blockHashHex: string,
  ): Promise<IRelayEventData> {
    const blockHash = result.status.asInBlock;
    const blockHeader = await client.rpc.chain.getHeader(blockHash);
    const api = await client.at(blockHash);
    const events = await api.query.system.events();
    const txEvents = await TransactionEvents.getErrorAndFeeForTransaction({
      client,
      extrinsicIndex: result.txIndex ?? 0,
      events: events as unknown as FrameSystemEventRecord[],
    });

    return {
      inBlockHeight: blockHeader.number.toNumber(),
      blockHashHex,
      txFeePlusTip: txEvents.fee + txEvents.tip,
      txTip: txEvents.tip,
      extrinsicError: txEvents.error ? new Error(txEvents.error.details || txEvents.error.message) : undefined,
      createdUtxoId: extractCreatedLockEvent(client, txEvents.extrinsicEvents),
    };
  }
}

function assertMatchingRelayRequest(
  existingRelay: Pick<
    IBitcoinLockRelayJobRequest,
    'requestedSatoshis' | 'ownerAccountAddress' | 'ownerBitcoinPubkey' | 'microgonsPerBtc'
  >,
  request: IBitcoinLockRelayJobRequest,
): void {
  if (
    existingRelay.requestedSatoshis !== request.requestedSatoshis ||
    existingRelay.ownerAccountAddress !== request.ownerAccountAddress ||
    existingRelay.ownerBitcoinPubkey !== request.ownerBitcoinPubkey ||
    existingRelay.microgonsPerBtc !== request.microgonsPerBtc
  ) {
    throw new HttpError('This invite already has a different relay request in progress.', 409);
  }
}

function extractCreatedLockEvent(client: ArgonClient, events: GenericEvent[]) {
  const createdEvent = events.find(event => client.events.bitcoinLocks.BitcoinLockCreated.is(event));
  if (!createdEvent) return undefined;

  return createdEvent.data.utxoId.toNumber();
}
