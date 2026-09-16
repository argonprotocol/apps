import {
  bigIntMax,
  bigIntMin,
  BitcoinFission,
  BitcoinLock,
  Currency,
  createDeferred,
  NetworkConfig,
  SingleFileQueue,
  type IBitcoinLockCouponStatus,
  type ArgonClient,
  type TxSigningAccount,
  Vault,
  type Vaults,
} from '@argonprotocol/apps-core';
import type { PriceIndex } from '@argonprotocol/mainchain';

import BitcoinLocks, { BitcoinLockWalletFundingError } from '../BitcoinLocks.ts';
import type { BitcoinFissions } from '../BitcoinFissions.ts';
import type { IBitcoinLockRecord } from '../db/BitcoinLocksTable.ts';
import { ExtrinsicType } from '../db/TransactionsTable.ts';
import type { TransactionInfo } from '../TransactionInfo.ts';
import type { TransactionTracker } from '../TransactionTracker.ts';
import type { UpstreamOperatorClient } from '../UpstreamOperatorClient.ts';
import { getMainchainClient } from '../../stores/mainchain.ts';
import type { BitcoinLockResecuritize, IBitcoinResecuritizationMetadata } from './BitcoinLock.resecuritize.ts';
import {
  TransactionOperation,
  type PreparedTransactionOperation,
  type TransactionOperationBuild,
} from './TransactionOperation.ts';

export interface BitcoinLiquidCreateAllocation {
  lock: IBitcoinLockRecord;
  satoshis: bigint;
  operatorCoupon?: IBitcoinLockCouponStatus;
}

export interface BitcoinLiquidCreateInput {
  allocations: BitcoinLiquidCreateAllocation[];
  txSigner: TxSigningAccount;
  tip?: bigint;
  client?: ArgonClient;
}

export interface IBitcoinLiquidCreateMetadata {
  liquidId: number;
  snapshotBlockHash: string;
  fissions: IBitcoinLiquidCreateFission[];
  resecuritizations: IBitcoinResecuritizationMetadata[];
}

export interface IBitcoinLiquidCreateFission {
  fissionId: number;
  lockId: number;
  satoshis: bigint;
  microgonsAtTargetPerBtc: bigint;
  liquidityPromised: bigint;
}

type CurrentAllocation = {
  input: BitcoinLiquidCreateAllocation;
  lock: BitcoinLock;
  vault: Vault;
  maximumSatoshis: bigint;
  securitizedSatoshis: bigint;
  microgonsAtTargetPerBtc: bigint;
  totalSecurityFee: bigint;
};

type CurrentCreateState = {
  client: ArgonClient;
  snapshotBlockHash: string;
  priceIndex: PriceIndex;
  currentBitcoinHeight: number;
  nextFissionId: number;
  microgonsAtTargetPerBtc: bigint;
  microgonsAtTargetPerBtcTick: number;
  allocations: CurrentAllocation[];
};

type BitcoinLiquidCreateBuild = TransactionOperationBuild<IBitcoinLiquidCreateMetadata>;

export interface IBitcoinLiquidCreatePreview {
  microgonsAtTargetPerBtc: bigint;
  microgonsAtTargetPerBtcTick: number;
  liquidityMicrogons: bigint;
  totalSecurityFeeMicrogons: bigint;
  securityFeeMicrogons: bigint;
  couponCreditMicrogons: bigint;
  maximumSatoshisByLockId: Readonly<Record<number, bigint>>;
}

export class BitcoinLiquidCreateStateChangedError extends Error {
  constructor(
    message: string,
    public readonly maximumSatoshisByLockId: Readonly<Record<number, bigint>> = {},
  ) {
    super(message);
  }
}

export class BitcoinLiquidCreate extends TransactionOperation<
  BitcoinLiquidCreateInput,
  IBitcoinLiquidCreateMetadata,
  BitcoinLiquidCreateBuild
