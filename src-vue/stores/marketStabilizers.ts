import { computed, onScopeDispose, ref, shallowRef, watch } from 'vue';
import { defineStore } from 'pinia';
import historyData from '../../core/src/data/stabilizerBuys.mainnet.json';
import type IStabilizerBuyData from '../../core/src/interfaces/IStabilizerBuyData.ts';
import { UnitOfMeasurement } from '@argonprotocol/apps-core';
import { getStabilizerBuys, getStabilizerBuyAlerts, getStabilizerBuyPurchases } from './stabilizerBuys.ts';
import { getMiningFrames } from './mainchain.ts';
import { useFinancials } from './financials.ts';
import { getWalletsForEthereum } from './wallets.ts';
import { getConfig } from './config.ts';
import { calculatePositionReturn } from '../lib/financials/index.ts';
import { StabilizerBuyPurchases } from '../lib/StabilizerBuyPurchases.ts';
import type { IFinancialReturnSummary } from '../interfaces/IFinancialPosition.ts';

export const useMarketStabilizers = defineStore('marketStabilizers', () => {
  const buys = getStabilizerBuys();
  const frames = getMiningFrames();
  const financials = useFinancials();
  const ethereumWallets = getWalletsForEthereum();
  const config = getConfig();

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
  const returns = computed(() => {
    const byFrame: Record<number, IFinancialReturnSummary> = {};
    const byPurchase: Record<string, IFinancialReturnSummary> = {};

    for (const position of summary.value.positions) {
      if (position.kind !== 'stabilizer-buy') continue;

      const result = calculatePositionReturn([position], summary.value);
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
    dates,
    wallets,
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
