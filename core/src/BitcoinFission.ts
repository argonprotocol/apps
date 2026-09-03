import type { PriceIndex } from '@argonprotocol/mainchain';
import type { BitcoinFissionsFissionByOwnerAndIdResultSpec159 } from '@argonprotocol/runtime-client';
import { BitcoinLock, SATS_PER_BTC } from './BitcoinLock.js';
import type { ArgonClient, ArgonQueryClient } from './MainchainClients.js';
import { bigIntAbs } from './utils.js';

type IQueryableClient = ArgonQueryClient;

export class BitcoinFission implements IBitcoinFission {
  public ownerAccount: string;
  public fissionId: number;
  public liquidId: number;
  public utxoId: number;
  public satoshis: bigint;
  public microgonsAtTargetPerBtc: bigint;
  public liquidityPromised: bigint;
  public createdAtArgonBlock: number;
  public ratchetNumber: number;
  public lastRatchetTick?: number;
  public lastUpdatedArgonBlock: number;
  public origin?: 'created' | 'lock-migration';
  public ratchets: IBitcoinFissionRatchet[];
  public createdAtTick?: number;
  public createdBlockHash?: string;
  public createdBlockTime?: Date;
  public createdExtrinsicIndex?: number;
  public closedAtArgonBlock?: number;
  public closedAtTick?: number;
  public closedBlockHash?: string;
  public closedBlockTime?: Date;
  public closedExtrinsicIndex?: number;
  public closeReason?: 'closed' | 'lock-spent';
  public redemptionAmount?: bigint;
  public closeTxFee?: bigint;
  public btcPriceAtCloseMicrogons?: bigint;
  public createdAt?: Date;
  public updatedAt?: Date;
  public pendingMints: IBitcoinPendingMint[];

  constructor(data: IBitcoinFission) {
    this.ownerAccount = data.ownerAccount;
    this.fissionId = data.fissionId;
    this.liquidId = data.liquidId;
    this.utxoId = data.utxoId;
    this.satoshis = data.satoshis;
    this.microgonsAtTargetPerBtc = data.microgonsAtTargetPerBtc;
    this.liquidityPromised = data.liquidityPromised;
    this.createdAtArgonBlock = data.createdAtArgonBlock;
    this.ratchetNumber = data.ratchetNumber;
    this.lastRatchetTick = data.lastRatchetTick;
    this.lastUpdatedArgonBlock = data.lastUpdatedArgonBlock;
    this.origin = data.origin;
    this.ratchets = data.ratchets ?? [];
    this.createdAtTick = data.createdAtTick;
    this.createdBlockHash = data.createdBlockHash;
    this.createdBlockTime = data.createdBlockTime;
    this.createdExtrinsicIndex = data.createdExtrinsicIndex;
    this.closedAtArgonBlock = data.closedAtArgonBlock;
    this.closedAtTick = data.closedAtTick;
    this.closedBlockHash = data.closedBlockHash;
    this.closedBlockTime = data.closedBlockTime;
    this.closedExtrinsicIndex = data.closedExtrinsicIndex;
    this.closeReason = data.closeReason;
    this.redemptionAmount = data.redemptionAmount;
    this.closeTxFee = data.closeTxFee;
    this.btcPriceAtCloseMicrogons = data.btcPriceAtCloseMicrogons;
    this.createdAt = data.createdAt;
    this.updatedAt = data.updatedAt;
    this.pendingMints = [];
  }

  public static fromCurrentAndHistory(current: BitcoinFission, history: BitcoinFission): BitcoinFission {
    const fission = new BitcoinFission(current);
    fission.pendingMints = current.pendingMints;
    fission.origin = history.origin;
    fission.ratchets = history.ratchets;
    fission.createdAtTick = history.createdAtTick;
    fission.createdBlockHash = history.createdBlockHash;
    fission.createdBlockTime = history.createdBlockTime;
    fission.createdExtrinsicIndex = history.createdExtrinsicIndex;
    fission.createdAt = history.createdAt;
    fission.updatedAt = history.updatedAt;
    return fission;
  }

