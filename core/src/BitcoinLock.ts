import { PriceIndex } from '@argonprotocol/mainchain';
import type {
  BitcoinLocksLocksByIdResultSpec159,
  BitcoinUtxosBitcoinNetworkResultSpec100,
} from '@argonprotocol/runtime-client';
import { toRuntimeEvent } from '@argonprotocol/runtime-client';
import { hexToU8a, u8aToHex } from '@polkadot/util';
import BigNumber from 'bignumber.js';
import type { BitcoinLockFeeCoupon } from './interfaces/IBitcoinLockCoupon.js';
import type { ArgonClient, ArgonQueryClient } from './MainchainClients.js';
import { TxResult, type RuntimeEvent } from './TxResult.js';
import { TxSubmitter, type TxSigningAccount } from './TxSubmitter.js';
import type { Vault } from './Vault.js';

export const SATS_PER_BTC = 100_000_000n;

type IQueryableClient = ArgonQueryClient;
type UtxoRefInput = { txid: string; outputIndex: number };

type BitcoinLockInitializationTerms =
  | {
      feeCoupon: BitcoinLockFeeCoupon;
      microgonsAtTargetPerBtc: bigint;
    }
  | {
      feeCoupon?: undefined;
      microgonsAtTargetPerBtc?: bigint;
    };

export class BitcoinLock implements IBitcoinLock {
  public lockId: number;
  public p2wshScriptHashHex: string;
  public vaultId: number;
  public securitizedSatoshis: bigint;
  public microgonsAtTargetPerBtc: bigint;
  public securitizationCoverageMicrogons: bigint;
  public securitizationTick: number;
  public fundedSatoshis: bigint;
  public fundingUtxos: IBitcoinLockFundingUtxo[];
  public fissionedSatoshis: bigint;
  public ownerAccount: string;
  public securitizationRatio: number;
  public securityFees: bigint;
  public couponFeesPaid: bigint;
  public vaultPubkey: string;
  public vaultClaimPubkey: string;
  public ownerPubkey: string;
  public vaultXpubSources: {
    parentFingerprint: Uint8Array;
    cosignHdIndex: number;
    claimHdIndex: number;
  };
  public vaultClaimHeight: number;
  public openClaimHeight: number;
  public createdAtHeight: number;
  public securitizationHoldExpirationBitcoinHeight: number;
  public isFlexible: boolean;
  public fundHoldExtensionsByBitcoinExpirationHeight: Record<number, bigint>;
  public createdAtArgonBlock: number;

  constructor(data: IBitcoinLock) {
    this.lockId = data.lockId;
    this.p2wshScriptHashHex = data.p2wshScriptHashHex;
    this.vaultId = data.vaultId;
    this.securitizedSatoshis = data.securitizedSatoshis;
    this.microgonsAtTargetPerBtc = data.microgonsAtTargetPerBtc;
    this.securitizationCoverageMicrogons = data.securitizationCoverageMicrogons;
    this.securitizationTick = data.securitizationTick;
    this.fundedSatoshis = data.fundedSatoshis;
    this.fundingUtxos = data.fundingUtxos;
    this.fissionedSatoshis = data.fissionedSatoshis;
    this.ownerAccount = data.ownerAccount;
    this.securitizationRatio = data.securitizationRatio;
    this.securityFees = data.securityFees;
    this.couponFeesPaid = data.couponFeesPaid;
    this.vaultPubkey = data.vaultPubkey;
    this.vaultClaimPubkey = data.vaultClaimPubkey;
    this.ownerPubkey = data.ownerPubkey;
    this.vaultXpubSources = data.vaultXpubSources;
    this.vaultClaimHeight = data.vaultClaimHeight;
    this.openClaimHeight = data.openClaimHeight;
    this.createdAtHeight = data.createdAtHeight;
    this.securitizationHoldExpirationBitcoinHeight = data.securitizationHoldExpirationBitcoinHeight;
    this.isFlexible = data.isFlexible;
    this.fundHoldExtensionsByBitcoinExpirationHeight = data.fundHoldExtensionsByBitcoinExpirationHeight;
    this.createdAtArgonBlock = data.createdAtArgonBlock;
  }

