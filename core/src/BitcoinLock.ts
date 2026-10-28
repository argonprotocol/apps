import { PriceIndex } from '@argonprotocol/mainchain';
import type {
  CurrentRuntimeQueries,
  LiveQueryRecord,
  RuntimeQueryResult,
  BitcoinUtxosBitcoinNetworkResultSpec100,
} from '@argonprotocol/runtime-client';
import type { HistoricalEvent } from '@argonprotocol/runtime-client/events';
import { toRuntimeEvent } from '@argonprotocol/runtime-client';
import { hexToU8a, u8aToHex } from '@polkadot/util';
import BigNumber from 'bignumber.js';
import type { BlockWatch, IBlockHeaderInfo } from './BlockWatch.js';
import type { BitcoinLockFeeCoupon } from './interfaces/IBitcoinLockCoupon.js';
import type { ArgonClient, ArgonCurrentQueryClient, ArgonQueryClient } from './MainchainClients.js';
import { TxResult, type RuntimeEvent } from './TxResult.js';
import { TxSubmitter, type TxSigningAccount } from './TxSubmitter.js';
import { bigIntMin, bigIntMax, bigNumberToBigInt } from './utils.js';
import { Vault } from './Vault.js';
import type { BitcoinFission, IBitcoinFission } from './BitcoinFission.js';
import type { PreviousRuntimeSpec } from './runtimeCompatibility.js';

export const SATS_PER_BTC = 100_000_000n;

const FixedU128BigNumber = BigNumber.clone({
  DECIMAL_PLACES: 18,
  ROUNDING_MODE: BigNumber.ROUND_HALF_DOWN,
});

export type BitcoinCosignerGuarantee = NonNullable<
  RuntimeQueryResult<CurrentRuntimeQueries['bitcoinLocks']['locksById']>
>['cosignerGuarantee'];

export interface IBitcoinGuaranteeQuote {
  satoshis: bigint;
  microgonsAtTargetPerBtc: bigint;
  currentCoverageMicrogons: bigint;
  replacementCoverageMicrogons: bigint;
  totalSecurityFee: bigint;
}

