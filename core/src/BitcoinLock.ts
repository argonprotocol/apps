// Source: @argonprotocol/mainchain 1.4.12, the last release that exported this model.
import {
  type ArgonClient,
  type ArgonPrimitivesBitcoinBitcoinNetwork,
  FIXED_U128_DECIMALS,
  formatArgons,
  fromFixedNumber,
  type PalletBitcoinLocksLockedBitcoin,
  type PalletBitcoinLocksLockReleaseRequest,
  PriceIndex,
} from '@argonprotocol/mainchain';
import type { GenericEvent } from '@polkadot/types';
import type { SubmittableExtrinsic } from '@polkadot/api/promise/types';
import { TxSubmitter, type TxSigningAccount } from './TxSubmitter.js';
import { TxResult } from './TxResult.js';
import { u8aToHex } from '@polkadot/util';
import type { ApiDecoration } from '@polkadot/api/types';
import type { Vault } from './Vault.js';
import BigNumber from 'bignumber.js';
import type { RuntimeSpec157 } from './runtimeCompatibility.js';
import type { BitcoinLockFeeCoupon } from './interfaces/IBitcoinLockCoupon.js';

export const SATS_PER_BTC = 100_000_000n;

type IQueryableClient = ArgonClient | ApiDecoration<'promise'>;
type UtxoRefInput = { txid: string; outputIndex: number };
type RuntimeBitcoinLock = PalletBitcoinLocksLockedBitcoin | RuntimeSpec157.PalletBitcoinLocksLockedBitcoin;
type RuntimeReleaseRequest = PalletBitcoinLocksLockReleaseRequest | RuntimeSpec157.PalletBitcoinLocksLockReleaseRequest;

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
  public utxoId: number;
  public p2wshScriptHashHex: string;
  public vaultId: number;
  public lockedTargetPrice: bigint;
  public liquidityPromised: bigint;
  public ownerAccount: string;
  public securitizationRatio: number;
  public satoshis: bigint;
  public utxoSatoshis?: bigint;
  public vaultPubkey: string;
  public securityFees: bigint;
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
  public isFunded: boolean;
  public isFlexible: boolean;
  public createdAtArgonBlock: number;
  public fundHoldExtensionsByBitcoinExpirationHeight: Record<number, bigint>;
  public couponFeesPaid: bigint;

  constructor(data: IBitcoinLock) {
    this.utxoId = data.utxoId;
    this.p2wshScriptHashHex = data.p2wshScriptHashHex;
    this.vaultId = data.vaultId;
    this.lockedTargetPrice = data.lockedTargetPrice;
    this.liquidityPromised = data.liquidityPromised;
    this.ownerAccount = data.ownerAccount;
    this.securitizationRatio = data.securitizationRatio;
    this.satoshis = data.satoshis;
    this.utxoSatoshis = data.utxoSatoshis;
    this.vaultPubkey = data.vaultPubkey;
    this.securityFees = data.securityFees;
    this.vaultClaimPubkey = data.vaultClaimPubkey;
    this.ownerPubkey = data.ownerPubkey;
    this.vaultXpubSources = data.vaultXpubSources;
    this.vaultClaimHeight = data.vaultClaimHeight;
    this.openClaimHeight = data.openClaimHeight;
    this.createdAtHeight = data.createdAtHeight;
    this.isFunded = data.isFunded;
    this.isFlexible = data.isFlexible ?? false;
    this.fundHoldExtensionsByBitcoinExpirationHeight = data.fundHoldExtensionsByBitcoinExpirationHeight;
    this.createdAtArgonBlock = data.createdAtArgonBlock;
    this.couponFeesPaid = data.couponFeesPaid ?? 0n;
  }

  /**
   * Gets the UTXO reference by ID.
   * @param client - client at the block height to query the UTXO reference at a specific point in time.
   * @return An object containing the transaction ID and output index, or undefined if not found.
   * @return.txid - The Bitcoin transaction ID of the UTXO.
   * @return.vout - The output index of the UTXO in the transaction.
   */
  public async getFundingUtxoRef(client: IQueryableClient): Promise<{ txid: string; vout: number } | undefined> {
    const refRaw = await client.query.bitcoinUtxos.utxoIdToFundingUtxoRef(this.utxoId);
    if (refRaw.isNone) {
      return;
    }
    const ref = refRaw.unwrap();

    const txid = u8aToHex(ref.txid);
    const vout = ref.outputIndex.toNumber();
    return { txid, vout };
  }

  public async findPendingMints(client: IQueryableClient): Promise<bigint[]> {
    const mintsPending: bigint[] = [];
    const pendingMintIndices = await client.query.mint.pendingMintUtxoIdLookup(this.utxoId);

    for (const pendingMintIndex of pendingMintIndices) {
      const pendingMint = await client.query.mint.pendingMintUtxosByIndex(pendingMintIndex);
      if (pendingMint.isSome) {
        mintsPending.push(pendingMint.unwrap().remainingAmount.toBigInt());
      }
    }
    return mintsPending;
  }

  public async calculateRatchetingCosts(
    client: IQueryableClient,
    priceIndex: PriceIndex,
    vault: Vault,
    microgonsAtTargetPerBtc: bigint,
  ): Promise<{ burnAmount: bigint; ratchetingFee: bigint }> {
    const { createdAtHeight, vaultClaimHeight, lockedTargetPrice, satoshis } = this;
    const currentTargetPrice = (microgonsAtTargetPerBtc * satoshis) / SATS_PER_BTC;

    let ratchetingFee = vault.terms.bitcoinBaseFee;
    let burnAmount = 0n;

    // ratchet up
    if (currentTargetPrice > lockedTargetPrice) {
      const diffTargetAmount = currentTargetPrice - lockedTargetPrice;
      const amountToMint = BitcoinLock.calculateRedemptionAmount(priceIndex, diffTargetAmount);
      const bitcoinFee = vault.calculateBitcoinFee(amountToMint);
      const percentageFee = bitcoinFee - vault.terms.bitcoinBaseFee;

      const currentBitcoinHeight = await client.query.bitcoinUtxos
        .confirmedBitcoinBlockTip()
        .then(tip => (tip.isSome ? tip.unwrap().blockHeight.toNumber() : 0));
      const fullTerm = Math.max(1, vaultClaimHeight - createdAtHeight);
      const elapsedBlocks = Math.max(0, currentBitcoinHeight - createdAtHeight);
      const cappedRemainingBlocks = Math.max(0, fullTerm - elapsedBlocks);
      const proratedFee = (percentageFee * BigInt(cappedRemainingBlocks)) / BigInt(fullTerm);
      ratchetingFee = vault.terms.bitcoinBaseFee + proratedFee;
    } else {
      burnAmount = BitcoinLock.calculateRedemptionAmount(priceIndex, currentTargetPrice);
    }

    return {
      ratchetingFee,
      burnAmount,
    };
  }

  public calculateRedemptionAmount(priceIndex: PriceIndex): bigint {
    return BitcoinLock.calculateRedemptionAmountFromSatoshis(priceIndex, this.satoshis, this.lockedTargetPrice);
  }

  public async requestRelease(args: {
    client: ArgonClient;
    priceIndex: PriceIndex;
    releaseRequest: IReleaseRequest;
    txSigner: TxSigningAccount;
    disableAutomaticTxTracking: boolean;
  }): Promise<TxResult> {
    const {
      priceIndex,
      releaseRequest: { bitcoinNetworkFee, toScriptPubkey },
      txSigner,
      disableAutomaticTxTracking,
      client,
    } = args;

    if (!toScriptPubkey.startsWith('0x')) {
      throw new Error('toScriptPubkey must be a hex string starting with 0x');
    }

    const submitter = new TxSubmitter(
      client,
      client.tx.bitcoinLocks.requestRelease(this.utxoId, toScriptPubkey, bitcoinNetworkFee),
      txSigner,
    );

    const redemptionAmount = this.calculateRedemptionAmount(priceIndex);

    const canAfford = await submitter.canAfford({
      unavailableBalance: redemptionAmount,
    });

    if (!canAfford.canAfford) {
      throw new Error(
        `Insufficient funds to release lock. Available: ${formatArgons(canAfford.availableBalance)}, Required: ${formatArgons(redemptionAmount + canAfford.txFee)}`,
      );
    }
    return submitter.submit({
      logResults: true,
      disableAutomaticTxTracking,
    });
  }

  public async getReleaseRequest(client: IQueryableClient): Promise<IReleaseRequestDetails | undefined> {
    const requestMaybe = await client.query.bitcoinLocks.lockReleaseRequestsByUtxoId(this.utxoId);
    if (!requestMaybe.isSome) {
      return undefined;
    }
    const request = requestMaybe.unwrap() as RuntimeReleaseRequest;
    return {
      toScriptPubkey: request.toScriptPubkey.toHex(),
      bitcoinNetworkFee: request.bitcoinNetworkFee.toBigInt(),
      redemptionAmount: request.redemptionAmount.toBigInt(),
    };
  }

  /**
   * Finds the finalized cosign signature for a vault lock by UTXO ID.
   * @param client - The Argon client with rpc access
   */
  public async findVaultCosignSignature(
    client: ArgonClient,
  ): Promise<{ blockHeight: number; signature: Uint8Array } | undefined> {
    const finalizedHead = await client.rpc.chain.getFinalizedHead();
    const queryClient = await client.at(finalizedHead);
    const releaseHeight = await queryClient.query.bitcoinLocks.lockReleaseCosignHeightById(this.utxoId);
    if (releaseHeight.isSome) {
      const releaseHeightValue = releaseHeight.unwrap().toNumber();
      const signature = await this.getVaultCosignSignature(client, releaseHeightValue);
      if (signature) {
        return { blockHeight: releaseHeightValue, signature };
      }
    }
    return undefined;
  }

  private async getVaultCosignSignature(client: ArgonClient, atHeight: number): Promise<Uint8Array | undefined> {
    const blockHash = await client.rpc.chain.getBlockHash(atHeight);
    const blockEvents = await client.at(blockHash).then(api => api.query.system.events());
    for (const event of blockEvents) {
      if (client.events.bitcoinLocks.BitcoinUtxoCosigned.is(event.event)) {
        const { utxoId: id, signature } = event.event.data;
        if (id.toNumber() === this.utxoId) {
          return new Uint8Array(signature);
        }
      }
    }
    return undefined;
  }

  private static async getUtxoIdFromEvents(client: IQueryableClient, events: GenericEvent[]) {
    for (const event of events) {
      if (client.events.bitcoinLocks.BitcoinLockCreated.is(event)) {
        return event.data.utxoId.toNumber();
      }
    }
    return undefined;
  }

  public static calculateRedemptionAmountFromSatoshis(
    priceIndex: PriceIndex,
    satoshis: bigint,
    lockedTargetPrice?: bigint,
  ): bigint {
    const btcMicrogonsAtTarget = priceIndex.getSatoshiPriceInTargetMicrogons(satoshis);
    return this.calculateRedemptionAmount(priceIndex, btcMicrogonsAtTarget, lockedTargetPrice);
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

  private static redemptionMultiplierBn(priceIndex: PriceIndex): BigNumber {
    const r = priceIndex.rValue;

    if (r.gte(1)) {
      // Case 1: no penalty
      return new BigNumber(1);
    } else if (r.gte(0.9)) {
      // Case 2: quadratic curve
      // Formula: 20r² - 38r + 19
      return new BigNumber(20).times(r.pow(2)).minus(new BigNumber(38).times(r)).plus(19);
    } else if (r.gte(0.01)) {
      // Case 3: rational linear formula
      // Formula: (0.5618r + 0.3944) / r
      return new BigNumber(0.5618).times(r).plus(0.3944).div(r);
    } else {
      // Case 4: extreme deviation
      // Formula: (1 / r) * (0.576r + 0.4)
      return new BigNumber(1).div(r).times(new BigNumber(0.576).times(r).plus(0.4));
    }
  }

  public static async getConfig(client: IQueryableClient): Promise<IBitcoinLockConfig> {
    const bitcoinNetwork = await client.query.bitcoinUtxos.bitcoinNetwork();
    return {
      lockReleaseCosignDeadlineFrames: client.consts.bitcoinLocks.lockReleaseCosignDeadlineFrames.toNumber(),
      pendingConfirmationExpirationBlocks: client.consts.bitcoinUtxos.maxPendingConfirmationBlocks.toNumber(),
      tickDurationMillis: await client.query.ticks.genesisTicker().then(x => x.tickDurationMillis.toNumber()),
      bitcoinNetwork,
      lockSatoshiAllowedVariance: client.consts.bitcoinUtxos.maximumSatoshiThresholdFromExpected?.toNumber() ?? 10_000,
    };
  }

  public static async createIncreaseSecuritizationTx(args: {
    utxoId: number;
    client: ArgonClient;
    newSatoshis: bigint;
  }): Promise<SubmittableExtrinsic | undefined> {
    const { client, newSatoshis, utxoId } = args;
    const txBuilder = client.tx.bitcoinLocks.increaseSecuritization;
    if (!txBuilder?.meta) {
      return undefined;
    }
    return txBuilder(utxoId, newSatoshis);
  }

  public static async createFundWithUtxoCandidateTx(args: {
    client: ArgonClient;
    utxoId: number;
    utxoRef: UtxoRefInput;
  }): Promise<SubmittableExtrinsic | undefined> {
    const { client, utxoId, utxoRef } = args;
    const txBuilder = client.tx.bitcoinUtxos?.fundWithUtxoCandidate;
    if (!txBuilder?.meta) {
      return undefined;
    }
    return txBuilder(utxoId, utxoRef);
  }

  public static async createOrphanedUtxoReleaseRequestTx(args: {
    client: ArgonClient;
    utxoRef: UtxoRefInput;
    releaseRequest: IReleaseRequest;
  }): Promise<SubmittableExtrinsic | undefined> {
    const {
      client,
      utxoRef,
      releaseRequest: { bitcoinNetworkFee, toScriptPubkey },
    } = args;

    if (!toScriptPubkey.startsWith('0x')) {
      throw new Error('toScriptPubkey must be a hex string starting with 0x');
    }

    const txBuilder = client.tx.bitcoinLocks.requestOrphanedUtxoRelease;
    if (!txBuilder?.meta) {
      return undefined;
    }

    return txBuilder(utxoRef, toScriptPubkey, bitcoinNetworkFee);
  }

  public static async createOrphanedUtxoCosignTx(args: {
    client: ArgonClient;
    orphanOwner: string;
    utxoRef: UtxoRefInput;
    vaultSignature: Uint8Array;
  }): Promise<SubmittableExtrinsic | undefined> {
    const { client, orphanOwner, utxoRef, vaultSignature } = args;
    if (!vaultSignature || vaultSignature.byteLength < 70 || vaultSignature.byteLength > 73) {
      throw new Error(`Invalid vault signature length: ${vaultSignature.byteLength}. Must be 70-73 bytes.`);
    }
    if (!client.tx.bitcoinLocks.cosignOrphanedUtxoRelease?.meta) {
      return undefined;
    }
    const signature = u8aToHex(vaultSignature);
    return client.tx.bitcoinLocks.cosignOrphanedUtxoRelease(orphanOwner, utxoRef, signature);
  }

  public static async get(client: IQueryableClient, utxoId: number): Promise<BitcoinLock | undefined> {
    const utxoRaw = await client.query.bitcoinLocks.locksByUtxoId(utxoId);
    if (!utxoRaw.isSome) {
      return;
    }
    const utxo = utxoRaw.unwrap() as RuntimeBitcoinLock;
    const p2shBytesPrefix = '0020';
    const wscriptHash = utxo.utxoScriptPubkey.asP2wsh.wscriptHash.toHex().replace('0x', '');
    const p2wshScriptHashHex = `0x${p2shBytesPrefix}${wscriptHash}`;
    const vaultId = utxo.vaultId.toNumber();
    const lockedTargetPrice = utxo.lockedTargetPrice.toBigInt();
    const liquidityPromised = utxo.liquidityPromised.toBigInt();
    const ownerAccount = utxo.ownerAccount.toHuman();
    const securitizationRatio = fromFixedNumber(utxo.securitizationRatio.toBigInt(), FIXED_U128_DECIMALS).toNumber();
    const satoshis = utxo.satoshis.toBigInt();
    const utxoSatoshis = utxo.utxoSatoshis?.isSome ? utxo.utxoSatoshis.value.toBigInt() : undefined;
    const vaultPubkey = utxo.vaultPubkey.toHex();
    const vaultClaimPubkey = utxo.vaultClaimPubkey.toHex();
    const ownerPubkey = utxo.ownerPubkey.toHex();
    const [fingerprint, cosign_hd_index, claim_hd_index] = utxo.vaultXpubSources;
    const vaultXpubSources = {
      parentFingerprint: new Uint8Array(fingerprint),
      cosignHdIndex: cosign_hd_index.toNumber(),
      claimHdIndex: claim_hd_index.toNumber(),
    };

    const createdAtArgonBlock = utxo.createdAtArgonBlock.toNumber();
    const securityFees = utxo.securityFees.toBigInt();
    const vaultClaimHeight = utxo.vaultClaimHeight.toNumber();
    const openClaimHeight = utxo.openClaimHeight.toNumber();
    const createdAtHeight = utxo.createdAtHeight.toNumber();
    const isFunded = utxo.isFunded.toJSON();
    const isFlexible = 'isFlexible' in utxo ? utxo.isFlexible.toJSON() : utxo.isBackfill.toJSON();
    const fundHoldExtensionsByBitcoinExpirationHeight = Object.fromEntries(
      [...utxo.fundHoldExtensions.entries()].map(([x, y]) => [x.toNumber(), y.toBigInt()]),
    );
    const couponFeesPaid = utxo.couponPaidFees.toBigInt();

    return new BitcoinLock({
      utxoId,
      p2wshScriptHashHex,
      vaultId,
      lockedTargetPrice,
      liquidityPromised,
      ownerAccount,
      securitizationRatio,
      satoshis,
      utxoSatoshis,
      vaultPubkey,
      vaultClaimPubkey,
      ownerPubkey,
      vaultXpubSources,
      vaultClaimHeight,
      openClaimHeight,
      createdAtHeight,
      securityFees,
      isFunded,
      isFlexible,
      couponFeesPaid,
      fundHoldExtensionsByBitcoinExpirationHeight,
      createdAtArgonBlock,
    });
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
    const requestedTargetPrice = microgonsAtTargetPerBtc ?? null;
    if (ownerBitcoinPubkey.length !== 33) {
      throw new Error(
        `Invalid Bitcoin key length: ${ownerBitcoinPubkey.length}. Must be a compressed pubkey (33 bytes).`,
      );
    }
    if (feeCoupon && microgonsAtTargetPerBtc === undefined) {
      throw new Error('microgonsAtTargetPerBtc is required when feeCoupon is provided');
    }

    const bitcoinLocks = client.tx.bitcoinLocks as
      | ArgonClient['tx']['bitcoinLocks']
      | RuntimeSpec157.Transactions<'promise'>['bitcoinLocks'];

    let tx: SubmittableExtrinsic;
    if ('initializeFor' in bitcoinLocks) {
      if (feeCoupon) {
        throw new Error('The connected runtime does not support Bitcoin lock fee coupons');
      }
      tx = bitcoinLocks.initialize(vault.vaultId, satoshis, ownerBitcoinPubkey, {
        V1: { microgonsAtTargetPerBtc: requestedTargetPrice },
      });
    } else {
      const options = feeCoupon
        ? {
            V2: {
              microgonsAtTargetPerBtc,
              feeCoupon,
            },
          }
        : {
            V1: {
              microgonsAtTargetPerBtc: requestedTargetPrice,
            },
          };
      tx = bitcoinLocks.initialize(vault.vaultId, satoshis, ownerBitcoinPubkey, options);
    }
    const submitter = new TxSubmitter(client, tx, txSigner);
    const isVaultOwner = txSigner.address === vault.operatorAccountId;
    let securityFee = 0n;
    if (!isVaultOwner) {
      const targetPrice =
        requestedTargetPrice !== null
          ? (requestedTargetPrice * satoshis) / SATS_PER_BTC
          : priceIndex.getSatoshiPriceInTargetMicrogons(satoshis);
      const unlockAmount = this.calculateRedemptionAmount(priceIndex, targetPrice);
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
    const utxoId = (await this.getUtxoIdFromEvents(client, txResult.events)) ?? 0;
    if (utxoId === 0) {
      throw new Error('Bitcoin lock creation failed, no UTXO ID found in transaction events');
    }
    const lock = await this.get(client, utxoId);
    if (!lock) {
      throw new Error(`Lock with ID ${utxoId} not found after initialization`);
    }
    return { lock, createdAtHeight: blockHeight };
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

    // The forward path floors target microgons from sats, then floors the redemption amount.
    // Verify the computed sats satisfy both boundaries, then step down to the minimal sat count.
    while (this.calculateRedemptionAmountFromSatoshis(priceIndex, satoshis) < redemptionAmount) {
      satoshis += 1n;
    }
    while (satoshis > 0n && this.calculateRedemptionAmountFromSatoshis(priceIndex, satoshis - 1n) >= redemptionAmount) {
      satoshis -= 1n;
    }

    return satoshis;
  }
}

export interface IBitcoinLockConfig {
  lockReleaseCosignDeadlineFrames: number;
  pendingConfirmationExpirationBlocks: number;
  tickDurationMillis: number;
  bitcoinNetwork: ArgonPrimitivesBitcoinBitcoinNetwork;
  lockSatoshiAllowedVariance: number;
}
export interface IReleaseRequest {
  toScriptPubkey: string;
  bitcoinNetworkFee: bigint;
}

export interface IReleaseRequestDetails extends IReleaseRequest {
  redemptionAmount: bigint;
}

export interface IBitcoinLock {
  utxoId: number;
  p2wshScriptHashHex: string;
  vaultId: number;
  lockedTargetPrice: bigint;
  liquidityPromised: bigint;
  ownerAccount: string;
  securitizationRatio: number;
  satoshis: bigint;
  utxoSatoshis?: bigint;
  vaultPubkey: string;
  securityFees: bigint;
  couponFeesPaid: bigint;
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
  isFunded: boolean;
  isFlexible: boolean;
  createdAtArgonBlock: number;
  fundHoldExtensionsByBitcoinExpirationHeight: Record<number, bigint>;
}
