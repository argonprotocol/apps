import {
  bigIntMax,
  BlockWatch,
  createDeferred,
  type IBitcoinLockRelayJobRequest,
  type IBitcoinLockRelayRecord,
  type IDeferred,
  MainchainClients,
  NetworkConfig,
  SATOSHIS_PER_BITCOIN,
  SingleFileQueue,
  TransactionEvents,
} from '@argonprotocol/apps-core';
import {
  type ArgonClient,
  BitcoinLock,
  type FrameSystemEventRecord,
  type GenericEvent,
  type KeyringPair,
  type SignedBlock,
  Vault,
} from '@argonprotocol/mainchain';
import type { ISubmittableResult } from '@polkadot/types/types/extrinsic';
import type { Db } from './Db.ts';
import { HttpError } from './HttpError.ts';

type IRelayCapacityCheck =
  | {
      canSubmit: true;
      client: ArgonClient;
      reservedLiquidityMicrogons: bigint;
    }
  | {
      canSubmit: false;
      shouldFail?: boolean;
      reason: string;
    };

type IRelayEventData = {
  txFeePlusTip: bigint;
  txTip: bigint;
  extrinsicError?: Error;
  inBlockHeight: number;
  blockHashHex: string;
  createdLock?: {
    utxoId: number;
    liquidityPromised: bigint;
    lockedMarketRate: bigint;
    securityFees: bigint;
    ownerAccountAddress: string;
  };
};

type IVaultSnapshot = {
  vault: Vault;
  updatedAtBestHeight: number;
};

const RELAY_FINALIZATION_CONFIRMATIONS = 4;
const RELAY_NOT_FOUND_WINDOW_BLOCKS = 12;

export class BitcoinLockRelayService {
  private readonly queue = new SingleFileQueue();
  private readonly queuedRelayIds = new Set<number>();
  private readonly blockCache = new Map<string, SignedBlock>();

  private startedPromise?: Promise<void>;
  private stopVaultSubscription?: () => void;
  private vaultId?: number;
  private latestVaultSnapshot?: IVaultSnapshot;
  private isReconciling = false;
  private bestBlocksUnsub?: () => void;

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

    if (this.vaultId == null) {
      throw new HttpError('Bitcoin lock relay vault is not loaded.', 503);
    }

    const existingRelay = this.db.bitcoinLockRelaysTable.fetchLatestByInviteId(request.routerInviteId);
    if (existingRelay && existingRelay.status !== 'Failed') {
      if (
        existingRelay.requestedSatoshis !== request.requestedSatoshis ||
        existingRelay.ownerAccountAddress !== request.ownerAccountAddress ||
        existingRelay.ownerBitcoinPubkey !== request.ownerBitcoinPubkey ||
        existingRelay.microgonsPerBtc !== request.microgonsPerBtc
      ) {
        throw new HttpError('This invite already has a different relay request in progress.', 409);
      }
      return existingRelay;
    }

    if (request.requestedSatoshis > request.maxSatoshis) {
      throw new HttpError('Requested satoshis exceed this offer limit.', 400);
    }

    const relay = this.db.bitcoinLockRelaysTable.insertQueuedRelay({
      ...request,
      vaultId: this.vaultId,
      status: 'Queued',
      queueReason: this.queuedRelayIds.size > 0 ? 'Waiting for the vault relay queue.' : null,
    });
    this.scheduleRelay(relay.id);