export interface IBitcoinFissionCreationQuote {
  fission: Pick<IBitcoinFission, 'satoshis' | 'microgonsAtTargetPerBtc' | 'liquidityPromised'>;
  maximumSatoshis: bigint;
  projectedVault: Vault;
  lockGuarantee?: IBitcoinGuaranteeQuote;
  fissionGuarantee?: IBitcoinGuaranteeQuote;
}
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
  public securitizationCollateralMicrogons?: bigint;
  public securitizationTick: number;
  public fundedSatoshis: bigint;
  public fundingUtxos: IBitcoinLockFundingUtxo[];
  public fissionedSatoshis: bigint;
  public ownerAccount: string;
  public securitizationRatio?: number;
  public readonly cosignerGuarantee?: BitcoinCosignerGuarantee;
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
  public securitizationHoldExpirationBitcoinHeight: number | null;
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
    this.securitizationCollateralMicrogons = data.securitizationCollateralMicrogons;
    this.securitizationTick = data.securitizationTick;
    this.fundedSatoshis = data.fundedSatoshis;
    this.fundingUtxos = data.fundingUtxos;
    this.fissionedSatoshis = data.fissionedSatoshis;
    this.ownerAccount = data.ownerAccount;
    this.securitizationRatio = data.securitizationRatio;
    this.cosignerGuarantee = data.cosignerGuarantee;
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

  public static async get(client: ArgonCurrentQueryClient, lockId: number): Promise<BitcoinLock | undefined> {
    const lock = await client.query.bitcoinLocks.locksById(lockId);
    if (!lock) return;

    return BitcoinLock.fromRuntime(lockId, lock);
  }

  public static async getMany(
    client: ArgonCurrentQueryClient,
    lockIds: number[],
  ): Promise<(BitcoinLock | undefined)[]> {
    const locks = await client.query.bitcoinLocks.locksById.multi(lockIds);
    return (locks ?? []).map((lock, index) => {
      if (!lock) return;
      return BitcoinLock.fromRuntime(lockIds[index], lock);
    });
  }

  public static quoteFissionCreation(args: {
    lockId: number;
    lock: NonNullable<LiveQueryRecord<'bitcoinLocks', 'locksById'>>;
    satoshis: bigint;
    vault: Vault;
    priceIndex: PriceIndex;
    microgonsAtTargetPerBtc: bigint;
    eligibleRates: NonNullable<LiveQueryRecord<'bitcoinLocks', 'microgonPerBtcHistory'>>;
    lockFissions: readonly BitcoinFission[];
    currentBitcoinHeight: number;
  }): IBitcoinFissionCreationQuote | { error: string; maximumSatoshis?: bigint } {
    const { lockId, lock: runtimeLock, ...quoteArgs } = args;
    const lock = BitcoinLock.fromRuntime(lockId, runtimeLock);
    if (!('cosignerGuarantee' in runtimeLock)) return lock.quoteFissionWithLockGuarantee(quoteArgs, runtimeLock);

    const { satoshis: requestedSatoshis, vault, priceIndex, microgonsAtTargetPerBtc, currentBitcoinHeight } = quoteArgs;
    const availableCollateral = vault.availableSecuritizationSpace(lock.ownerAccount, lock.isFlexible);
    const availableSatoshis = bigIntMax(lock.fundedSatoshis - lock.fissionedSatoshis, 0n);
    const fitsVaultCapacity = (amount: bigint) => {
      const coverage = BitcoinLock.calculateLiquidityPromised({
        priceIndex,
        satoshis: amount,
        microgonsAtTargetPerBtc,
      });
      return coverage <= lock.transferredFissionCoverage(amount) + availableCollateral;
    };
    let maximumSatoshis = BitcoinLock.maximumSatoshisWithinVaultCapacity(availableSatoshis, fitsVaultCapacity);
    let satoshis = bigIntMin(requestedSatoshis, availableSatoshis);
    if (fitsVaultCapacity(satoshis)) {
      // Integer rounding can leave affordable amounts beyond the searched limit.
      maximumSatoshis = bigIntMax(maximumSatoshis, satoshis);
    } else if (satoshis > maximumSatoshis) {
      satoshis = maximumSatoshis;
    }

    const liquidityPromised = BitcoinLock.calculateLiquidityPromised({ priceIndex, satoshis, microgonsAtTargetPerBtc });
    const currentCoverageMicrogons = lock.transferredFissionCoverage(satoshis);
    const additionalCollateral = bigIntMax(liquidityPromised - currentCoverageMicrogons, 0n);
    if (additionalCollateral > availableCollateral) {
      return {
        error:
          'This amount needs more securitization than is available. Choose Max to use the existing Bitcoin guarantee.',
        maximumSatoshis,
      };
    }
    const projectedVault = Object.assign(Object.create(Vault.prototype) as Vault, vault);
    projectedVault.securitizationLocked += additionalCollateral;
    if (lock.isFlexible) projectedVault.flexibleSecuritizationLocked += additionalCollateral;

    return {
      fission: { satoshis, microgonsAtTargetPerBtc, liquidityPromised },
      maximumSatoshis,
      projectedVault,
      fissionGuarantee: {
        satoshis,
        microgonsAtTargetPerBtc,
        currentCoverageMicrogons,
        replacementCoverageMicrogons: liquidityPromised,
        totalSecurityFee: BitcoinLock.calculateResecuritizationFee({
          vault,
          currentCoverageMicrogons,
          replacementCoverageMicrogons: liquidityPromised,
          currentBitcoinHeight,
          createdAtBitcoinHeight: lock.createdAtHeight,
          vaultClaimBitcoinHeight: lock.vaultClaimHeight,
        }),
      },
    };
  }

  public static calculateResecuritizationCapacity(args: {
    lockId: number;
    lock: NonNullable<LiveQueryRecord<'bitcoinLocks', 'locksById'>>;
    vault: Vault;
    securitizedSatoshis: bigint;
    replacementCoverageMicrogons: bigint;
  }) {
    const { lockId, lock: runtimeLock, vault, securitizedSatoshis, replacementCoverageMicrogons } = args;
    const lock = BitcoinLock.fromRuntime(lockId, runtimeLock);
    const projectedVault = Object.assign(Object.create(Vault.prototype) as Vault, vault);
    projectedVault.securitizationLocked -= lock.securitizationCollateralMicrogons!;
    if (lock.isFlexible) {
      projectedVault.flexibleSecuritizationLocked -= BitcoinLock.collateralForCoverage(
        runtimeLock,
        lock.securitizationCoverageMicrogons,
      );
    }

    const availableCollateral = projectedVault.availableSecuritizationSpace(lock.ownerAccount, lock.isFlexible);
    const replacementCollateral = BitcoinLock.collateralForCoverage(runtimeLock, replacementCoverageMicrogons);
    const canAfford = replacementCollateral <= availableCollateral;
    projectedVault.securitizationLocked += replacementCollateral;
    if (lock.isFlexible) {
      const fundedCoverage = BitcoinLock.calculateSharedGuaranteeCoverage({
        fundedSatoshis: lock.fundedSatoshis,
        basisSatoshis: securitizedSatoshis,
        coverageMicrogons: replacementCoverageMicrogons,
      });
      projectedVault.flexibleSecuritizationLocked += BitcoinLock.collateralForCoverage(runtimeLock, fundedCoverage);
    }
    return { canAfford, projectedVault };
  }

  public static readLockGuaranteePayment(events: readonly HistoricalEvent[], lockId: number, ownerAccount: string) {
    let completion: HistoricalEvent | undefined;
    let netSecurityFee = 0n;
    for (const [eventIndex, event] of events.entries()) {
      if (event.section !== 'bitcoinLocks') continue;
      if (
        event.method !== 'BitcoinLockCreated' &&
        event.method !== 'BitcoinLockResecuritized' &&
        event.method !== 'BitcoinLockGuaranteeSet'
      )
        continue;
      if (event.data.lockId !== lockId) continue;

      completion = event;
      netSecurityFee += readBitcoinGuaranteeFee(events, eventIndex, ownerAccount);
    }
    if (!completion) return;
    if (completion.method === 'BitcoinLockGuaranteeSet') {
      return { netSecurityFee, securitizedSatoshis: completion.data.securitizationBasis.satoshis };
    }
    return { netSecurityFee };
  }

  public static async idsByOwner(client: ArgonQueryClient, ownerAccount: string): Promise<number[]> {
    const keys = await client.query.bitcoinLocks.lockIdsByOwnerAccount.keys(ownerAccount);
    return [...new Set((keys ?? []).map(key => key.args[1]))];
  }

  public static async getFundingUtxoRefs(
    client: ArgonQueryClient,
    lockId: number,
  ): Promise<{ txid: string; vout: number }[]> {
    const refs = await client.query.bitcoinUtxos.utxoRefsByLockId(lockId);
    return (refs ?? []).map(ref => ({ txid: ref.txid, vout: ref.outputIndex }));
  }

  public static async getReleaseRequest(
    client: ArgonQueryClient,
    lockId: number,
  ): Promise<IReleaseRequestDetails | undefined> {
    const request = await client.query.bitcoinLocks.lockReleaseRequestsById(lockId);
    if (!request) return;

    return {
      ...request,
      toScriptPubkey: u8aToHex(request.toScriptPubkey),
    };
  }

  public static async findVaultCosignatures(
    blockWatch: BlockWatch,
    lockId: number,
    releaseNumber: number,
  ): Promise<{ blockHeight: number; signatures: Uint8Array[] } | undefined> {
    const finalizedClient = await blockWatch.getFinalizedApi();
    let releaseHeight = await finalizedClient.query.bitcoinLocks.lockReleaseCosignHeightById(lockId);
    if (releaseHeight === null) return;
    let releaseBlock: IBlockHeaderInfo | undefined;

    while (releaseHeight.releaseNumber > releaseNumber) {
      if (releaseHeight.previousCosignHeight === null) return;
      const previousBlock = await blockWatch.getHeaderByBlockNumber(releaseHeight.previousCosignHeight);
      const previousClient = await blockWatch.getApi(previousBlock);
      const previousReleaseHeight = await previousClient.query.bitcoinLocks.lockReleaseCosignHeightById(lockId);
      if (!previousReleaseHeight || typeof previousReleaseHeight === 'number') return;
      releaseHeight = previousReleaseHeight;
      releaseBlock = previousBlock;
    }

    if (releaseHeight.releaseNumber !== releaseNumber) return;

    const blockHeight = releaseHeight.cosignHeight;
    const block = releaseBlock ?? (await blockWatch.getHeaderByBlockNumber(blockHeight));
    const blockEvents = await blockWatch.getEvents(block);
    for (const { event } of blockEvents) {
      const runtimeEvent = toRuntimeEvent(event);
      if (runtimeEvent?.section !== 'bitcoinLocks' || runtimeEvent.method !== 'BitcoinUtxoCosigned') continue;

      const { signatures } = runtimeEvent.data;
      if (runtimeEvent.data.lockId !== lockId || runtimeEvent.data.releaseNumber !== releaseNumber) continue;
      if (!signatures?.length) continue;

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
    destinationSatoshis: bigint;
    bitcoinNetworkFee: bigint;
  }) {
    const { client, lockId, toScriptPubkey, destinationSatoshis, bitcoinNetworkFee } = args;
    assertHexScriptPubkey(toScriptPubkey);
    return client.tx.bitcoinLocks.requestRelease(lockId, toScriptPubkey, destinationSatoshis, bitcoinNetworkFee);
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
    const transactions = client.tx.bitcoinLocks as
      | typeof client.tx.bitcoinLocks
      | PreviousRuntimeSpec.Transactions<'promise'>['bitcoinLocks'];
    const options = { microgonsAtTargetPerBtc, feeCoupon: feeCoupon ?? null };
    if ('setGuarantee' in transactions) return transactions.setGuarantee(lockId, securitizedSatoshis, options);
    return transactions.resecuritize(lockId, securitizedSatoshis, options);
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
    const remainingTerm = new FixedU128BigNumber(remainingBlocks).dividedBy(fullTerm);
    const variableFee = vault.terms.bitcoinAnnualPercentRate
      .multipliedBy(remainingTerm)
      .decimalPlaces(18, BigNumber.ROUND_DOWN)
      .multipliedBy(additionalCoverageMicrogons.toString())
      .integerValue(BigNumber.ROUND_DOWN);
    return BigInt(variableFee.toFixed(0)) + vault.terms.bitcoinBaseFee;
  }

  public static async getConfig(client: ArgonQueryClient): Promise<IBitcoinLockConfig> {
    const bitcoinNetwork = await client.query.bitcoinUtxos.bitcoinNetwork();
    return {
      lockReleaseCosignDeadlineFrames: client.consts.bitcoinLocks.lockReleaseCosignDeadlineFrames,
      securitizationHoldBlocks: client.consts.bitcoinLocks.securitizationHoldBlocks,
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
    client: ArgonCurrentQueryClient,
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

  public static satoshisRequiredForRedemptionAmount(
    priceIndex: PriceIndex,
    redemptionAmount: bigint,
    microgonsAtTargetPerBtc?: bigint,
  ): bigint {
    if (redemptionAmount <= 0n) return 0n;

    const multiplierBn = this.redemptionMultiplierBn(priceIndex);
    const targetMicrogonsPerBtc = microgonsAtTargetPerBtc ?? priceIndex.getSatoshiPriceInTargetMicrogons(SATS_PER_BTC);
    let requiredTargetMicrogons = BigInt(
      new BigNumber(redemptionAmount.toString()).div(multiplierBn).integerValue(BigNumber.ROUND_CEIL).toFixed(0),
    );

    while (this.calculateRedemptionAmount(priceIndex, requiredTargetMicrogons) < redemptionAmount) {
      requiredTargetMicrogons += 1n;
    }

    let satoshis = (requiredTargetMicrogons * SATS_PER_BTC + targetMicrogonsPerBtc - 1n) / targetMicrogonsPerBtc;
    const coverageForSatoshis = (amount: bigint) =>
      this.calculateLiquidityPromised({ priceIndex, satoshis: amount, microgonsAtTargetPerBtc });

    while (coverageForSatoshis(satoshis) < redemptionAmount) {
      satoshis += 1n;
    }
    while (satoshis > 0n && coverageForSatoshis(satoshis - 1n) >= redemptionAmount) {
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

  public static fromRuntime(
    lockId: number,
    lock: NonNullable<LiveQueryRecord<'bitcoinLocks', 'locksById'>>,
  ): BitcoinLock {
    const wscriptHash = lock.utxoScriptPubkey.value.wscriptHash.replace('0x', '');
    const [fingerprint, cosignHdIndex, claimHdIndex] = lock.vaultXpubSources;
    let guarantee: BitcoinCosignerGuarantee;
    let collateralMicrogons: bigint;
    let availableSatoshis = lock.fundedSatoshis;
    let securitizationRatio: number | undefined;

    if ('cosignerGuarantee' in lock) {
      guarantee = lock.cosignerGuarantee;
      collateralMicrogons = guarantee.guaranteedMicrogons;
      availableSatoshis -= lock.fissionedSatoshis;
    } else {
      guarantee = {
        basis: { ...lock.securitizationBasis, tick: lock.securitizationTick },
        guaranteedMicrogons: lock.securitizationCoverageMicrogons,
        fundHoldExtensions: lock.fundHoldExtensions,
      };
      collateralMicrogons = bigNumberToBigInt(lock.securitizationRatio.multipliedBy(guarantee.guaranteedMicrogons));
      securitizationRatio = lock.securitizationRatio.toNumber();
    }

    const { basis, guaranteedMicrogons, fundHoldExtensions } = guarantee;
    const securitizedSatoshis =
      lock.fundedSatoshis === 0n ? basis.satoshis : bigIntMin(availableSatoshis, basis.satoshis);
    let fundedCoverageMicrogons = 0n;
    if (basis.satoshis > 0n) {
      if ('cosignerGuarantee' in lock) {
        fundedCoverageMicrogons = (guaranteedMicrogons * securitizedSatoshis) / basis.satoshis;
      } else {
        fundedCoverageMicrogons = BitcoinLock.calculateSharedGuaranteeCoverage({
          fundedSatoshis: securitizedSatoshis,
          basisSatoshis: basis.satoshis,
          coverageMicrogons: guaranteedMicrogons,
        });
      }
    }

    return new BitcoinLock({
      lockId,
      p2wshScriptHashHex: `0x0020${wscriptHash}`,
      vaultId: lock.vaultId,
      securitizedSatoshis,
      microgonsAtTargetPerBtc: basis.microgonsAtTargetPerBtc,
      securitizationCoverageMicrogons: fundedCoverageMicrogons,
      // A full return unwinds the entire contract, including its unactivated collateral.
      securitizationCollateralMicrogons: collateralMicrogons,
      securitizationTick: basis.tick,
      cosignerGuarantee: guarantee,
      securitizationRatio,
      fundedSatoshis: lock.fundedSatoshis,
      fundingUtxos: lock.fundingUtxos.map(([utxoRef, satoshis]) => ({
        utxoRef: { txid: utxoRef.txid, vout: utxoRef.outputIndex },
        satoshis,
      })),
      fissionedSatoshis: lock.fissionedSatoshis,
      ownerAccount: lock.ownerAccount,
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
        Object.entries(fundHoldExtensions).map(([height, amount]) => [Number(height), amount]),
      ),
      createdAtArgonBlock: lock.createdAtArgonBlock,
    });
  }

  private transferredFissionCoverage(satoshis: bigint): bigint {
    const guarantee = this.cosignerGuarantee;
    if (!guarantee || guarantee.basis.satoshis === 0n) return 0n;

    const remainingSatoshis = this.fundedSatoshis - this.fissionedSatoshis - satoshis;
    const transferredSatoshis =
      this.securitizedSatoshis > remainingSatoshis ? this.securitizedSatoshis - remainingSatoshis : 0n;
    return (guarantee.guaranteedMicrogons * transferredSatoshis) / guarantee.basis.satoshis;
  }

  // Runtime 160 compatibility. Its Fissions use the parent Lock's coverage.

  /** Runtime 160 needs a Lock change to cover its Fissions together; 161 changes each Fission's own guarantee. */
  public static calculateResecuritizationForRatchet(args: {
    lockId: number;
    lock: NonNullable<LiveQueryRecord<'bitcoinLocks', 'locksById'>>;
    lockFissions: readonly BitcoinFission[];
    selectedFissionIds: ReadonlySet<number>;
    microgonsAtTargetPerBtc: bigint;
    priceIndex: PriceIndex;
  }) {
    const { lockId, lock: runtimeLock, lockFissions, selectedFissionIds, microgonsAtTargetPerBtc, priceIndex } = args;
    if ('cosignerGuarantee' in runtimeLock) return;
    if (!lockFissions.some(fission => selectedFissionIds.has(fission.fissionId))) return;
    const lock = BitcoinLock.fromRuntime(lockId, runtimeLock);
    let requiredLiquidity = 0n;
    let requiredRate = 0n;
    for (const fission of lockFissions) {
      let rate = fission.microgonsAtTargetPerBtc;
      let liquidity = fission.liquidityPromised;
      if (selectedFissionIds.has(fission.fissionId)) {
        rate = microgonsAtTargetPerBtc;
        liquidity = BitcoinLock.calculateLiquidityPromised({
          priceIndex,
          satoshis: fission.satoshis,
          microgonsAtTargetPerBtc: rate,
        });
      }
      requiredLiquidity += liquidity;
      requiredRate = bigIntMax(requiredRate, rate);
    }

    const satoshis = bigIntMax(
      lock.fissionedSatoshis,
      BitcoinLock.satoshisRequiredForRedemptionAmount(priceIndex, requiredLiquidity, requiredRate),
    );
    if (satoshis === lock.securitizedSatoshis && requiredRate === lock.microgonsAtTargetPerBtc) return;
    const increasesGuarantee = satoshis > lock.securitizedSatoshis || requiredRate > lock.microgonsAtTargetPerBtc;
    return { satoshis, microgonsAtTargetPerBtc: requiredRate, increasesGuarantee };
  }

  public static calculateSharedGuaranteeCoverage(args: {
    fundedSatoshis: bigint;
    basisSatoshis: bigint;
    coverageMicrogons: bigint;
  }): bigint {
    const { fundedSatoshis, basisSatoshis, coverageMicrogons } = args;
    if (basisSatoshis === 0n) return 0n;

    const fundedShare = new FixedU128BigNumber(bigIntMin(fundedSatoshis, basisSatoshis)).dividedBy(basisSatoshis);
    return bigNumberToBigInt(fundedShare.multipliedBy(coverageMicrogons));
  }

  // Runtime 160's Lock guarantee must cover the combined liability of every Fission using it.
  private quoteFissionWithLockGuarantee(
    args: Omit<Parameters<typeof BitcoinLock.quoteFissionCreation>[0], 'lockId' | 'lock'>,
    runtimeLock: NonNullable<LiveQueryRecord<'bitcoinLocks', 'locksById'>>,
  ): ReturnType<typeof BitcoinLock.quoteFissionCreation> {
    const { satoshis, vault, priceIndex, microgonsAtTargetPerBtc, eligibleRates, lockFissions, currentBitcoinHeight } =
      args;
    const currentCoverageMicrogons = this.cosignerGuarantee!.guaranteedMicrogons;
    const remainingCapacity = Object.assign(Object.create(Vault.prototype) as Vault, vault);
    const currentCollateral = this.securitizationCollateralMicrogons!;
    remainingCapacity.securitizationLocked -= currentCollateral;
    if (this.isFlexible) {
      remainingCapacity.flexibleSecuritizationLocked -= BitcoinLock.collateralForCoverage(
        runtimeLock,
        this.securitizationCoverageMicrogons,
      );
    }
    const availableCollateral = remainingCapacity.availableSecuritizationSpace(this.ownerAccount, this.isFlexible);

    let existingLiquidityPromised = 0n;
    let requiredRate = microgonsAtTargetPerBtc;
    let requiredTick = this.securitizationTick;
    for (const fission of lockFissions) {
      existingLiquidityPromised += fission.liquidityPromised;
      requiredRate = bigIntMax(requiredRate, fission.microgonsAtTargetPerBtc);
      requiredTick = Math.max(requiredTick, fission.lastRatchetTick ?? 0);
    }

    const requiredLiquidity =
      existingLiquidityPromised +
      BitcoinLock.calculateLiquidityPromised({
        priceIndex,
        satoshis,
        microgonsAtTargetPerBtc,
      });
    const securitizedSatoshis = bigIntMax(this.securitizedSatoshis, this.fissionedSatoshis + satoshis);
    const increasesSatoshis = securitizedSatoshis > this.securitizedSatoshis;
    const increasesRate = microgonsAtTargetPerBtc > this.microgonsAtTargetPerBtc;
    const exceedsCoverage = requiredLiquidity > this.securitizationCoverageMicrogons;
    const needsResecuritization = increasesSatoshis || increasesRate || exceedsCoverage;

    const capacityInput = {
      runtimeLock,
      priceIndex,
      existingLiquidityPromised,
      availableCollateral,
      allocationRate: microgonsAtTargetPerBtc,
    };
    const compatibleRates = eligibleRates.filter(([tick, rate]) => {
      if (tick < requiredTick) return false;
      return rate >= requiredRate;
    });
    let lockRate = this.microgonsAtTargetPerBtc;
    if (needsResecuritization) {
      if (!compatibleRates.length) {
        return {
          error:
            'Existing Liquids need a Bitcoin price that is no longer available. Reduce the amount to Bitcoin already covered by a cosigner guarantee, or wait for an eligible price.',
        };
      }

      const coverageRates = compatibleRates.filter(([, rate]) => {
        const sameSatoshis = securitizedSatoshis === this.cosignerGuarantee!.basis.satoshis;
        if (sameSatoshis && rate === this.microgonsAtTargetPerBtc) return false;

        const replacementCoverage = BitcoinLock.calculateLiquidityPromised({
          priceIndex,
          satoshis: securitizedSatoshis,
          microgonsAtTargetPerBtc: rate,
        });
        return replacementCoverage >= requiredLiquidity;
      });
      if (!coverageRates.length) {
        return {
          error:
            'This Bitcoin cannot cover the existing and selected Liquids at the current price. Reduce the amount or wait for an eligible price.',
        };
      }

      const affordableRates = coverageRates.filter(([, rate]) => {
        const maximumSatoshis = this.getMaximumAffordableSatoshis({ ...capacityInput, replacementRate: rate });
        return maximumSatoshis >= satoshis;
      });
      let selectableRates = coverageRates;
      if (affordableRates.length) {
        selectableRates = affordableRates;
      }

      const existingRate = selectableRates.findLast(([, rate]) => rate === this.microgonsAtTargetPerBtc);
      const replacementRate = existingRate ?? selectableRates.at(-1)!;
      lockRate = replacementRate[1];
    }

    const eligibleReplacement = compatibleRates.some(([, rate]) => rate === lockRate);
    const selectedMaximumSatoshis = this.getMaximumAffordableSatoshis({
      ...capacityInput,
      replacementRate: eligibleReplacement ? lockRate : undefined,
    });

    // A retained guarantee need not limit the capacity available at eligible replacement prices.
    let minimumCompatibleRate: bigint | undefined;
    for (const [, rate] of compatibleRates) {
      if (minimumCompatibleRate === undefined || rate < minimumCompatibleRate) minimumCompatibleRate = rate;
    }
    const maximumSatoshis = this.getMaximumAffordableSatoshis({
      ...capacityInput,
      replacementRate: minimumCompatibleRate,
    });

    const acceptedSatoshis = bigIntMin(satoshis, selectedMaximumSatoshis);
    const acceptedSecuritizedSatoshis = bigIntMax(this.securitizedSatoshis, this.fissionedSatoshis + acceptedSatoshis);
    let replacementCoverageMicrogons = currentCoverageMicrogons;
    if (needsResecuritization) {
      replacementCoverageMicrogons = BitcoinLock.calculateLiquidityPromised({
        priceIndex,
        satoshis: acceptedSecuritizedSatoshis,
        microgonsAtTargetPerBtc: lockRate,
      });

      const replacementCollateral = BitcoinLock.collateralForCoverage(runtimeLock, replacementCoverageMicrogons);
      remainingCapacity.securitizationLocked += replacementCollateral;
      if (this.isFlexible) remainingCapacity.flexibleSecuritizationLocked += replacementCollateral;
    }

    const quote: IBitcoinFissionCreationQuote = {
      fission: {
        satoshis: acceptedSatoshis,
        microgonsAtTargetPerBtc,
        liquidityPromised: BitcoinLock.calculateLiquidityPromised({
          priceIndex,
          satoshis: acceptedSatoshis,
          microgonsAtTargetPerBtc,
        }),
      },
      maximumSatoshis,
      projectedVault: vault,
    };
    if (needsResecuritization) {
      quote.projectedVault = remainingCapacity;
      quote.lockGuarantee = {
        satoshis: acceptedSecuritizedSatoshis,
        microgonsAtTargetPerBtc: lockRate,
        currentCoverageMicrogons,
        replacementCoverageMicrogons,
        totalSecurityFee: BitcoinLock.calculateResecuritizationFee({
          vault,
          currentCoverageMicrogons,
          replacementCoverageMicrogons,
          currentBitcoinHeight,
          createdAtBitcoinHeight: this.createdAtHeight,
          vaultClaimBitcoinHeight: this.vaultClaimHeight,
        }),
      };
    }
    return quote;
  }

  private getMaximumAffordableSatoshis(args: {
    runtimeLock: NonNullable<LiveQueryRecord<'bitcoinLocks', 'locksById'>>;
    priceIndex: PriceIndex;
    allocationRate: bigint;
    replacementRate?: bigint;
    existingLiquidityPromised: bigint;
    availableCollateral: bigint;
  }): bigint {
    const { runtimeLock, priceIndex, allocationRate, replacementRate, existingLiquidityPromised, availableCollateral } =
      args;
    const availableSatoshis = bigIntMax(this.fundedSatoshis - this.fissionedSatoshis, 0n);
    const retainedMaximum = BitcoinLock.maximumSatoshisWithinVaultCapacity(availableSatoshis, satoshis => {
      if (this.fissionedSatoshis + satoshis > this.securitizedSatoshis) return false;
      if (allocationRate > this.microgonsAtTargetPerBtc) return false;
      const requiredLiquidity =
        existingLiquidityPromised +
        BitcoinLock.calculateLiquidityPromised({
          priceIndex,
          satoshis,
          microgonsAtTargetPerBtc: allocationRate,
        });
      return requiredLiquidity <= this.securitizationCoverageMicrogons;
    });
    if (replacementRate === undefined) return retainedMaximum;

    // The selected allocation already passed its basis, rate and liability checks.
    // This upper bound measures affordability; other allocations must be quoted again.
    const replacementMaximum = BitcoinLock.maximumSatoshisWithinVaultCapacity(availableSatoshis, satoshis => {
      const coverage = BitcoinLock.calculateLiquidityPromised({
        priceIndex,
        satoshis: bigIntMax(this.securitizedSatoshis, this.fissionedSatoshis + satoshis),
        microgonsAtTargetPerBtc: replacementRate,
      });
      const collateral = BitcoinLock.collateralForCoverage(runtimeLock, coverage);
      return collateral <= availableCollateral;
    });
    return bigIntMax(retainedMaximum, replacementMaximum);
  }

  private static maximumSatoshisWithinVaultCapacity(
    availableSatoshis: bigint,
    fitsVaultCapacity: (satoshis: bigint) => boolean,
  ): bigint {
    if (fitsVaultCapacity(availableSatoshis)) return availableSatoshis;
    let lower = 0n;
    let upper = availableSatoshis;
    while (lower + 1n < upper) {
      const middle = (lower + upper) / 2n;
      if (fitsVaultCapacity(middle)) lower = middle;
      else upper = middle;
    }
    return lower;
  }

  private static collateralForCoverage(
    lock: NonNullable<LiveQueryRecord<'bitcoinLocks', 'locksById'>>,
    coverageMicrogons: bigint,
  ): bigint {
    if ('securitizationRatio' in lock)
      return bigNumberToBigInt(lock.securitizationRatio.multipliedBy(coverageMicrogons));
    return coverageMicrogons;
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
  destinationSatoshis: bigint;
  changeSatoshis: bigint;
}

export interface IReleaseRequestDetails extends IReleaseRequest {
  lockId: number;
  vaultId: number;
  releaseNumber: number;
  cosignDueFrame: number;
  expectedTransactionId: string;
  securitizationAtRisk: bigint;
}

export interface IBitcoinLock {
  lockId: number;
  p2wshScriptHashHex: string;
  vaultId: number;
  securitizedSatoshis: bigint;
  microgonsAtTargetPerBtc: bigint;
  securitizationCoverageMicrogons: bigint;
  /** Full contract collateral; funded coverage may be smaller after a partial return. */
  securitizationCollateralMicrogons?: bigint;
  securitizationTick: number;
  fundedSatoshis: bigint;
  fundingUtxos: IBitcoinLockFundingUtxo[];
  fissionedSatoshis: bigint;
  ownerAccount: string;
  securitizationRatio?: number;
  cosignerGuarantee?: BitcoinCosignerGuarantee;
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
  securitizationHoldExpirationBitcoinHeight: number | null;
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

export function convertBitcoinTargetValueToPricePerBtc(targetMicrogons: bigint, satoshis: bigint): bigint {
  // Spec 159 first rounds the BTC/satoshi ratio with FixedU128::from_rational,
  // then floors its product with the old Lock's total target value.
  const satoshisRatio = new FixedU128BigNumber(SATS_PER_BTC).dividedBy(satoshis);
  const price = BigInt(satoshisRatio.multipliedBy(targetMicrogons).integerValue(BigNumber.ROUND_DOWN).toFixed());
  return bigIntMin(price, 2n ** 128n - 1n);
}

/** The runtime emits the owner-paid guarantee fee before the action's completion event. */
export function readBitcoinGuaranteeFee(
  events: readonly HistoricalEvent[],
  eventIndex: number,
  ownerAccount: string,
): bigint {
  let fee = 0n;
  for (let index = eventIndex - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.section === 'bitcoinFissions' || event.section === 'utility') break;
    if (
      event.section === 'bitcoinLocks' &&
      (event.method === 'BitcoinLockCreated' ||
        event.method === 'BitcoinLockResecuritized' ||
        event.method === 'BitcoinLockGuaranteeSet')
    ) {
      break;
    }
    if (
      event.section === 'balances' &&
      event.method === 'TransferAndHold' &&
      event.data.source === ownerAccount &&
      event.data.reason.type === 'Vaults' &&
      event.data.reason.value.type === 'PendingCollect'
    ) {
      fee += event.data.transferred;
    }
  }
  return fee;
}

function assertHexScriptPubkey(toScriptPubkey: string): void {
  if (!toScriptPubkey.startsWith('0x')) {
    throw new Error('toScriptPubkey must be a hex string starting with 0x');
  }
}
