import {
  bigNumberToBigInt,
  type BitcoinLockCouponStatus,
  BlockWatch,
  type IActivateBitcoinLockCouponRequest,
  type IBitcoinLockCouponRecord,
  type IBitcoinLockCouponStatus,
  type IBitcoinLockRelayJobRequest,
  type IBitcoinLockRelayRecord,
  type ICreateBitcoinLockCouponRequest,
  MainchainClients,
  MiningFrames,
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
import { nanoid } from 'nanoid';
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

export class BitcoinLockRelayService {
  private readonly blockCache = new Map<string, SignedBlock>();
  private readonly relayWatchUnsubscribes = new Map<number, () => void>();
  private readonly inflightByOfferCode = new Map<
    string,
    { request: IBitcoinLockRelayJobRequest; promise: Promise<IBitcoinLockCouponStatus> }
  >();

  private startedPromise?: Promise<void>;
  private stopVaultSubscription?: () => void;
  private vaultId?: number;
  private latestVault?: Vault;
  private vaultLoadPromise?: Promise<void>;
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

  public async relayBitcoinLock(request: IBitcoinLockRelayJobRequest): Promise<IBitcoinLockCouponStatus> {
    await this.start();

    const { offerCode } = request;
    const ownerAccountId = request.ownerAccountId?.trim();
    const ownerBitcoinPubkey = request.ownerBitcoinPubkey?.trim();

    const coupon = this.db.bitcoinLockCouponsTable.fetchByOfferCode(offerCode);
    if (!coupon) {
      throw new HttpError('Bitcoin lock coupon not found.', 404);
    }

    if (!ownerAccountId) {
      throw new HttpError('An owner account id is required for this bitcoin lock.', 400);
    }

    if (!ownerBitcoinPubkey) {
      throw new HttpError('An owner bitcoin pubkey is required for this bitcoin lock.', 400);
    }

    if (request.requestedSatoshis <= 1000n) {
      throw new HttpError('Requested satoshis must be greater than minimum satoshis.', 400);
    }

    if (request.microgonsPerBtc == null || request.microgonsPerBtc <= 0n) {
      throw new HttpError('A current bitcoin price quote is required to initialize this bitcoin lock.', 400);
    }

    request.ownerAccountId = ownerAccountId;
    request.ownerBitcoinPubkey = ownerBitcoinPubkey;

    const existingRelay = this.db.bitcoinLockRelaysTable.fetchByCouponId(coupon.id);
    if (existingRelay) {
      assertMatchingRelayRequest(existingRelay, request);
      return this.toCouponStatus(coupon, existingRelay);
    }

    if (coupon.expirationTick != null && this.blockWatch.bestBlockHeader.tick >= coupon.expirationTick) {
      throw new HttpError('This bitcoin lock coupon has expired.', 400);
    }

    const inflight = this.inflightByOfferCode.get(offerCode);
    if (inflight) {
      assertMatchingRelayRequest(inflight.request, request);
      return inflight.promise;
    }

    const promise = this.submitNewRelay(coupon, request);
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

  public async createCoupon(request: ICreateBitcoinLockCouponRequest): Promise<IBitcoinLockCouponStatus> {
    await this.start();

    const coupon = this.db.bitcoinLockCouponsTable.insertCoupon({
      ...request,
      offerCode: nanoid(10),
    });

    return this.toCouponStatus(coupon);
  }

  public async activateLatestCoupon(request: IActivateBitcoinLockCouponRequest): Promise<IBitcoinLockCouponStatus> {
    await this.start();

    const coupon = this.db.bitcoinLockCouponsTable.fetchLatestByUserId(request.userId);
    if (!coupon) {
      throw new HttpError('Bitcoin lock coupon not found.', 404);
    }
    if (coupon.accountId && coupon.accountId !== request.accountId) {
      throw new HttpError('This invite is already claimed by a different account.', 409);
    }

    const expirationTick =
      coupon.expirationTick ?? MiningFrames.calculateCurrentTickFromSystemTime() + coupon.expiresAfterTicks;
    const activatedCoupon = this.db.bitcoinLockCouponsTable.activateCoupon(
      coupon.id,
      request.accountId,
      expirationTick,
    );
    if (!activatedCoupon) {
      throw new HttpError('Bitcoin lock coupon not found.', 404);
    }

    return this.toCouponStatus(activatedCoupon);
  }

  public async getBitcoinLockCouponStatus(offerCode: string): Promise<IBitcoinLockCouponStatus> {
    await this.start();

    const coupon = this.db.bitcoinLockCouponsTable.fetchByOfferCode(offerCode);
    if (!coupon) {
      throw new HttpError('Bitcoin lock coupon not found.', 404);
    }

    return this.toCouponStatus(coupon, this.db.bitcoinLockRelaysTable.fetchByCouponId(coupon.id));
  }

  public async getBitcoinLockCouponsByUserId(userId: number): Promise<IBitcoinLockCouponStatus[]> {
    await this.start();

    const relaysByCouponId = new Map(this.db.bitcoinLockRelaysTable.fetchAll().map(relay => [relay.couponId, relay]));

    return this.db.bitcoinLockCouponsTable
      .fetchByUserId(userId)
      .map(coupon => this.toCouponStatus(coupon, relaysByCouponId.get(coupon.id)));
  }

  public async getBitcoinLockCouponStatuses(): Promise<IBitcoinLockCouponStatus[]> {
    await this.start();

    const relaysByCouponId = new Map(this.db.bitcoinLockRelaysTable.fetchAll().map(relay => [relay.couponId, relay]));

    return this.db.bitcoinLockCouponsTable
      .fetchAll()
      .map(coupon => this.toCouponStatus(coupon, relaysByCouponId.get(coupon.id)));
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
    await this.tryLoadVault();

    this.bestBlocksUnsub = this.blockWatch.events.on('best-blocks', () => {
      void this.reconcileNonTerminalRelays();
    });

    await this.reconcileNonTerminalRelays();
  }

  private submitNewRelay(
    coupon: IBitcoinLockCouponRecord,
    request: IBitcoinLockRelayJobRequest,
  ): Promise<IBitcoinLockCouponStatus> {
    return this.runWithSubmitLock(async () => {
      const { offerCode, requestedSatoshis, ownerAccountId, ownerBitcoinPubkey, microgonsPerBtc } = request;
      const existingCoupon = this.db.bitcoinLockCouponsTable.fetchByOfferCode(offerCode);
      if (!existingCoupon) {
        throw new HttpError('Bitcoin lock coupon not found.', 404);
      }

      const existingRelay = this.db.bitcoinLockRelaysTable.fetchByCouponId(existingCoupon.id);
      if (existingRelay) {
        assertMatchingRelayRequest(existingRelay, request);
        return this.toCouponStatus(existingCoupon, existingRelay);
      }

      if (!coupon.expirationTick) {
        throw new HttpError('This invite has not been accepted yet.', 400);
      }
      if (coupon.accountId && coupon.accountId !== ownerAccountId) {
        throw new HttpError('This invite is claimed by a different account.', 409);
      }

      const preflight = await this.checkRelayCapacity(coupon, request);
      if (!preflight.canSubmit) {
        throw new HttpError(preflight.reason, preflight.statusCode);
      }

      if (this.vaultId == null) {
        await this.ensureVaultLoaded();
      }

      const client = await this.clients.get(false);
      const tx = client.tx.bitcoinLocks.initializeFor(
        ownerAccountId,
        this.vaultId!,
        requestedSatoshis,
        ownerBitcoinPubkey,
        { V1: { microgonsPerBtc } },
      );
      const txSubmittedAtBlockHeight = this.blockWatch.bestBlockHeader.blockNumber;
      const txSubmittedAtTime = new Date();
      const relayMortalityBlocks = getRelayMortalityBlocks();
      const txExpiresAtBlockHeight = txSubmittedAtBlockHeight + relayMortalityBlocks;
      const txNonce = await this.getNextNonce(client);
      const signedTx = await tx.signAsync(this.bitcoinInitializerDelegateKeypair, {
        nonce: txNonce,
        era: relayMortalityBlocks,
      });

      const submittedRelay = this.db.bitcoinLockRelaysTable.insertRelay({
        couponId: coupon.id,
        requestedSatoshis,
        securitizationUsedMicrogons: preflight.securitizationUsedMicrogons,
        ownerAccountId,
        ownerBitcoinPubkey,
        microgonsPerBtc,
        delegateAddress: this.delegateAddress,
        extrinsicHash: signedTx.hash.toHex(),
        extrinsicMethodJson: signedTx.method.toHuman(),
        txNonce,
        txSubmittedAtBlockHeight,
        txSubmittedAtTime,
        txExpiresAtBlockHeight,
      });
      this.relayWatchUnsubscribes.set(submittedRelay.id, () => undefined);

      let unsubscribe: () => void;
      try {
        unsubscribe = await signedTx.send(result => {
          void this.handleSubmissionUpdate(submittedRelay.id, client, result);
        });
      } catch (error) {
        this.nextNonce = undefined;
        const message = error instanceof Error ? error.message : String(error);
        return this.failRelay(submittedRelay.id, message);
      }

      const currentRelay = this.getRequiredRelay(submittedRelay.id);
      if (currentRelay.status === 'Failed' || currentRelay.status === 'Finalized') {
        unsubscribe();
        this.relayWatchUnsubscribes.delete(submittedRelay.id);
      } else {
        this.relayWatchUnsubscribes.set(submittedRelay.id, unsubscribe);
      }

      return this.getRequiredCouponStatus(coupon.id);
    });
  }

  private async checkRelayCapacity(
    coupon: IBitcoinLockCouponRecord,
    request: IBitcoinLockRelayJobRequest,
  ): Promise<IRelayPreflight> {
    await this.ensureVaultLoaded();

    const { requestedSatoshis, microgonsPerBtc } = request;
    const { expirationTick, maxSatoshis } = coupon;
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

    if (expirationTick == null || this.blockWatch.bestBlockHeader.tick >= expirationTick) {
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
      (total, relay) => total + (relay.securitizationUsedMicrogons ?? 0n),
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
        this.db.bitcoinLockRelaysTable.revertToSubmitted(relayId);
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
          txInBlockHeight: eventData.inBlockHeight,
          txInBlockHash: eventData.blockHashHex,
          txFeePlusTip: eventData.txFeePlusTip,
          txTip: eventData.txTip,
          utxoId: eventData.createdUtxoId ?? relay.utxoId ?? null,
        });
        return;
      }

      this.db.bitcoinLockRelaysTable.setInBlock(relayId, {
        txInBlockHeight: eventData.inBlockHeight,
        txInBlockHash: eventData.blockHashHex,
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
          const inBlock = await TransactionEvents.findByExtrinsicHash({
            blockWatch: this.blockWatch,
            extrinsicHash: relay.extrinsicHash,
            searchStartBlockHeight: relay.txSubmittedAtBlockHeight,
            bestBlockHeight: bestHeight,
            blockCache: this.blockCache,
            ignoreHeaderErrors: true,
          });

          if (inBlock) {
            const client = await this.blockWatch.getRpcClient(inBlock.blockNumber);
            const createdUtxoId = extractCreatedLockEvent(client, inBlock.extrinsicEvents);

            this.db.bitcoinLockRelaysTable.setInBlock(relay.id, {
              txInBlockHeight: inBlock.blockNumber,
              txInBlockHash: inBlock.blockHash,
              txFeePlusTip: inBlock.fee + inBlock.tip,
              txTip: inBlock.tip,
              utxoId: createdUtxoId ?? relay.utxoId ?? null,
            });
            continue;
          }

          if (bestHeight >= relay.txExpiresAtBlockHeight) {
            this.failRelay(relay.id, 'Relay expired before it was included in a block.');
          }
          continue;
        }

        if (relay.status === 'InBlock' && relay.txInBlockHeight != null && relay.txInBlockHash) {
          const header = await this.blockWatch.getHeader(relay.txInBlockHeight).catch(() => undefined);
          if (header && header.blockHash !== relay.txInBlockHash) {
            this.db.bitcoinLockRelaysTable.revertToSubmitted(relay.id);
            continue;
          }

          if (finalizedHeight >= relay.txInBlockHeight + RELAY_FINALIZATION_CONFIRMATIONS) {
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

    if (relay.utxoId == null) {
      this.failRelay(relayId, 'Relay finalized without a created bitcoin lock event.');
      return;
    }

    this.db.bitcoinLockRelaysTable.setFinalized(relayId, this.blockWatch.finalizedBlockHeader.blockNumber);
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

  private async ensureVaultLoaded(): Promise<void> {
    if (this.vaultId != null && this.latestVault) {
      return;
    }

    this.vaultLoadPromise ??= this.loadVault().finally(() => {
      this.vaultLoadPromise = undefined;
    });
    await this.vaultLoadPromise;
  }

  private async tryLoadVault(): Promise<void> {
    try {
      await this.ensureVaultLoaded();
    } catch (error) {
      if (!isMissingVaultError(error)) {
        throw error;
      }
    }
  }

  private getRequiredRelay(relayId: number): IBitcoinLockRelayRecord {
    const relay = this.db.bitcoinLockRelaysTable.fetchById(relayId);
    if (!relay) {
      throw new Error(`Relay ${relayId} was not found.`);
    }
    return relay;
  }

  private getRequiredCouponStatus(couponId: number): IBitcoinLockCouponStatus {
    const coupon = this.db.bitcoinLockCouponsTable.fetchById(couponId);
    if (!coupon) {
      throw new Error(`Bitcoin lock coupon ${couponId} was not found.`);
    }

    return this.toCouponStatus(coupon, this.db.bitcoinLockRelaysTable.fetchByCouponId(coupon.id));
  }

  private failRelay(
    relayId: number,
    error: string,
    fields?: {
      txInBlockHeight?: number | null;
      txInBlockHash?: string | null;
      txFeePlusTip?: bigint | null;
      txTip?: bigint | null;
      utxoId?: number | null;
    },
  ): IBitcoinLockCouponStatus {
    this.stopRelayWatch(relayId);

    const relay = this.db.bitcoinLockRelaysTable.setFailed(relayId, error, {
      txInBlockHeight: fields?.txInBlockHeight,
      txInBlockHash: fields?.txInBlockHash,
      txFeePlusTip: fields?.txFeePlusTip,
      txTip: fields?.txTip,
      utxoId: fields?.utxoId,
    });

    return this.getRequiredCouponStatus(relay.couponId);
  }

  private toCouponStatus(
    coupon: IBitcoinLockCouponRecord,
    relay?: IBitcoinLockRelayRecord | null,
  ): IBitcoinLockCouponStatus {
    const expiresAt = coupon.expirationTick ? MiningFrames.getTickDate(coupon.expirationTick) : undefined;
    let status: BitcoinLockCouponStatus = relay?.status ?? 'Open';
    if (!relay && coupon.expirationTick != null && this.blockWatch.bestBlockHeader.tick >= coupon.expirationTick) {
      status = 'Expired';
    }

    return {
      coupon,
      relay: relay ?? undefined,
      status,
      expiresAt,
    };
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
  existingRelay: IBitcoinLockRelayRecord | IBitcoinLockRelayJobRequest,
  request: IBitcoinLockRelayJobRequest,
): void {
  if (
    existingRelay.requestedSatoshis !== request.requestedSatoshis ||
    existingRelay.ownerAccountId !== request.ownerAccountId ||
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

function getRelayMortalityBlocks(): number {
  return NetworkConfig.canFrameBeZero() ? 32 : 8;
}

function isMissingVaultError(error: unknown): boolean {
  return error instanceof HttpError && error.status === 404;
}