  public get isFunded(): boolean {
    return this.fundedSatoshis > 0n;
  }

  public static async get(client: IQueryableClient, lockId: number): Promise<BitcoinLock | undefined> {
    const lock = await client.query.bitcoinLocks.locksById(lockId);
    if (!lock) return;

    return BitcoinLock.fromRuntime(lockId, lock);
  }

  public static async getMany(client: IQueryableClient, lockIds: number[]): Promise<(BitcoinLock | undefined)[]> {
    const locks = await client.query.bitcoinLocks.locksById.multi(lockIds);
    return (locks ?? []).map((lock, index) => {
      if (!lock) return;
      return BitcoinLock.fromRuntime(lockIds[index], lock);
    });
  }

  public static async idsByOwner(client: IQueryableClient, ownerAccount: string): Promise<number[]> {
    const keys = await client.query.bitcoinLocks.lockIdsByOwnerAccount.keys(ownerAccount);
    return [...new Set((keys ?? []).map(key => key.args[1]))];
  }

  public static async getFundingUtxoRefs(
    client: IQueryableClient,
    lockId: number,
  ): Promise<{ txid: string; vout: number }[]> {
    const refs = await client.query.bitcoinUtxos.utxoRefsByLockId(lockId);
    return (refs ?? []).map(ref => ({ txid: ref.txid, vout: ref.outputIndex }));
  }

  public static async getReleaseRequest(
    client: IQueryableClient,
    lockId: number,
  ): Promise<IReleaseRequestDetails | undefined> {
    const request = await client.query.bitcoinLocks.lockReleaseRequestsById(lockId);
    if (!request) return;

    return {
      toScriptPubkey: u8aToHex(request.toScriptPubkey),
      bitcoinNetworkFee: request.bitcoinNetworkFee,
      insuredMicrogons: request.securitizationAtRisk,
    };
  }

  public static async findVaultCosignatures(
    client: ArgonClient,
    lockId: number,
  ): Promise<{ blockHeight: number; signatures: Uint8Array[] } | undefined> {
    const finalizedHead = await client.rpc.chain.getFinalizedHead();
    const finalizedClient = await client.at(finalizedHead);
    const releaseHeight = await finalizedClient.query.bitcoinLocks.lockReleaseCosignHeightById(lockId);
    if (releaseHeight === null) return;

    const blockHeight = releaseHeight;
    const blockHash = await client.rpc.chain.getBlockHash(blockHeight);
    const blockEvents = await client.at(blockHash).then(api => api.query.system.events());
    for (const { event } of blockEvents) {
      const runtimeEvent = toRuntimeEvent(event);
      if (runtimeEvent?.section !== 'bitcoinLocks' || runtimeEvent.method !== 'BitcoinUtxoCosigned') continue;

      const eventLockId = runtimeEvent.data.lockId ?? runtimeEvent.data.utxoId;
      const signatures =
        runtimeEvent.data.signatures ?? (runtimeEvent.data.signature ? [runtimeEvent.data.signature] : undefined);
      if (eventLockId !== lockId || !signatures?.length) continue;

      return {
        blockHeight,
        signatures: [...signatures],
      };
    }
  }

  public static createReleaseTx(args: {
    client: ArgonClient;
    lockId: number;
    toScriptPubkey: string;
    bitcoinNetworkFee: bigint;
  }) {
    const { client, lockId, toScriptPubkey, bitcoinNetworkFee } = args;
    assertHexScriptPubkey(toScriptPubkey);
    return client.tx.bitcoinLocks.requestRelease(lockId, toScriptPubkey, bitcoinNetworkFee);
  }

