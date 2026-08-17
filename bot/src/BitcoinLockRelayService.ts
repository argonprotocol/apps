import {
  bigNumberToBigInt,
  BlockWatch,
  type ISignBitcoinLockFeeCouponRequest,
  type IBitcoinLockRelayJobRequest,
  type IBitcoinLockRelayRecord,
  MainchainClients,
  NetworkConfig,
  SATOSHIS_PER_BITCOIN,
  TransactionEvents,
} from '@argonprotocol/apps-core';
import {
  type ArgonClient,
  BitcoinLock,
  type BitcoinLockFeeCoupon,
  type FrameSystemEventRecord,
  type GenericEvent,
  type ISubmittableResult,
  PriceIndex,
  type SignedBlock,
  getOfflineRegistry,
  u8aToHex,
  Vault,
} from '@argonprotocol/mainchain';
import { hexToU8a, stringToU8a } from '@polkadot/util';
import { blake2AsU8a } from '@polkadot/util-crypto';
import type { Db } from './Db.ts';
import { DelegateSubmitLane } from './DelegateSubmitLane.ts';
import { HttpError } from './HttpError.ts';

type IRelayPreflight =
  | {
      canSubmit: true;
      securitizationUsedMicrogons: bigint;
      priceIndex: PriceIndex;
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
  private readonly inflightByRequestId = new Map<
    string,
    { request: IBitcoinLockRelayJobRequest; promise: Promise<IBitcoinLockRelayRecord> }
  >();

  private startedPromise?: Promise<void>;
  private stopVaultSubscription?: () => void;
  private vaultId?: number;
  private latestVault?: Vault;
  private vaultLoadPromise?: Promise<void>;
  private isReconciling = false;
  private bestBlocksUnsub?: () => void;

  constructor(
    private readonly db: Db,
    private readonly clients: MainchainClients,
    private readonly blockWatch: BlockWatch,
    private readonly vaultOperatorAddress: string,
    private readonly submitLane: DelegateSubmitLane,
  ) {}

  public async start(): Promise<void> {
    this.startedPromise ??= this.startInternal().catch(error => {
      this.startedPromise = undefined;
      throw error;
    });
    return this.startedPromise;
  }

  public async relayBitcoinLock(request: IBitcoinLockRelayJobRequest): Promise<IBitcoinLockRelayRecord> {
    await this.start();

    const requestId = request.requestId?.trim();
    const ownerAccountId = request.ownerAccountId?.trim();
    const ownerBitcoinPubkey = request.ownerBitcoinPubkey?.trim();

    if (!requestId) throw new HttpError('A request id is required for this bitcoin lock.', 400);

    if (!ownerAccountId) {
      throw new HttpError('An owner account id is required for this bitcoin lock.', 400);
    }

    if (!ownerBitcoinPubkey) {
      throw new HttpError('An owner bitcoin pubkey is required for this bitcoin lock.', 400);
    }

    if (request.requestedSatoshis <= 1000n) {
      throw new HttpError('Requested satoshis must be greater than minimum satoshis.', 400);
    }

    if (request.microgonsAtTargetPerBtc == null || request.microgonsAtTargetPerBtc <= 0n) {
      throw new HttpError('A current bitcoin price quote is required to initialize this bitcoin lock.', 400);
    }

    request.ownerAccountId = ownerAccountId;
    request.ownerBitcoinPubkey = ownerBitcoinPubkey;
    request.requestId = requestId;

    const existingRelay = this.db.bitcoinLockRelaysTable.fetchByRequestId(requestId);
    if (existingRelay) {
      assertMatchingRelayRequest(existingRelay, request);
      return existingRelay;
    }

    const inflight = this.inflightByRequestId.get(requestId);
    if (inflight) {
      assertMatchingRelayRequest(inflight.request, request);
      return inflight.promise;
    }

    const promise = this.submitNewRelay(request);
    this.inflightByRequestId.set(requestId, { request, promise });

    try {
      return await promise;
    } finally {
      const current = this.inflightByRequestId.get(requestId);
      if (current?.promise === promise) {
        this.inflightByRequestId.delete(requestId);
      }
    }
  }

  public async signFeeCoupon(request: ISignBitcoinLockFeeCouponRequest): Promise<BitcoinLockFeeCoupon> {
    await this.start();

    const beneficiary = request.beneficiary.trim();
    if (!beneficiary) throw new HttpError('A beneficiary is required for this Bitcoin fee coupon.', 400);
    if (request.feeDiscountMicrogons <= 0n) {
      throw new HttpError('A positive Bitcoin fee discount is required for this coupon.', 400);
    }
    if (request.requestedSatoshis <= 0n) {
      throw new HttpError('A positive Bitcoin lock amount is required for this coupon.', 400);
    }
    if (request.microgonsAtTargetPerBtc <= 0n) {
      throw new HttpError('A positive Bitcoin price is required for this coupon.', 400);
    }
    if (!Number.isSafeInteger(request.expiresAfterTicks) || request.expiresAfterTicks <= 0) {
      throw new HttpError('A positive coupon duration is required.', 400);
    }

    const client = await this.clients.get(false);
    if (BitcoinLock.supportsInitializeFor(client)) {
      throw new HttpError('The connected runtime still uses delegated Bitcoin lock initialization.', 409);
    }

    await this.ensureVaultLoaded();
    const vault = this.latestVault;
    if (!vault || vault.vaultId !== request.vaultId) {
      throw new HttpError('This Bitcoin fee coupon does not match the configured vault.', 400);
    }
    if (vault.delegateAccountId !== this.delegateAddress) {
      throw new HttpError('The configured vault delegate is not registered on this vault.', 400);
    }

    const lifetimeFrames = Math.max(1, Math.ceil(request.expiresAfterTicks / NetworkConfig.rewardTicksPerFrame));
    const [nextFrameId, previousNonce] = await Promise.all([
      client.query.miningSlot.nextFrameId(),
      client.query.bitcoinLocks.lastFeeCouponNonceByVaultAndAccount(request.vaultId, beneficiary),
    ]);
    const currentFrame = nextFrameId.toBigInt() - 1n;
    const nextNonce = previousNonce.isSome ? previousNonce.unwrap().toBigInt() + 1n : 1n;
    if (request.feeCouponNonce != null && request.feeCouponNonce !== nextNonce) {
      throw new HttpError('This Bitcoin fee coupon nonce is no longer available.', 409);
    }
    const feeCoupon: BitcoinLockFeeCoupon = {
      vaultId: request.vaultId,
      genesisHash: client.genesisHash.toHex(),
      beneficiary,
      feeDiscount: request.feeDiscountMicrogons,
      securitizationSpaceToUnreserve: 0n,
      expiresAtFrame: currentFrame + BigInt(lifetimeFrames),
      nonce: nextNonce,
      signature: '',
    };

    const message = getOfflineRegistry()
      .createType('(Bytes,H256,u32,AccountId,u64,u128,u128,u128,u64,u64)', [
        u8aToHex(stringToU8a('bitcoin_lock_fee_coupon')),
        feeCoupon.genesisHash,
        feeCoupon.vaultId,
        feeCoupon.beneficiary,
        request.requestedSatoshis,
        request.microgonsAtTargetPerBtc,
        feeCoupon.feeDiscount,
        feeCoupon.securitizationSpaceToUnreserve,
        feeCoupon.expiresAtFrame,
        feeCoupon.nonce,
      ])
      .toU8a();

    feeCoupon.signature = u8aToHex(this.submitLane.keypair.sign(blake2AsU8a(message, 256), { withType: true }));
    return feeCoupon;
  }

  public getBitcoinLockRelay(requestId: string): IBitcoinLockRelayRecord {
    const relay = this.db.bitcoinLockRelaysTable.fetchByRequestId(requestId);
    if (!relay) throw new HttpError('Bitcoin lock relay not found.', 404);
    return relay;
  }

  public getBitcoinLockRelays(): IBitcoinLockRelayRecord[] {
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
    return this.submitLane.address;
  }

  private async startInternal(): Promise<void> {
    await this.blockWatch.start();
    await this.tryLoadVault();

    this.bestBlocksUnsub = this.blockWatch.events.on('best-blocks', () => {
      void this.reconcileNonTerminalRelays();
    });

    await this.reconcileNonTerminalRelays();
  }

  private async submitNewRelay(request: IBitcoinLockRelayJobRequest): Promise<IBitcoinLockRelayRecord> {
    return await this.submitLane.runExclusive(async (client, getNonce) => {
      if (!BitcoinLock.supportsInitializeFor(client)) {
        throw new HttpError(
          'This runtime no longer supports delegated Bitcoin lock initialization. Update Argon Desktop to use the fee coupon directly.',
          409,
        );
      }

      const { requestId, requestedSatoshis, ownerAccountId, ownerBitcoinPubkey, microgonsAtTargetPerBtc } = request;

      const existingRelay = this.db.bitcoinLockRelaysTable.fetchByRequestId(requestId);
      if (existingRelay) {
        assertMatchingRelayRequest(existingRelay, request);
        return existingRelay;
      }

      const preflight = await this.checkRelayCapacity(request);
      if (!preflight.canSubmit) {
        throw new HttpError(preflight.reason, preflight.statusCode);
      }

      if (this.vaultId == null) {
        await this.ensureVaultLoaded();
      }

      const { tx } = await BitcoinLock.createInitializeTx({
        client,
        vault: this.latestVault!,
        priceIndex: preflight.priceIndex,
        ownerBitcoinPubkey: hexToU8a(ownerBitcoinPubkey),
        satoshis: requestedSatoshis,
        txSigner: this.submitLane.keypair,
        microgonsAtTargetPerBtc,
        initializeForAccountId: ownerAccountId,
      });
      const txSubmittedAtBlockHeight = this.blockWatch.bestBlockHeader.blockNumber;
      const txSubmittedAtTime = new Date();
      const relayMortalityBlocks = getRelayMortalityBlocks();
      const txExpiresAtBlockHeight = txSubmittedAtBlockHeight + relayMortalityBlocks;
      const txNonce = await getNonce();
      const signedTx = await tx.signAsync(this.submitLane.keypair, {
        nonce: txNonce,
        era: relayMortalityBlocks,
      });

      const submittedRelay = this.db.bitcoinLockRelaysTable.insertRelay({
        requestId,
        requestedSatoshis,
        securitizationUsedMicrogons: preflight.securitizationUsedMicrogons,
        ownerAccountId,
        ownerBitcoinPubkey,
        microgonsAtTargetPerBtc,
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

      return this.getRequiredRelay(submittedRelay.id);
    });
  }

  private async checkRelayCapacity(request: IBitcoinLockRelayJobRequest): Promise<IRelayPreflight> {
    await this.ensureVaultLoaded();

    const { requestedSatoshis, microgonsAtTargetPerBtc } = request;
    const client = await this.clients.get(false);
    const priceIndex = await new PriceIndex().load(client);
    const latestVault = this.latestVault;
    if (!latestVault) {
      throw new Error('Bitcoin lock relay vault failed to load.');
    }
    if (request.vaultId !== latestVault.vaultId) {
      return {
        canSubmit: false,
        reason: 'This bitcoin lock request does not match the configured vault.',
        statusCode: 400,
      };
    }

    if (latestVault.delegateAccountId !== this.delegateAddress) {
      return {
        canSubmit: false,
        reason: 'The configured vault delegate is not registered on this vault.',
        statusCode: 400,
      };
    }

    const pendingSubmittedRelays = this.db.bitcoinLockRelaysTable
      .fetchNonTerminal()
      .filter(relay => relay.status === 'Submitted');
    const lockedTargetPrice = (requestedSatoshis * microgonsAtTargetPerBtc) / SATOSHIS_PER_BITCOIN;
    const requiredLiquidity = BitcoinLock.calculateRedemptionAmount(priceIndex, lockedTargetPrice);
    const requiredSecuritization = bigNumberToBigInt(
      latestVault.securitizationRatioBN().multipliedBy(requiredLiquidity),
    );
    const pendingSubmittedSecuritization = pendingSubmittedRelays.reduce(
      (total, relay) => total + (relay.securitizationUsedMicrogons ?? 0n),
      0n,
    );
    const availableSecuritization = latestVault.availableSecuritizationSpace();

    if (availableSecuritization < requiredSecuritization + pendingSubmittedSecuritization) {
      const totalRequiredSecuritization = requiredSecuritization + pendingSubmittedSecuritization;
      console.warn('[BitcoinLockRelayService] Vault securitization is currently exhausted for this lock request.', {
        requestId: request.requestId,
        vaultId: latestVault.vaultId,
        requestedSatoshis: requestedSatoshis.toString(),
        microgonsAtTargetPerBtc: microgonsAtTargetPerBtc.toString(),
        lockedTargetPrice: lockedTargetPrice.toString(),
        requiredLiquidityMicrogons: requiredLiquidity.toString(),
        requiredSecuritizationMicrogons: requiredSecuritization.toString(),
        pendingSubmittedSecuritizationMicrogons: pendingSubmittedSecuritization.toString(),
        availableSecuritizationMicrogons: availableSecuritization.toString(),
        totalRequiredSecuritizationMicrogons: totalRequiredSecuritization.toString(),
      });
      return {
        canSubmit: false,
        reason: 'Vault securitization is currently exhausted for this lock request.',
        statusCode: 409,
      };
    }

    return {
      canSubmit: true,
      securitizationUsedMicrogons: requiredSecuritization,
      priceIndex,
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
      this.failRelay(relayId, 'Relay was retracted before it was included in a block.');
      return;
    }

    if (status.isUsurped) {
      this.failRelay(relayId, `Relay was usurped by ${status.asUsurped.toHex()}.`);
      return;
    }

    if (status.isDropped) {
      this.failRelay(relayId, 'Relay was dropped before it was included in a block.');
      return;
    }

    if (status.isInvalid) {
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
  ): IBitcoinLockRelayRecord {
    this.stopRelayWatch(relayId);

    const relay = this.db.bitcoinLockRelaysTable.setFailed(relayId, error, fields);

    return relay;
  }

  private stopRelayWatch(relayId: number): void {
    this.relayWatchUnsubscribes.get(relayId)?.();
    this.relayWatchUnsubscribes.delete(relayId);
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
    existingRelay.microgonsAtTargetPerBtc !== request.microgonsAtTargetPerBtc
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
