import { computed, onScopeDispose, ref, shallowRef, watch } from 'vue';
import { defineStore } from 'pinia';
import historyData from '../../core/src/data/stabilizerBuys.mainnet.json';
import type IStabilizerBuyData from '../../core/src/interfaces/IStabilizerBuyData.ts';
import { bigNumberToBigInt, StabilizerBuy, UnitOfMeasurement } from '@argonprotocol/apps-core';
import { getStabilizerBuys, getStabilizerBuyAlerts, getStabilizerBuyPurchases } from './stabilizerBuys.ts';
import { getMiningFrames } from './mainchain.ts';
import { useFinancials } from './financials.ts';
import { getWalletsForEthereum } from './wallets.ts';
import { getConfig } from './config.ts';
import { getBitcoinFissions, getBitcoinLocks } from './bitcoin.ts';
import {
  calculateStabilizerBuyReturn,
  getStabilizerBuyReturnedSatoshis,
  projectStabilizerBuyPendingPaydowns,
} from '../lib/financials/StabilizerBuys.ts';
import { StabilizerBuyPurchases } from '../lib/StabilizerBuyPurchases.ts';
import { StabilizerBuys } from '../lib/StabilizerBuys.ts';
import { getCurrency } from './currency.ts';
import type { BitcoinLiquid } from '../lib/BitcoinLiquid.ts';