  public isRatchetAvailable(args: { microgonsAtTargetPerBtc: bigint; minimumRatchetPercent: bigint }): boolean {
    const { microgonsAtTargetPerBtc, minimumRatchetPercent } = args;
    const difference = bigIntAbs(microgonsAtTargetPerBtc - this.microgonsAtTargetPerBtc);
    const minimumChange = (this.microgonsAtTargetPerBtc * minimumRatchetPercent + 99n) / 100n;
    return difference > 0n && difference >= minimumChange;
  }

  public calculateRatchetAmounts(args: {
    priceIndex: PriceIndex;
    microgonsAtTargetPerBtc: bigint;
  }): IBitcoinFissionRatchetAmounts {
    const { priceIndex, microgonsAtTargetPerBtc } = args;
    const sourceLiquidity = this.liquidityPromised;
    const replacementLiquidity = BitcoinLock.calculateLiquidityPromised({
      priceIndex,
      satoshis: this.satoshis,
      microgonsAtTargetPerBtc,
    });

    if (replacementLiquidity >= sourceLiquidity) {
      return {
        sourceLiquidity,
        replacementLiquidity,
        amountMinted: replacementLiquidity - sourceLiquidity,
        amountBurned: 0n,
      };
    }

    return {
      sourceLiquidity,
      replacementLiquidity,
      amountMinted: replacementLiquidity,
      amountBurned: replacementLiquidity,
    };
  }

  public calculateRedemptionAmount(priceIndex: PriceIndex): bigint {
    const maximumMicrogonsAtTarget = (this.satoshis * this.microgonsAtTargetPerBtc) / SATS_PER_BTC;
    return BitcoinLock.calculateRedemptionAmountFromSatoshis(priceIndex, this.satoshis, maximumMicrogonsAtTarget);
  }

  public static createTx(args: {
    client: ArgonClient;
    fissionId: number;
    liquidId: number;
    utxoId: number;
    satoshis: bigint;
    microgonsAtTargetPerBtc: bigint;
  }) {
    const { client, fissionId, liquidId, utxoId, satoshis, microgonsAtTargetPerBtc } = args;
    return client.tx.bitcoinFissions.create(fissionId, liquidId, utxoId, satoshis, microgonsAtTargetPerBtc);
  }

  public static createRatchetTx(args: { client: ArgonClient; fissionId: number; microgonsAtTargetPerBtc: bigint }) {
    const { client, fissionId, microgonsAtTargetPerBtc } = args;
    return client.tx.bitcoinFissions.ratchet(fissionId, microgonsAtTargetPerBtc);
  }

  public static createCloseTx(args: { client: ArgonClient; fissionId: number }) {
    const { client, fissionId } = args;
    return client.tx.bitcoinFissions.close(fissionId);
  }

  public static async getAllByOwner(client: IQueryableClient, ownerAccount: string): Promise<BitcoinFission[]> {
    const entries = await client.query.bitcoinFissions.fissionByOwnerAndId.entries(ownerAccount);

    return (entries ?? []).flatMap(([key, rawFission]) => {
      if (!rawFission) return [];

      const fissionId = Number(key.args[1]);
      return [BitcoinFission.fromRuntime(ownerAccount, fissionId, rawFission)];
    });
  }

  public static async get(
    client: IQueryableClient,
    ownerAccount: string,
    fissionId: number,
  ): Promise<BitcoinFission | undefined> {
    const rawFission = await client.query.bitcoinFissions.fissionByOwnerAndId(ownerAccount, fissionId);
    if (!rawFission) return;

    return BitcoinFission.fromRuntime(ownerAccount, fissionId, rawFission);
  }

  public static async idsByLock(client: IQueryableClient, utxoId: number): Promise<number[]> {
    const fissionIds = await client.query.bitcoinFissions.fissionIdsByLockId(utxoId);
    return (fissionIds ?? []).map(Number);
  }