  public static createOrphanedReleaseTx(args: {
    client: ArgonClient;
    utxoRef: UtxoRefInput;
    toScriptPubkey: string;
    bitcoinNetworkFee: bigint;
  }) {
    const { client, utxoRef, toScriptPubkey, bitcoinNetworkFee } = args;
    assertHexScriptPubkey(toScriptPubkey);
    return client.tx.bitcoinLocks.requestOrphanedUtxoRelease(utxoRef, toScriptPubkey, bitcoinNetworkFee);
  }

  public static createReleaseCosignTx(args: { client: ArgonClient; lockId: number; vaultSignatureHexes: string[] }) {
    const { client, lockId, vaultSignatureHexes } = args;
    return client.tx.bitcoinLocks.cosignRelease(lockId, vaultSignatureHexes);
  }

  public static createOrphanedReleaseCosignTx(args: {
    client: ArgonClient;
    ownerAccount: string;
    utxoRef: UtxoRefInput;
    vaultSignatureHex: string;
  }) {
    const { client, ownerAccount, utxoRef, vaultSignatureHex } = args;
    return client.tx.bitcoinLocks.cosignOrphanedUtxoRelease(ownerAccount, utxoRef, vaultSignatureHex);
  }

  public static createSetFlexibleTx(args: { client: ArgonClient; lockId: number; isFlexible: boolean }) {
    const { client, lockId, isFlexible } = args;
    return client.tx.bitcoinLocks.setFlexible(lockId, isFlexible);
  }

  public static createResecuritizeTx(args: {
    client: ArgonClient;
    lockId: number;
    securitizedSatoshis: bigint;
    microgonsAtTargetPerBtc: bigint;
    feeCoupon?: BitcoinLockFeeCoupon;
  }) {
    const { client, lockId, securitizedSatoshis, microgonsAtTargetPerBtc, feeCoupon } = args;
    return client.tx.bitcoinLocks.resecuritize(lockId, securitizedSatoshis, {
      microgonsAtTargetPerBtc,
      feeCoupon: feeCoupon ?? null,
    });
  }

  public static calculateResecuritizationFee(args: {
    vault: Pick<Vault, 'terms'>;
    currentCoverageMicrogons: bigint;
    replacementCoverageMicrogons: bigint;
    createdAtBitcoinHeight: number;
    vaultClaimBitcoinHeight: number;
    currentBitcoinHeight: number;
  }): bigint {
    const {
      vault,
      currentCoverageMicrogons,
      replacementCoverageMicrogons,
      createdAtBitcoinHeight,
      vaultClaimBitcoinHeight,
      currentBitcoinHeight,
    } = args;
    const additionalCoverageMicrogons =
      replacementCoverageMicrogons > currentCoverageMicrogons
        ? replacementCoverageMicrogons - currentCoverageMicrogons
        : 0n;
    if (additionalCoverageMicrogons === 0n) return 0n;

    const fullTerm = Math.max(vaultClaimBitcoinHeight - createdAtBitcoinHeight, 1);
    const elapsedBlocks = Math.max(currentBitcoinHeight - createdAtBitcoinHeight, 0);
    const remainingBlocks = Math.max(fullTerm - elapsedBlocks, 0);
    const remainingTerm = new BigNumber(remainingBlocks).div(fullTerm);
    const variableFee = vault.terms.bitcoinAnnualPercentRate
      .multipliedBy(remainingTerm)
      .multipliedBy(additionalCoverageMicrogons.toString())
      .integerValue(BigNumber.ROUND_DOWN);
    return BigInt(variableFee.toFixed(0)) + vault.terms.bitcoinBaseFee;
  }

  public static async getConfig(client: IQueryableClient): Promise<IBitcoinLockConfig> {
    const bitcoinNetwork = await client.query.bitcoinUtxos.bitcoinNetwork();
    return {
      lockReleaseCosignDeadlineFrames: client.consts.bitcoinLocks.lockReleaseCosignDeadlineFrames.toNumber(),
      securitizationHoldBlocks: client.consts.bitcoinLocks.securitizationHoldBlocks.toNumber(),
      tickDurationMillis: await client.query.ticks.genesisTicker().then(x => x.tickDurationMillis),
      bitcoinNetwork,
    };
  }