export const useMarketStabilizers = defineStore('marketStabilizers', () => {
  const buys = getStabilizerBuys();
  const frames = getMiningFrames();
  const financials = useFinancials();
  const ethereumWallets = getWalletsForEthereum();
  const config = getConfig();
  const bitcoinFissions = getBitcoinFissions();
  const bitcoinLocks = getBitcoinLocks();
  const currency = getCurrency();

  const liquids = computed(() => bitcoinFissions.getLiquids());
  const availableLiquids = computed(() => liquids.value.filter(liquid => !liquid.isClosed && liquid.satoshis > 0n));
  const liquidRepaymentWindows = computed(() => {
    const holdFrames = buys.data.market?.purchaseHoldFrames;
    return new Map(
      availableLiquids.value.map(liquid => [
        liquid.liquidId,
        holdFrames === undefined ? undefined : liquid.hasRepaymentWindow(bitcoinLocks, holdFrames),
      ]),
    );
  });
  const frameRevision = ref(0);
  const unsubscribe = frames.events.on('on-tick', () => frameRevision.value++);
  onScopeDispose(unsubscribe);

  const wallets = computed(() => [...ethereumWallets.persistedWallets]);

  const hasBuyHistory = computed(
    () => buys.data.buys.length > 0 || buys.data.frameRewards.length > 0 || buys.data.positions.length > 0,
  );
  const hasAccess = computed(() => hasBuyHistory.value || (config.isLoaded && config.hasActivatedStabilizerBuys));
  const canActivate = computed(
    () =>
      config.isLoaded &&
      wallets.value.some(wallet => {
        if (!wallet.data.balanceUpdatedAt || wallet.data.balanceIsCached || wallet.data.fetchErrorMsg) return false;

        const usdc = wallet.data.otherTokens.find(token => token.unitOfMeasurement === UnitOfMeasurement.USDC);
        const eth = wallet.data.otherTokens.find(token => token.unitOfMeasurement === UnitOfMeasurement.ETH);
        return (usdc?.value ?? 0n) > 0n && (eth?.value ?? 0n) > 0n;
      }),
  );

  async function activate(): Promise<boolean> {
    if (!hasAccess.value && !canActivate.value) return false;

    await config.activateStabilizerBuys();
    return true;
  }

  watch(
    [() => config.isLoaded, hasBuyHistory],
    ([isConfigLoaded, hasHistory]) => {
      if (!isConfigLoaded || !hasHistory) return;

      void config.activateStabilizerBuys().catch(error => {
        console.error('[MarketStabilizers] Unable to preserve access from buy history', error);
      });
    },
    { immediate: true },
  );

  const availableUsdc = computed(() => {
    let total = 0n;
    for (const wallet of wallets.value) {
      if (!wallet.data.balanceUpdatedAt || wallet.data.balanceIsCached || wallet.data.fetchErrorMsg) return;

      const usdc = wallet.data.otherTokens.find(token => token.unitOfMeasurement === UnitOfMeasurement.USDC);
      total += usdc?.value ?? 0n;
    }

    return total;
  });

  const summary = computed(() => financials.financialPositionAggregate.groupSummaries.stabilizer);
  const closedAuctionBids = computed(() => {
    const rewards = new Map<number, ReturnType<typeof StabilizerBuy.allocateBids>[number]>();
    const inclusionPercent = buys.data.market?.auctionInclusionPercent;
    if (!inclusionPercent) return rewards;

    for (const [key, snapshot] of Object.entries(buys.data.auctionsByFrame ?? {})) {
      const frame = Number(key);
      if (buys.data.currentFrameId < frame + 2 || snapshot.observedAtFrame < frame + 2) continue;

      const bids = StabilizerBuy.allocateBids(snapshot.bids, snapshot.auction, inclusionPercent);
      const own = bids.find(bid => bid.ownerAccount === buys.accountAddress);
      if (own) rewards.set(frame, own);
    }
    return rewards;
  });
  const liquidPaydowns = computed(() => {
    const lockExpirations = new Map<number, number>();
    for (const liquid of liquids.value) {
      for (const fission of liquid.fissions) {
        const lock = bitcoinLocks.getLockById(fission.lockId)?.scriptDetails;
        if (lock) lockExpirations.set(fission.lockId, lock.vaultClaimHeight);
      }
    }
    const forecasts = projectStabilizerBuyPendingPaydowns({
      positions: buys.data.positions,
      liquids: liquids.value,
      lockExpirations,
      priceIndex: currency.priceIndex,
    });
    return buys.data.buys
      .filter(buy => StabilizerBuys.getRequestedLiquidId(buy) !== undefined)
      .map(buy => {
        const liquid = liquids.value.find(liquid => liquid.liquidId === StabilizerBuys.getRequestedLiquidId(buy));
        const position = buys.data.positions.find(position => position.admissionFrame === buy.admissionFrame);
        const repayment = position?.liquidRepayments.find(
          repayment => buy.gatewayTransferId === `Ethereum:${repayment.gatewayActivityNonce}`,
        );
        const estimate = repayment ? forecasts.byNonce.get(repayment.gatewayActivityNonce) : undefined;
        const rewardRate =
          position?.purchase.liquidRepaymentRewardRate ??
          closedAuctionBids.value.get(buy.admissionFrame!)?.liquidRepaymentRewardRate;
        let potentialBonus: bigint | undefined;
        if (estimate && repayment && rewardRate) {
          potentialBonus = bigNumberToBigInt(
            repayment.eligibleRewardPercent.times(rewardRate).times(estimate.burnedMicrogons),
          );
        }
        const returnedSatoshis = liquid ? getStabilizerBuyReturnedSatoshis(buy, liquid) : undefined;
        let repaymentState: ReturnType<BitcoinLiquid['getRepaymentState']> | typeof estimate;
        if (buy.liquidRepaymentEvent) {
          if (liquid && returnedSatoshis !== undefined) {
            repaymentState = liquid.getRepaymentState(buy.liquidRepaymentEvent.blockNumber);
          }
        } else repaymentState = estimate;
        return {
          buy,
          liquid,
          estimate,
          potentialBonus,
          returnedSatoshis,
          repaymentState,
        };
      });
  });
  const returns = computed(() => {
    const byFrame: Record<number, ReturnType<typeof calculateStabilizerBuyReturn>> = {};
    const byPurchase: Record<string, ReturnType<typeof calculateStabilizerBuyReturn>> = {};

    for (const position of summary.value.positions) {
      if (position.kind !== 'stabilizer-buy') continue;

      let periodDays = buys.data.market?.purchaseHoldFrames;
      const frame = position.admissionFrame;
      if (frame !== undefined) {
        const rewards = buys.data.frameRewards.find(rewards => rewards.admissionFrame === frame);
        const maturesAtFrame = rewards?.maturesAtFrame ?? buys.data.auctionsByFrame[frame]?.auction.maturesAtFrame;
        if (maturesAtFrame !== undefined) periodDays = maturesAtFrame - frame;
      }

      const rewards = buys.data.frameRewards.find(rewards => rewards.admissionFrame === frame);
      let expectedReward: bigint | undefined;
      if (frame !== undefined && rewards?.awardedReward === undefined) {
        expectedReward = closedAuctionBids.value.get(frame)?.fundingEstimate;
      }
      const paydowns = liquidPaydowns.value.filter(paydown => paydown.buy.admissionFrame === frame);
      const potentialLiquidBonus = paydowns.reduce((sum, paydown) => sum + (paydown.potentialBonus ?? 0n), 0n);
      const result = calculateStabilizerBuyReturn({
        position,
        group: summary.value,
        periodDays,
        expectedReward,
        potentialLiquidBonus,
      });
      if (position.admissionFrame !== undefined) {
        byFrame[position.admissionFrame] = result;
        continue;
      }

      const buy = buys.data.buys.find(buy => position.id === `stabilizer:${buys.accountAddress}:${buy.id}`);
      if (buy) byPurchase[buy.id] = result;
    }

    return { byFrame, byPurchase };
  });

  const dates = computed(() => {
    void frameRevision.value;

    const admission: Record<number, Date> = {};
    const opens: Record<number, Date> = {};
    const closes: Record<number, Date> = {};
    const releases: Record<number, Date> = {};
    if (!frames.framesById[frames.currentFrameId]) return { admission, opens, closes, releases };

    const frameIds = new Set([
      buys.data.currentFrameId,
      ...buys.data.frameRewards.map(rewards => rewards.admissionFrame),
    ]);

    for (const frame of frameIds) {
      const rewards = buys.data.frameRewards.find(rewards => rewards.admissionFrame === frame);

      if (frames.framesById[frame]) admission[frame] = frames.getFrameDate(frame);
      opens[frame] = frames.getFrameDate(frame + 1);
      closes[frame] = frames.getFrameDate(frame + 2);

      if (rewards?.maturesAtFrame !== undefined) {
        releases[frame] = frames.getFrameDate(rewards.maturesAtFrame);
      } else if (buys.data.market) {
        releases[frame] = frames.getFrameDate(frame + buys.data.market.purchaseHoldFrames);
      }
    }

    return { admission, opens, closes, releases };
  });

  const purchaseProgressById = computed(() => {
    void frameRevision.value;
    const transactions = getStabilizerBuyPurchases()?.data.transactionProgressByHash ?? {};
    return Object.fromEntries(
      buys.data.buys.map(buy => [
        buy.id,
        StabilizerBuyPurchases.getProgress(buy, transactions, buys.data.ethereumGatewaySync),
      ]),
    );
  });
  const progressByPurchaseId = computed(() =>
    Object.fromEntries(
      Object.entries(purchaseProgressById.value).map(([id, progress]) => [id, progress.overallProgressPct]),
    ),
  );

  const opportunity = computed(() => getStabilizerBuyAlerts()?.opportunity);
  const buyDiscountPercent = computed(() => buys.buyDiscountPercent);
  const alertError = computed(() => getStabilizerBuyAlerts()?.data.error);
  const biddingFrame = computed(
    () => buys.data.positions.find(position => position.isBiddingOpen(buys.data.currentFrameId))?.admissionFrame,
  );

  return {
    data: shallowRef(buys.data),
    history: historyData as IStabilizerBuyData,
    config,
    summary,
    returns,
    closedAuctionBids,
    liquidPaydowns,
    dates,
    wallets,
    liquids,
    availableLiquids,
    liquidRepaymentWindows,
    hasAccess,
    canActivate,
    activate,
    availableUsdc,
    progressByPurchaseId,
    purchaseProgressById,
    biddingFrame,
    opportunity,
    buyDiscountPercent,
    alertError,
  };
});