> {
  protected readonly extrinsicType = ExtrinsicType.BitcoinLiquidCreate;
  private readonly submissionQueue = new SingleFileQueue();

  constructor(
    private readonly fissions: BitcoinFissions,
    transactionTracker: TransactionTracker,
    private readonly bitcoinLocks: BitcoinLocks,
    private readonly vaults: Vaults,
    private readonly bitcoinLockResecuritize: BitcoinLockResecuritize,
    private readonly upstreamOperatorClient: UpstreamOperatorClient,
  ) {
    super(transactionTracker);
  }

  public override async submit(args: BitcoinLiquidCreateInput): Promise<TransactionInfo<IBitcoinLiquidCreateMetadata>> {
    const submission = createDeferred<TransactionInfo<IBitcoinLiquidCreateMetadata>>();
    this.submissionQueue.add(async () => {
      try {
        const txInfo = await super.submit(args);
        submission.resolve(txInfo);
        await txInfo.txResult.waitForFinalizedBlock;
      } catch (error) {
        submission.reject(error as Error);
      }
    });
    return await submission.promise;
  }

  public async preview(args: BitcoinLiquidCreateInput): Promise<IBitcoinLiquidCreatePreview> {
    const { txSigner } = args;
    const { priceIndex, microgonsAtTargetPerBtc, microgonsAtTargetPerBtcTick, allocations } =
      await this.readCurrentState(args);
    const remainingFeeCreditByCouponId = this.getAvailableFeeCreditByCouponId(allocations);
    let liquidityMicrogons = 0n;
    let totalSecurityFeeMicrogons = 0n;
    let securityFeeMicrogons = 0n;
    let couponCreditMicrogons = 0n;

    for (const allocation of allocations) {
      const { input, vault, totalSecurityFee } = allocation;
      const { operatorCoupon } = input;
      const availableFeeCredit = operatorCoupon
        ? (remainingFeeCreditByCouponId.get(operatorCoupon.coupon.id) ?? 0n)
        : 0n;
      const couponCredit =
        txSigner.address === vault.operatorAccountId ? 0n : bigIntMin(totalSecurityFee, availableFeeCredit);
      if (operatorCoupon) {
        remainingFeeCreditByCouponId.set(operatorCoupon.coupon.id, availableFeeCredit - couponCredit);
      }

      liquidityMicrogons += BitcoinLock.calculateLiquidityPromised({
        priceIndex,
        satoshis: input.satoshis,
        microgonsAtTargetPerBtc,
      });
      totalSecurityFeeMicrogons += totalSecurityFee;
      if (txSigner.address !== vault.operatorAccountId) {
        securityFeeMicrogons += totalSecurityFee - couponCredit;
        couponCreditMicrogons += couponCredit;
      }
    }

    return {
      microgonsAtTargetPerBtc,
      microgonsAtTargetPerBtcTick,
      liquidityMicrogons,
      totalSecurityFeeMicrogons,
      securityFeeMicrogons,
      couponCreditMicrogons,
      maximumSatoshisByLockId: Object.fromEntries(
        allocations.map(({ input, maximumSatoshis }) => [input.lock.lockId!, maximumSatoshis]),
      ),
    };
  }

  protected async build(args: BitcoinLiquidCreateInput): Promise<BitcoinLiquidCreateBuild> {
    const { txSigner, tip } = args;
    const state = await this.readCurrentState(args);
    const {
      client,
      snapshotBlockHash,
      priceIndex,
      currentBitcoinHeight,
      nextFissionId,
      microgonsAtTargetPerBtc,
      allocations,
    } = state;
    const table = await this.bitcoinLocks.getTable();
    const remainingFeeCreditByCouponId = this.getAvailableFeeCreditByCouponId(allocations);
    const resecuritizations: IBitcoinResecuritizationMetadata[] = [];
    const resecuritizationTxs = [];
    let securityFee = 0n;

    try {
      for (const allocation of allocations) {
        const { input, lock: currentLock, vault, securitizedSatoshis, totalSecurityFee } = allocation;
        const { lock, operatorCoupon } = input;
        await table.updateFromCurrentLock(lock, currentLock);
        if (
          securitizedSatoshis === currentLock.securitizedSatoshis &&
          allocation.microgonsAtTargetPerBtc === currentLock.microgonsAtTargetPerBtc
        ) {
          continue;
        }

        const availableFeeCredit = operatorCoupon
          ? (remainingFeeCreditByCouponId.get(operatorCoupon.coupon.id) ?? 0n)
          : 0n;
        const feeCreditMicrogons = bigIntMin(totalSecurityFee, availableFeeCredit);
        if (operatorCoupon) {
          remainingFeeCreditByCouponId.set(operatorCoupon.coupon.id, availableFeeCredit - feeCreditMicrogons);
        }
        const prepared = await this.bitcoinLockResecuritize.prepare({
          lock,
          vault,
          securitizedSatoshis,
          microgonsAtTargetPerBtc: allocation.microgonsAtTargetPerBtc,
          txSigner,
          operatorCoupon,
          client,
          priceIndex,
          currentBitcoinHeight,
          maximumFeeCreditMicrogons: feeCreditMicrogons,
        });
        resecuritizationTxs.push(prepared.tx);
        resecuritizations.push(prepared.metadata);
        securityFee += prepared.securityFee;
      }
    } catch (error) {
      await Promise.all(resecuritizations.map(metadata => this.bitcoinLockResecuritize.failResecuritization(metadata)));
      throw error;
    }

    const liquidId = nextFissionId;
    const fissions: IBitcoinLiquidCreateFission[] = allocations.map(({ input }, index) => ({
      fissionId: liquidId + index,
      lockId: input.lock.lockId!,
      satoshis: input.satoshis,
      microgonsAtTargetPerBtc,
      liquidityPromised: BitcoinLock.calculateLiquidityPromised({
        priceIndex,
        satoshis: input.satoshis,
        microgonsAtTargetPerBtc,
      }),
    }));
    const fissionTxs = fissions.map(fission => BitcoinFission.createTx({ client, liquidId, ...fission }));

    return {
      client,
      txs: [...resecuritizationTxs, ...fissionTxs],
      txSigner,
      tip,
      unavailableBalance: securityFee,
      includeExistentialDeposit: true,
      metadata: { liquidId, snapshotBlockHash, fissions, resecuritizations },
    };
  }

  protected getOperationKey(args: BitcoinLiquidCreateInput): string {
    const { allocations, txSigner } = args;
    return `${txSigner.address}:${allocations.map(({ lock, satoshis }) => `${lock.lockId}:${satoshis}`).join(',')}`;
  }

  protected matches(args: BitcoinLiquidCreateInput, txInfo: TransactionInfo<IBitcoinLiquidCreateMetadata>): boolean {
    const { allocations, txSigner } = args;
    const { fissions } = txInfo.tx.metadataJson;
    return (
      txInfo.tx.accountAddress === txSigner.address &&
      fissions.length === allocations.length &&
      fissions.every((fission, index) => {
        const allocation = allocations[index];
        return fission.lockId === allocation.lock.lockId && fission.satoshis === allocation.satoshis;
      })
    );
  }

  public getPendingLiquidTxInfo(liquidId: number): TransactionInfo<IBitcoinLiquidCreateMetadata> | undefined {
    return this.getPendingLiquidTxInfos().find(txInfo => txInfo.tx.metadataJson.liquidId === liquidId);
  }

  public getPendingLiquidTxInfos(): TransactionInfo<IBitcoinLiquidCreateMetadata>[] {
    const pendingLiquidIds = new Set(this.fissions.getPendingLiquids().map(liquid => liquid.liquidId));
    const foundLiquidIds = new Set<number>();

    return this.getActiveTransactions(txInfo => {
      return (
        txInfo.tx.accountAddress === this.fissions.ownerAccount && pendingLiquidIds.has(txInfo.tx.metadataJson.liquidId)
      );
    })
      .toSorted((left, right) => right.tx.id - left.tx.id)
      .filter(txInfo => {
        const { liquidId } = txInfo.tx.metadataJson;
        if (foundLiquidIds.has(liquidId)) return false;

        foundLiquidIds.add(liquidId);
        return true;
      });
  }

  protected async onSubmitted(txInfo: TransactionInfo<IBitcoinLiquidCreateMetadata>): Promise<void> {
    const { liquidId, fissions } = txInfo.tx.metadataJson;
    const now = new Date();
    this.fissions.publishPendingFissions(
      fissions.map(
        fission =>
          new BitcoinFission({
            ...fission,
            ownerAccount: this.fissions.ownerAccount,
            liquidId,
            ratchetNumber: 0,
            origin: 'created',
            ratchets: [],
            createdAt: now,
            updatedAt: now,
          }),
      ),
    );
  }

  protected async onFinalized(txInfo: TransactionInfo<IBitcoinLiquidCreateMetadata>): Promise<void> {
    await txInfo.txResult.waitForFinalizedBlock;
    for (const metadata of txInfo.tx.metadataJson.resecuritizations) {
      await this.bitcoinLockResecuritize.finalizeResecuritization(metadata, txInfo);
    }
    await this.transactionTracker.ensureStoredEvents(txInfo);
    await this.fissions.recordFinalizedTransaction(txInfo);
  }

  protected async onFailed(txInfo: TransactionInfo<IBitcoinLiquidCreateMetadata>): Promise<void> {
    await this.failResecuritizations(txInfo.tx.metadataJson.resecuritizations);
  }

  protected async onSubmissionFailed(
    prepared: PreparedTransactionOperation<IBitcoinLiquidCreateMetadata, BitcoinLiquidCreateBuild>,
  ): Promise<void> {
    await this.failResecuritizations(prepared.metadata.resecuritizations);
  }

  protected createInsufficientFundsError(
    prepared: PreparedTransactionOperation<IBitcoinLiquidCreateMetadata, BitcoinLiquidCreateBuild>,
  ): Error {
    const requiredWalletBalanceMicrogons =
      (prepared.unavailableBalance ?? 0n) +
      prepared.txFeePlusTip +
      prepared.client.consts.balances.existentialDeposit.toBigInt();
    return new BitcoinLockWalletFundingError(requiredWalletBalanceMicrogons);
  }

  private async readCurrentState(args: BitcoinLiquidCreateInput): Promise<CurrentCreateState> {
    const { allocations: requestedAllocations, txSigner, client: providedClient } = args;
    let allocations = requestedAllocations;
    if (!allocations.length) throw new Error('Select Bitcoin to create this Liquid.');
    if (allocations.some(({ satoshis }) => satoshis <= 0n)) {
      throw new Error('A Liquid cannot include an empty Bitcoin allocation.');
    }
    if (new Set(allocations.map(({ lock }) => lock.lockId)).size !== allocations.length) {
      throw new Error('Each Bitcoin Lock can only be included once in a Liquid.');
    }
    if (txSigner.address !== this.fissions.ownerAccount) {
      throw new Error('This Liquid belongs to a different account.');
    }

    const client = providedClient ?? (await getMainchainClient(false));
    const finalizedHead = await client.rpc.chain.getFinalizedHead();
    const snapshotClient = await client.at(finalizedHead);
    const priceIndex = await Currency.fetchPriceIndex(snapshotClient);
    if (allocations.some(({ operatorCoupon }) => operatorCoupon)) {
      const currentCoupons = await this.upstreamOperatorClient.getBitcoinLockCoupons();
      allocations = allocations.map(allocation => {
        const { operatorCoupon } = allocation;
        if (!operatorCoupon) return allocation;

        const currentCoupon = currentCoupons.find(({ coupon }) => coupon.id === operatorCoupon.coupon.id);
        if (!currentCoupon) {
          throw new BitcoinLiquidCreateStateChangedError('Your Bitcoin fee gift is no longer available.');
        }
        if (
          currentCoupon.status !== operatorCoupon.status ||
          currentCoupon.remainingFeeCreditMicrogons !== operatorCoupon.remainingFeeCreditMicrogons
        ) {
          throw new BitcoinLiquidCreateStateChangedError('Your Bitcoin fee gift changed. Review the updated fees.');
        }
        return { ...allocation, operatorCoupon: currentCoupon };
      });
    }
    const lockIds = allocations.map(({ lock }) => lock.lockId).filter((lockId): lockId is number => lockId != null);
    const [currentLocks, releaseRequests, bitcoinTip, nextFissionId, eligibleRates] = await Promise.all([
      BitcoinLock.getMany(snapshotClient, lockIds),
      Promise.all(lockIds.map(lockId => BitcoinLock.getReleaseRequest(snapshotClient, lockId))),
      snapshotClient.query.bitcoinUtxos.confirmedBitcoinBlockTip(),
      BitcoinFission.nextId(snapshotClient, txSigner.address),
      snapshotClient.query.bitcoinLocks.microgonPerBtcHistory(),
    ]);
    const eligibleRate = eligibleRates?.at(-1);
    if (!eligibleRate) {
      throw new BitcoinLiquidCreateStateChangedError('Network Bitcoin pricing is currently unavailable.');
    }
    const [microgonsAtTargetPerBtcTick, microgonsAtTargetPerBtc] = eligibleRate;
    const currentBitcoinHeight = bitcoinTip?.blockHeight ?? 0;
    const remainingCoverageByVaultId = new Map<number, bigint>();
    const maximumSatoshisByLockId: Record<number, bigint> = {};
    const currentAllocations: CurrentAllocation[] = [];
    let capacityChanged = false;

    for (const [index, input] of allocations.entries()) {
      const { lock: localLock, satoshis } = input;
      const lockId = localLock.lockId;
      const lock = currentLocks[index];
      if (lockId == null || !lock) {
        throw new BitcoinLiquidCreateStateChangedError('Some of this Bitcoin is no longer available on Argon.');
      }
      if (lock.ownerAccount !== txSigner.address) {
        throw new Error(`Bitcoin Lock #${lockId} belongs to a different account.`);
      }
      if (releaseRequests[index]) {
        throw new BitcoinLiquidCreateStateChangedError(`Bitcoin Lock #${lockId} is already being returned.`);
      }

      let vault: Vault;
      try {
        vault = await Vault.get(snapshotClient, lock.vaultId, NetworkConfig.tickMillis);
      } catch {
        throw new BitcoinLiquidCreateStateChangedError(`The vault for Bitcoin Lock #${lockId} is unavailable.`);
      }
      this.vaults.vaultsById[vault.vaultId] = vault;
      const remainingCoverage =
        remainingCoverageByVaultId.get(vault.vaultId) ?? vault.availableBitcoinSpace(txSigner.address);
      const lockRate = bigIntMax(lock.microgonsAtTargetPerBtc, microgonsAtTargetPerBtc);
      const maximumSatoshis = this.getMaximumSatoshis(lock, priceIndex, lockRate, remainingCoverage);
      maximumSatoshisByLockId[lockId] = maximumSatoshis;
      if (satoshis > maximumSatoshis) {
        capacityChanged = true;
      }

      const acceptedSatoshis = bigIntMin(satoshis, maximumSatoshis);
      const securitizedSatoshis = bigIntMax(lock.securitizedSatoshis, lock.fissionedSatoshis + acceptedSatoshis);
      const replacementCoverageMicrogons = BitcoinLock.calculateLiquidityPromised({
        priceIndex,
        satoshis: securitizedSatoshis,
        microgonsAtTargetPerBtc: lockRate,
      });
      const additionalCoverageMicrogons = bigIntMax(
        replacementCoverageMicrogons - lock.securitizationCoverageMicrogons,
        0n,
      );
      remainingCoverageByVaultId.set(vault.vaultId, remainingCoverage - additionalCoverageMicrogons);
      currentAllocations.push({
        input: { ...input, satoshis: acceptedSatoshis },
        lock,
        vault,
        maximumSatoshis,
        securitizedSatoshis,
        microgonsAtTargetPerBtc: lockRate,
        totalSecurityFee: BitcoinLock.calculateResecuritizationFee({
          vault,
          currentCoverageMicrogons: lock.securitizationCoverageMicrogons,
          replacementCoverageMicrogons,
          createdAtBitcoinHeight: lock.createdAtHeight,
          vaultClaimBitcoinHeight: lock.vaultClaimHeight,
          currentBitcoinHeight,
        }),
      });
    }

    if (capacityChanged) {
      throw new BitcoinLiquidCreateStateChangedError(
        'The selected vaults can no longer insure the full selected Bitcoin amount.',
        maximumSatoshisByLockId,
      );
    }

    return {
      client,
      snapshotBlockHash: finalizedHead.toHex(),
      priceIndex,
      currentBitcoinHeight,
      nextFissionId,
      microgonsAtTargetPerBtc,
      microgonsAtTargetPerBtcTick: Number(microgonsAtTargetPerBtcTick),
      allocations: currentAllocations,
    };
  }

  private getMaximumSatoshis(
    lock: BitcoinLock,
    priceIndex: PriceIndex,
    microgonsAtTargetPerBtc: bigint,
    availableCoverageMicrogons: bigint,
  ): bigint {
    const availableSatoshis = bigIntMax(lock.fundedSatoshis - lock.fissionedSatoshis, 0n);
    const canSecuritize = (allocationSatoshis: bigint) => {
      const securitizedSatoshis = bigIntMax(lock.securitizedSatoshis, lock.fissionedSatoshis + allocationSatoshis);
      const coverage = BitcoinLock.calculateLiquidityPromised({
        priceIndex,
        satoshis: securitizedSatoshis,
        microgonsAtTargetPerBtc,
      });
      return bigIntMax(coverage - lock.securitizationCoverageMicrogons, 0n) <= availableCoverageMicrogons;
    };
    if (canSecuritize(availableSatoshis)) return availableSatoshis;

    let lower = 0n;
    let upper = availableSatoshis;
    while (lower + 1n < upper) {
      const middle = (lower + upper) / 2n;
      if (canSecuritize(middle)) lower = middle;
      else upper = middle;
    }
    return lower;
  }

  private getAvailableFeeCreditByCouponId(allocations: CurrentAllocation[]): Map<number, bigint> {
    const plannedLockIds = new Set(allocations.map(({ lock }) => lock.lockId));
    const availableByCouponId = new Map<number, bigint>();
    for (const { input } of allocations) {
      const { operatorCoupon } = input;
      if (!operatorCoupon || availableByCouponId.has(operatorCoupon.coupon.id)) continue;
      const resumableCredit =
        operatorCoupon.uses?.reduce((total, use) => {
          return use.status === 'Prepared' && use.feeCoupon && use.utxoId != null && plannedLockIds.has(use.utxoId)
            ? total + use.feeCreditMicrogons
            : total;
        }, 0n) ?? 0n;
      availableByCouponId.set(
        operatorCoupon.coupon.id,
        (operatorCoupon.remainingFeeCreditMicrogons ?? 0n) + resumableCredit,
      );
    }
    return availableByCouponId;
  }

  private async failResecuritizations(resecuritizations: IBitcoinResecuritizationMetadata[]): Promise<void> {
    await Promise.all(resecuritizations.map(metadata => this.bitcoinLockResecuritize.failResecuritization(metadata)));
  }
}