  public static async createInitializeTx(
    args: {
      client: ArgonClient;
      vault: Vault;
      priceIndex: PriceIndex;
      ownerBitcoinPubkey: Uint8Array;
      satoshis: bigint;
      txSigner: TxSigningAccount;
      tip?: bigint;
    } & BitcoinLockInitializationTerms,
  ) {
    const {
      vault,
      priceIndex,
      txSigner,
      satoshis,
      tip = 0n,
      ownerBitcoinPubkey,
      client,
      microgonsAtTargetPerBtc,
      feeCoupon,
    } = args;
    if (ownerBitcoinPubkey.length !== 33) {
      throw new Error(
        `Invalid Bitcoin key length: ${ownerBitcoinPubkey.length}. Must be a compressed pubkey (33 bytes).`,
      );
    }
    if (feeCoupon && microgonsAtTargetPerBtc === undefined) {
      throw new Error('microgonsAtTargetPerBtc is required when feeCoupon is provided');
    }

    const options =
      microgonsAtTargetPerBtc === undefined
        ? null
        : {
            microgonsAtTargetPerBtc,
            feeCoupon: feeCoupon ?? null,
          };
    const tx = client.tx.bitcoinLocks.createReceiveAddress(vault.vaultId, satoshis, ownerBitcoinPubkey, options);
    const submitter = new TxSubmitter(client, tx, txSigner);
    const isVaultOwner = txSigner.address === vault.operatorAccountId;
    let securityFee = 0n;
    if (!isVaultOwner) {
      const unlockAmount = this.calculateLiquidityPromised({ priceIndex, satoshis, microgonsAtTargetPerBtc });
      const fullSecurityFee = vault.calculateBitcoinFee(unlockAmount);
      securityFee = fullSecurityFee - (feeCoupon?.feeDiscount ?? 0n);
      if (securityFee < 0n) {
        securityFee = 0n;
      }
    }

    const { canAfford, availableBalance, txFee } = await submitter.canAfford({
      tip,
      unavailableBalance: securityFee,
      includeExistentialDeposit: true,
    });
    return {
      tx,
      securityFee,
      canAfford,
      availableBalance,
      txFeePlusTip: txFee + tip,
    };
  }

  public static async getBitcoinLockFromTxResult(
    client: IQueryableClient,
    txResult: TxResult,
  ): Promise<{
    lock: BitcoinLock;
    createdAtHeight: number;
  }> {
    await txResult.waitForFinalizedBlock;
    const blockHeight = txResult.blockNumber!;
    const lockId = (await this.getLockIdFromEvents(txResult.events)) ?? 0;
    if (lockId === 0) {
      throw new Error('Bitcoin lock creation failed, no lock ID found in transaction events');
    }
    const lock = await this.get(client, lockId);
    if (!lock) {
      throw new Error(`Lock with ID ${lockId} not found after initialization`);
    }
    return { lock, createdAtHeight: blockHeight };
  }

  public static calculateRedemptionAmountFromSatoshis(
    priceIndex: PriceIndex,
    satoshis: bigint,
    lockedTargetPrice?: bigint,
  ): bigint {
    const btcMicrogonsAtTarget = priceIndex.getSatoshiPriceInTargetMicrogons(satoshis);
    return this.calculateRedemptionAmount(priceIndex, btcMicrogonsAtTarget, lockedTargetPrice);
  }

  public static calculateLiquidityPromised(args: {
    priceIndex: PriceIndex;
    satoshis: bigint;
    microgonsAtTargetPerBtc?: bigint;
  }): bigint {
    const { priceIndex, satoshis, microgonsAtTargetPerBtc } = args;
    const btcValueInMicrogons =
      microgonsAtTargetPerBtc === undefined
        ? priceIndex.getSatoshiPriceInTargetMicrogons(satoshis)
        : (satoshis * microgonsAtTargetPerBtc) / SATS_PER_BTC;
    return this.calculateRedemptionAmount(priceIndex, btcValueInMicrogons);
  }