  public static async nextId(client: IQueryableClient, ownerAccount: string): Promise<number> {
    const fissionId = await client.query.bitcoinFissions.nextFissionIdByOwner(ownerAccount);
    return Number(fissionId);
  }

  public static async pendingMintsForLock(client: IQueryableClient, utxoId: number): Promise<IBitcoinPendingMint[]> {
    const pendingIndices = await client.query.mint.pendingMintUtxoIdLookup(utxoId);
    if (!pendingIndices) return [];
    const pendingMints = await client.query.mint.pendingMintUtxosByIndex.multi(pendingIndices.map(BigInt));

    return (pendingMints ?? []).flatMap((rawMint, index) => {
      if (!rawMint) return [];

      return [
        {
          queueIndex: pendingIndices[index],
          fissionId: Number(rawMint.fissionId),
          utxoId: rawMint.utxoId,
          ownerAccount: rawMint.accountId,
          remainingAmount: rawMint.remainingAmount,
          maxAmountPerFrame: rawMint.maxAmountPerFrame,
        },
      ];
    });
  }

  private static fromRuntime(
    ownerAccount: string,
    fissionId: number,
    fission: NonNullable<BitcoinFissionsFissionByOwnerAndIdResultSpec159>,
  ): BitcoinFission {
    return new BitcoinFission({
      ownerAccount,
      fissionId,
      liquidId: Number(fission.liquidId),
      utxoId: fission.utxoId,
      satoshis: fission.satoshis,
      microgonsAtTargetPerBtc: fission.microgonsAtTargetPerBtc,
      liquidityPromised: fission.liquidityPromised,
      createdAtArgonBlock: fission.createdAtArgonBlock,
      ratchetNumber: fission.ratchetNumber,
      lastRatchetTick: Number(fission.lastRatchetTick),
      lastUpdatedArgonBlock: fission.lastUpdatedArgonBlock,
    });
  }
}

export interface IBitcoinFission {
  ownerAccount: string;
  fissionId: number;
  liquidId: number;
  utxoId: number;
  satoshis: bigint;
  microgonsAtTargetPerBtc: bigint;
  liquidityPromised: bigint;
  createdAtArgonBlock: number;
  ratchetNumber: number;
  lastRatchetTick?: number;
  lastUpdatedArgonBlock: number;
  origin?: 'created' | 'lock-migration';
  ratchets?: IBitcoinFissionRatchet[];
  createdAtTick?: number;
  createdBlockHash?: string;
  createdBlockTime?: Date;
  createdExtrinsicIndex?: number;
  closedAtArgonBlock?: number;
  closedAtTick?: number;
  closedBlockHash?: string;
  closedBlockTime?: Date;
  closedExtrinsicIndex?: number;
  closeReason?: 'closed' | 'lock-spent';
  redemptionAmount?: bigint;
  closeTxFee?: bigint;
  btcPriceAtCloseMicrogons?: bigint;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface IBitcoinFissionRatchet {
  source: 'lock' | 'fission';
  sourceRatchetIndex: number;
  ratchetNumber?: number;
  microgonsAtTargetPerBtc: bigint;
  liquidityPromised?: bigint;
  amountMinted: bigint;
  amountBurned: bigint;
  mintPending: bigint;
  securityFee?: bigint;
  txFee?: bigint;
  blockNumber: number;
  tick?: number;
  blockHash?: string;
  blockTime?: Date;
  extrinsicIndex?: number;
}

export interface IBitcoinFissionRatchetAmounts {
  sourceLiquidity: bigint;
  replacementLiquidity: bigint;
  amountMinted: bigint;
  amountBurned: bigint;
}

export interface IBitcoinPendingMint {
  queueIndex: number;
  fissionId: number;
  utxoId: number;
  ownerAccount: string;
  remainingAmount: bigint;
  maxAmountPerFrame: bigint;
}