    return relay;
  }

  public async getRelayStatus(relayId: number): Promise<IBitcoinLockRelayRecord> {
    await this.start();

    const relay = this.db.bitcoinLockRelaysTable.fetchById(relayId);
    if (!relay) {
      throw new HttpError('Relay not found.', 404);
    }

    return relay;
  }

  public async shutdown(): Promise<void> {
    this.bestBlocksUnsub?.();
    this.bestBlocksUnsub = undefined;
    this.stopVaultSubscription?.();
    this.stopVaultSubscription = undefined;
    await this.queue.stop(true);
  }

  public get delegateAddress(): string {
    return this.bitcoinInitializerDelegateKeypair.address;
  }

  private async startInternal(): Promise<void> {
    await this.blockWatch.start();
    await this.loadVault();

    const nonTerminalRelays = this.db.bitcoinLockRelaysTable.fetchNonTerminal();
    this.bestBlocksUnsub = this.blockWatch.events.on('best-blocks', () => {
      void this.reconcileNonTerminalRelays();
    });

    for (const relay of nonTerminalRelays) {
      if (relay.status === 'Queued' || relay.status === 'WaitingForCapacity') {
        this.scheduleRelay(relay.id);
        continue;
      }

      if (relay.status === 'Submitting' && !relay.extrinsicHash) {
        this.db.bitcoinLockRelaysTable.update(relay.id, {
          status: 'Queued',
          queueReason: 'Retrying relay submission after restart.',
          reservedSatoshis: 0n,
          reservedLiquidityMicrogons: 0n,
        });
        this.scheduleRelay(relay.id);
      }
    }

    await this.reconcileNonTerminalRelays();
  }

  private scheduleRelay(relayId: number): void {
    if (this.queuedRelayIds.has(relayId)) return;

    this.queuedRelayIds.add(relayId);
    void this.queue
      .add(async () => {
        try {
          await this.processQueuedRelay(relayId);
        } finally {
          this.queuedRelayIds.delete(relayId);
        }
      })
      .promise.catch(error => {
        console.error(`[BitcoinLockRelayService] Relay ${relayId} queue task failed`, error);
      });
  }

  private async processQueuedRelay(relayId: number): Promise<void> {
    while (true) {
      let relay = this.getRequiredRelay(relayId);
      if (relay.status === 'Finalized' || relay.status === 'Failed') {
        return;
      }

      const capacityCheck = await this.checkRelayCapacity(relay);
      if (!capacityCheck.canSubmit) {
        if (capacityCheck.shouldFail) {
          this.failRelay(relay.id, capacityCheck.reason);
          return;
        }

        this.db.bitcoinLockRelaysTable.update(relay.id, {
          status: 'WaitingForCapacity',
          queueReason: capacityCheck.reason,
        });

        await new Promise<void>(resolve => {
          const unsubscribe = this.blockWatch.events.on('best-blocks', () => {
            unsubscribe();
            resolve();
          });
        });
        continue;
      }

      relay = this.db.bitcoinLockRelaysTable.update(relay.id, {
        status: 'Submitting',
        queueReason: null,
        reservedSatoshis: relay.requestedSatoshis,
        reservedLiquidityMicrogons: capacityCheck.reservedLiquidityMicrogons,
      });

      try {
        await this.submitRelay(relay, capacityCheck.client);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.failRelay(relay.id, message);
      }
      return;
    }
  }

  private async checkRelayCapacity(relay: IBitcoinLockRelayRecord): Promise<IRelayCapacityCheck> {
    const { requestedSatoshis, maxSatoshis, vaultId, microgonsPerBtc } = relay;
    if (requestedSatoshis > maxSatoshis) {
      return {
        canSubmit: false,
        shouldFail: true,
        reason: 'Requested satoshis exceed this offer limit.',
      };
    }

    if (this.blockWatch.bestBlockHeader.tick >= relay.expirationTick) {
      return {
        canSubmit: false,
        shouldFail: true,
        reason: 'This bitcoin lock coupon has expired.',
      };
    }

    if (this.vaultId == null) {
      return {
        canSubmit: false,
        shouldFail: true,
        reason: 'Bitcoin lock relay vault is not loaded.',
      };
    }

    if (!this.latestVaultSnapshot) {
      return {
        canSubmit: false,
        reason: 'Vault capacity watcher is still catching up.',
      };
    }

    const vault = this.latestVaultSnapshot.vault;
    if (vault.bitcoinLockDelegateAccount !== this.delegateAddress) {
      return {
        canSubmit: false,
        shouldFail: true,
        reason: 'The configured vault delegate is not registered on this vault.',
      };
    }

    const liquidityPromised = (requestedSatoshis * microgonsPerBtc) / SATOSHIS_PER_BITCOIN;
    const outstanding = this.getOutstandingReservations(relay.id);
    const availableBitcoinSpace = vault.availableBitcoinSpace() - outstanding.reservedSatoshis;
    const availableSecuritization = vault.availableSecuritization() - outstanding.reservedLiquidityMicrogons;

    if (availableBitcoinSpace < requestedSatoshis) {
      return {
        canSubmit: false,
        reason: `Vault bitcoin lock space is currently full for ${requestedSatoshis.toString()} sats.`,
      };
    }

    if (availableSecuritization < liquidityPromised) {
      return {
        canSubmit: false,
        reason: 'Vault securitization is currently exhausted for this lock request.',
      };
    }

    const client = await this.clients.get(false);
    const tx = client.tx.bitcoinLocks.initializeFor(
      relay.ownerAccountAddress,
      vaultId,
      requestedSatoshis,
      relay.ownerBitcoinPubkey,
      { V1: { microgonsPerBtc } },
    );
    const paymentInfo = await tx.paymentInfo(this.delegateAddress);
    const existentialDeposit = client.consts.balances.existentialDeposit.toBigInt();
    const txFee = paymentInfo.partialFee.toBigInt();
    const delegateBalance = await this.getDelegateBalance(client);

    if (delegateBalance < txFee + existentialDeposit) {
      return {
        canSubmit: false,
        shouldFail: true,
        reason: 'The vault delegate cannot afford the Argon transaction fee for this relay.',
      };
    }

    return {
      canSubmit: true,
      client,
      reservedLiquidityMicrogons: liquidityPromised,
    };
  }

  private async getDelegateBalance(client: ArgonClient): Promise<bigint> {
    const accountInfo = await client.query.system.account(this.delegateAddress);
    const free = accountInfo.data.free.toBigInt();
    const frozen = accountInfo.data.frozen.toBigInt();
    return bigIntMax(0n, free - frozen);
  }

  private async submitRelay(relay: IBitcoinLockRelayRecord, client: ArgonClient): Promise<void> {
    const submittedAtBlockHeight = (await client.rpc.chain.getHeader()).number.toNumber();
    const submittedAtTime = new Date();
    const tx = client.tx.bitcoinLocks.initializeFor(
      relay.ownerAccountAddress,
      relay.vaultId,
      relay.requestedSatoshis,
      relay.ownerBitcoinPubkey,
      { V1: { microgonsPerBtc: relay.microgonsPerBtc } },
    );

    const signedTx = await tx.signAsync(this.bitcoinInitializerDelegateKeypair);
    this.db.bitcoinLockRelaysTable.update(relay.id, {
      status: 'Submitted',
      queueReason: null,
      delegateAddress: this.delegateAddress,
      extrinsicHash: signedTx.hash.toHex(),
      extrinsicMethodJson: signedTx.method.toHuman(),
      nonce: signedTx.nonce.toNumber(),
      submittedAtBlockHeight,
      submittedAtTime,
    });

    const submissionDeferred = createDeferred<void>(false);

    void signedTx
      .send(result => {
        void this.handleSubmissionUpdate(relay.id, client, result, submissionDeferred);
      })
      .catch(submissionDeferred.reject);

    await submissionDeferred.promise;
  }

  private async handleSubmissionUpdate(
    relayId: number,
    client: ArgonClient,
    result: ISubmittableResult,
    submissionDeferred: IDeferred<void>,
  ): Promise<void> {
    const status = result.status;
    const relay = this.getRequiredRelay(relayId);

    if (status.isRetracted) {
      this.failRelay(relayId, 'Relay was retracted before it was included in a block.');
      submissionDeferred.reject(new Error('Relay was retracted before inclusion.'));
      return;
    }

    if (status.isUsurped) {
      this.failRelay(relayId, `Relay was usurped by ${status.asUsurped.toHex()}.`);
      submissionDeferred.reject(new Error('Relay was usurped before inclusion.'));
      return;
    }

    if (status.isDropped) {
      this.failRelay(relayId, 'Relay was dropped before it was included in a block.');
      submissionDeferred.reject(new Error('Relay was dropped before inclusion.'));
      return;
    }

    if (status.isInvalid) {
      this.failRelay(relayId, 'Relay was rejected as invalid by the node.');
      submissionDeferred.reject(new Error('Relay was rejected as invalid.'));
      return;
    }

    if (status.isInBlock) {
      const eventData = await this.getRelayEventData(client, result, status.asInBlock.toHex());
      if (eventData.extrinsicError) {
        this.failRelay(relayId, eventData.extrinsicError.message);
        submissionDeferred.reject(eventData.extrinsicError);
        return;
      }

      this.db.bitcoinLockRelaysTable.update(relay.id, {
        status: 'InBlock',
        queueReason: null,
        inBlockHeight: eventData.inBlockHeight,
        inBlockHash: eventData.blockHashHex,
        txFeePlusTip: eventData.txFeePlusTip,
        txTip: eventData.txTip,
        utxoId: eventData.createdLock?.utxoId ?? relay.utxoId ?? null,
        createdLock:
          eventData.createdLock == null
            ? relay.createdLock
            : {
                ...(relay.createdLock ?? {}),
                ...eventData.createdLock,
                vaultId: relay.vaultId,
                satoshis: relay.requestedSatoshis,
                createdAtHeight: eventData.inBlockHeight,
              },
      });

      submissionDeferred.resolve();
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
        if (relay.status === 'Submitted' && relay.extrinsicHash && relay.submittedAtBlockHeight != null) {
          const inBlock = await TransactionEvents.findByExtrinsicHash({
            blockWatch: this.blockWatch,
            extrinsicHash: relay.extrinsicHash,
            searchStartBlockHeight: Math.max(
              relay.submittedAtBlockHeight,
              relay.inBlockHeight ?? relay.submittedAtBlockHeight,
            ),
            bestBlockHeight: bestHeight,
            blockCache: this.blockCache,
            ignoreHeaderErrors: true,
          });
          if (inBlock) {
            const client = await this.blockWatch.getRpcClient(inBlock.blockNumber);
            const createdLock = extractCreatedLockEvent(client, inBlock.extrinsicEvents);
            this.db.bitcoinLockRelaysTable.update(relay.id, {
              status: 'InBlock',
              queueReason: null,
              inBlockHeight: inBlock.blockNumber,
              inBlockHash: inBlock.blockHash,
              txFeePlusTip: inBlock.fee + inBlock.tip,
              txTip: inBlock.tip,
              utxoId: createdLock?.utxoId ?? relay.utxoId ?? null,
              createdLock:
                createdLock == null
                  ? relay.createdLock
                  : {
                      ...(relay.createdLock ?? {}),
                      ...createdLock,
                      vaultId: relay.vaultId,
                      satoshis: relay.requestedSatoshis,
                      createdAtHeight: inBlock.blockNumber,
                    },
            });
          } else if (finalizedHeight - relay.submittedAtBlockHeight > RELAY_NOT_FOUND_WINDOW_BLOCKS) {
            this.failRelay(relay.id, 'Relay was not observed in a block before the retry window expired.');
          }
        }

        if (relay.status === 'InBlock' && relay.inBlockHeight != null) {
          if (relay.reservedSatoshis > 0n && this.hasReservationReflected(relay)) {
            this.db.bitcoinLockRelaysTable.clearReservation(relay.id);
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

    const client = await this.clients.get(false);
    const lock = await BitcoinLock.get(client, relay.utxoId);
    if (!lock) {
      this.failRelay(relayId, `Unable to load finalized bitcoin lock ${relay.utxoId}.`);
      return;
    }

    this.db.bitcoinLockRelaysTable.update(relayId, {
      status: 'Finalized',
      queueReason: null,
      finalizedHeight: this.blockWatch.finalizedBlockHeader.blockNumber,
      createdLock: {
        utxoId: relay.utxoId,
        vaultId: lock.vaultId,
        ownerAccountAddress: lock.ownerAccount,
        satoshis: lock.satoshis,
        liquidityPromised: lock.liquidityPromised,
        lockedMarketRate: lock.lockedMarketRate,
        securityFees: lock.securityFees,
        createdAtHeight: lock.createdAtHeight,
        lockDetailsJson: lock,
      },
    });
    this.db.bitcoinLockRelaysTable.clearReservation(relayId);
  }

  private async loadVault(): Promise<void> {
    const client = await this.clients.get(false);
    const vaultIdOption = await client.query.vaults.vaultIdByOperator(this.vaultOperatorAddress);
    if (!vaultIdOption.isSome) {
      throw new HttpError(`No vault was found for operator ${this.vaultOperatorAddress}.`, 404);
    }

    const vaultId = vaultIdOption.unwrap().toNumber();
    this.vaultId = vaultId;

    const vaultOption = await client.query.vaults.vaultsById(vaultId);
    if (!vaultOption.isSome) {
      throw new HttpError(`Vault ${vaultId} was not found on chain.`, 404);
    }

    const initialVault = new Vault(vaultId, vaultOption.unwrap(), NetworkConfig.tickMillis);
    this.latestVaultSnapshot = {
      vault: initialVault,
      updatedAtBestHeight: this.blockWatch.bestBlockHeader.blockNumber,
    };

    this.stopVaultSubscription?.();
    this.stopVaultSubscription = await client.query.vaults.vaultsById(vaultId, vaultOption => {
      if (!vaultOption.isSome) return;

      const rawVault = vaultOption.unwrap();
      const nextVault = new Vault(vaultId, rawVault, NetworkConfig.tickMillis);
      this.latestVaultSnapshot = {
        vault: nextVault,
        updatedAtBestHeight: this.blockWatch.bestBlockHeader.blockNumber,
      };
    });
  }

  private getOutstandingReservations(excludeRelayId?: number): {
    reservedSatoshis: bigint;
    reservedLiquidityMicrogons: bigint;
  } {
    return this.db.bitcoinLockRelaysTable.fetchOutstandingReservations().reduce(
      (totals, relay) => {
        if (relay.id === excludeRelayId) return totals;
        if (this.hasReservationReflected(relay)) return totals;

        totals.reservedSatoshis += relay.reservedSatoshis;
        totals.reservedLiquidityMicrogons += relay.reservedLiquidityMicrogons;
        return totals;
      },
      { reservedSatoshis: 0n, reservedLiquidityMicrogons: 0n },
    );
  }

  private hasReservationReflected(relay: IBitcoinLockRelayRecord): boolean {
    if (!relay.inBlockHeight || !this.latestVaultSnapshot) return false;
    return this.latestVaultSnapshot.updatedAtBestHeight >= relay.inBlockHeight;
  }

  private getRequiredRelay(relayId: number): IBitcoinLockRelayRecord {
    const relay = this.db.bitcoinLockRelaysTable.fetchById(relayId);
    if (!relay) {
      throw new Error(`Relay ${relayId} was not found.`);
    }
    return relay;
  }

  private failRelay(relayId: number, error: string): IBitcoinLockRelayRecord {
    return this.db.bitcoinLockRelaysTable.update(relayId, {
      status: 'Failed',
      queueReason: null,
      error,
      reservedSatoshis: 0n,
      reservedLiquidityMicrogons: 0n,
    });
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
      createdLock: extractCreatedLockEvent(client, txEvents.extrinsicEvents),
    };
  }
}

function extractCreatedLockEvent(client: ArgonClient, events: GenericEvent[]) {
  const createdEvent = events.find(event => client.events.bitcoinLocks.BitcoinLockCreated.is(event));
  if (!createdEvent) return undefined;

  const { utxoId, liquidityPromised, lockedMarketRate, accountId, securityFee } = createdEvent.data;
  return {
    utxoId: utxoId.toNumber(),
    liquidityPromised: liquidityPromised.toBigInt(),
    lockedMarketRate: lockedMarketRate.toBigInt(),
    ownerAccountAddress: accountId.toString(),
    securityFees: securityFee.toBigInt(),
  };
}