  public static calculateRedemptionAmount(
    priceIndex: PriceIndex,
    btcMicrogonsAtTarget: bigint,
    maxMicrogonsAtTarget?: bigint,
  ): bigint {
    let price = btcMicrogonsAtTarget;
    if (maxMicrogonsAtTarget !== undefined && maxMicrogonsAtTarget < btcMicrogonsAtTarget) {
      price = maxMicrogonsAtTarget;
    }

    const multiplierBn = this.redemptionMultiplierBn(priceIndex);
    return BigInt(new BigNumber(price.toString()).times(multiplierBn).integerValue(BigNumber.ROUND_DOWN).toFixed(0));
  }

  public static satoshisRequiredForRedemptionAmount(priceIndex: PriceIndex, redemptionAmount: bigint): bigint {
    if (redemptionAmount <= 0n) return 0n;

    const multiplierBn = this.redemptionMultiplierBn(priceIndex);
    const targetMicrogonsPerBtc = priceIndex.getSatoshiPriceInTargetMicrogons(SATS_PER_BTC);
    let requiredTargetMicrogons = BigInt(
      new BigNumber(redemptionAmount.toString()).div(multiplierBn).integerValue(BigNumber.ROUND_CEIL).toFixed(0),
    );

    while (this.calculateRedemptionAmount(priceIndex, requiredTargetMicrogons) < redemptionAmount) {
      requiredTargetMicrogons += 1n;
    }

    let satoshis = BigInt(
      new BigNumber(requiredTargetMicrogons.toString())
        .times(SATS_PER_BTC.toString())
        .div(targetMicrogonsPerBtc.toString())
        .integerValue(BigNumber.ROUND_CEIL)
        .toFixed(0),
    );

    while (this.calculateRedemptionAmountFromSatoshis(priceIndex, satoshis) < redemptionAmount) {
      satoshis += 1n;
    }
    while (satoshis > 0n && this.calculateRedemptionAmountFromSatoshis(priceIndex, satoshis - 1n) >= redemptionAmount) {
      satoshis -= 1n;
    }

    return satoshis;
  }

  private static async getLockIdFromEvents(events: RuntimeEvent[]) {
    for (const event of events) {
      if (event.section === 'bitcoinLocks' && event.method === 'BitcoinLockCreated') return event.data.lockId;
    }
    return undefined;
  }

  private static redemptionMultiplierBn(priceIndex: PriceIndex): BigNumber {
    const r = priceIndex.rValue;

    if (r.gte(1)) {
      return new BigNumber(1);
    } else if (r.gte(0.9)) {
      return new BigNumber(20).times(r.pow(2)).minus(new BigNumber(38).times(r)).plus(19);
    } else if (r.gte(0.01)) {
      return new BigNumber(0.5618).times(r).plus(0.3944).div(r);
    } else {
      return new BigNumber(1).div(r).times(new BigNumber(0.576).times(r).plus(0.4));
    }
  }

  private static fromRuntime(lockId: number, lock: NonNullable<BitcoinLocksLocksByIdResultSpec159>): BitcoinLock {
    const wscriptHash = lock.utxoScriptPubkey.value.wscriptHash.replace('0x', '');
    const [fingerprint, cosignHdIndex, claimHdIndex] = lock.vaultXpubSources;

    return new BitcoinLock({
      lockId,
      p2wshScriptHashHex: `0x0020${wscriptHash}`,
      vaultId: lock.vaultId,
      securitizedSatoshis: lock.securitizationBasis.satoshis,
      microgonsAtTargetPerBtc: lock.securitizationBasis.microgonsAtTargetPerBtc,
      securitizationCoverageMicrogons: lock.securitizationCoverageMicrogons,
      securitizationTick: lock.securitizationTick,
      fundedSatoshis: lock.fundedSatoshis,
      fundingUtxos: lock.fundingUtxos.map(([utxoRef, satoshis]) => ({
        utxoRef: { txid: utxoRef.txid, vout: utxoRef.outputIndex },
        satoshis,
      })),
      fissionedSatoshis: lock.fissionedSatoshis,
      ownerAccount: lock.ownerAccount,
      securitizationRatio: lock.securitizationRatio.toNumber(),
      securityFees: lock.securityFees,
      couponFeesPaid: lock.couponPaidFees,
      vaultPubkey: lock.vaultPubkey,
      vaultClaimPubkey: lock.vaultClaimPubkey,
      ownerPubkey: lock.ownerPubkey,
      vaultXpubSources: {
        parentFingerprint: hexToU8a(fingerprint),
        cosignHdIndex,
        claimHdIndex,
      },
      vaultClaimHeight: lock.vaultClaimHeight,
      openClaimHeight: lock.openClaimHeight,
      createdAtHeight: lock.createdAtHeight,
      securitizationHoldExpirationBitcoinHeight: lock.securitizationHoldExpirationBitcoinHeight,
      isFlexible: lock.isFlexible,
      fundHoldExtensionsByBitcoinExpirationHeight: Object.fromEntries(
        Object.entries(lock.fundHoldExtensions).map(([height, amount]) => [Number(height), amount]),
      ),
      createdAtArgonBlock: lock.createdAtArgonBlock,
    });
  }
}

export interface IBitcoinLockConfig {
  lockReleaseCosignDeadlineFrames: number;
  securitizationHoldBlocks: number;
  tickDurationMillis: number;
  bitcoinNetwork: BitcoinUtxosBitcoinNetworkResultSpec100;
}

export interface IReleaseRequest {
  toScriptPubkey: string;
  bitcoinNetworkFee: bigint;
}

export interface IReleaseRequestDetails extends IReleaseRequest {
  insuredMicrogons: bigint;
}

export interface IBitcoinLock {
  lockId: number;
  p2wshScriptHashHex: string;
  vaultId: number;
  securitizedSatoshis: bigint;
  microgonsAtTargetPerBtc: bigint;
  securitizationCoverageMicrogons: bigint;
  securitizationTick: number;
  fundedSatoshis: bigint;
  fundingUtxos: IBitcoinLockFundingUtxo[];
  fissionedSatoshis: bigint;
  ownerAccount: string;
  securitizationRatio: number;
  securityFees: bigint;
  couponFeesPaid: bigint;
  vaultPubkey: string;
  vaultClaimPubkey: string;
  ownerPubkey: string;
  vaultXpubSources: {
    parentFingerprint: Uint8Array;
    cosignHdIndex: number;
    claimHdIndex: number;
  };
  vaultClaimHeight: number;
  openClaimHeight: number;
  createdAtHeight: number;
  securitizationHoldExpirationBitcoinHeight: number;
  isFlexible: boolean;
  fundHoldExtensionsByBitcoinExpirationHeight: Record<number, bigint>;
  createdAtArgonBlock: number;
}

export type IBitcoinLockDetails = Pick<
  IBitcoinLock,
  | 'lockId'
  | 'p2wshScriptHashHex'
  | 'vaultId'
  | 'securitizedSatoshis'
  | 'fundedSatoshis'
  | 'fundingUtxos'
  | 'ownerAccount'
  | 'securitizationRatio'
  | 'securityFees'
  | 'couponFeesPaid'
  | 'vaultPubkey'
  | 'vaultClaimPubkey'
  | 'ownerPubkey'
  | 'vaultXpubSources'
  | 'vaultClaimHeight'
  | 'openClaimHeight'
  | 'createdAtHeight'
  | 'securitizationHoldExpirationBitcoinHeight'
  | 'isFlexible'
  | 'fundHoldExtensionsByBitcoinExpirationHeight'
  | 'createdAtArgonBlock'
>;

export interface IBitcoinLockFundingUtxo {
  utxoRef: { txid: string; vout: number };
  satoshis: bigint;
}

function assertHexScriptPubkey(toScriptPubkey: string): void {
  if (!toScriptPubkey.startsWith('0x')) {
    throw new Error('toScriptPubkey must be a hex string starting with 0x');
  }
}
