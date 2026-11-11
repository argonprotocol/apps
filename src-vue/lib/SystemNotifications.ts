import { isTauri } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { SingleFileQueue } from '@argonprotocol/apps-core';
import { isPermissionGranted, requestPermission, sendNotification, onAction } from '@tauri-apps/plugin-notification';
import type { IStabilizerBuyOpportunity } from '../interfaces/IStabilizerBuyPurchase.ts';
import { formatUnits } from 'viem';
import numeral from './numeral.ts';
import basicEmitter from '../emitters/basicEmitter.ts';

let permissionRequest: ReturnType<typeof requestPermission> | undefined;
let notificationListener: ReturnType<typeof onAction> | undefined;

export async function notifyStabilizerBuyOpportunity(
  getNotice: () => IStabilizerBuyOpportunity | undefined,
): Promise<void> {
  if (!isTauri() || !getNotice()) return;

  // Desktop click payloads are tracked only when a listener exists before delivery.
  if (!notificationListener) {
    const listener = onAction(event => {
      const extra = event.notification?.extra;
      const key = extra?.stabilizerBuyNoticeKey;
      const expiresAt = extra?.expiresAt;
      if (event.actionId !== 'tap' || typeof key !== 'string') return;
      if (expiresAt !== undefined && typeof expiresAt !== 'number') return;

      void (async () => {
        const window = getCurrentWindow();
        await window.unminimize();
        await window.show();
        await window.setFocus();
        basicEmitter.emit('openStabilizerBuyNotice', { key, expiresAt });
      })().catch(error => console.warn('[Notifications] Unable to open the notice', error));
    });
    notificationListener = listener;
    void listener.catch(() => {
      if (notificationListener === listener) notificationListener = undefined;
    });
  }
  await notificationListener;

  if (!(await isPermissionGranted())) {
    permissionRequest ??= requestPermission().finally(() => {
      permissionRequest = undefined;
    });
    if ((await permissionRequest) !== 'granted') return;
  }

  const opportunity = getNotice();
  if (!opportunity) return;
  const options = {
    id: opportunity.type === 'buy' ? 1 : 2,
    extra: { stabilizerBuyNoticeKey: opportunity.key, expiresAt: opportunity.expiresAt },
  };

  if (opportunity.type === 'buy') {
    const apy = numeral(opportunity.apy).formatIfElse(Math.abs(opportunity.apy) < 10, '0,0.[0]', '0,0');
    const discount = numeral(opportunity.discountPercent).formatIfElse(
      Math.abs(opportunity.discountPercent) < 10,
      '0,0.[0]',
      '0,0',
    );
    const amount = numeral(formatUnits(opportunity.quote.quotedMicrogonsOut, 6)).format('0,0.[00]');

    sendNotification({
      ...options,
      title: 'ARGN is below target',
      body: `${apy}% estimated APY · ${discount}% below target. Current quote: ${amount} ARGN.`,
    });
  } else {
    const bid = opportunity.bid;
    if (!bid) return;
    const funded = numeral(formatUnits(bid.fundingEstimate, 6)).format('0,0.00');
    const fullReward = numeral(formatUnits(bid.requestedReward, 6)).format('0,0.00');

    sendNotification({
      ...options,
      title: 'Stabilizer Buy bonus bid at risk',
      body: `Your ${bid.latestBid}% bid currently qualifies for an estimated ₳${funded} of ₳${fullReward} in bonuses. Review your bid in Market Stabilizers before bidding closes.`,
    });
  }
}

const badgeUpdates = new SingleFileQueue();

/** One app-wide publisher prevents asynchronous counts from overwriting a newer badge. */
export async function updateAppBadge(count: number): Promise<void> {
  if (!isTauri()) return;
  await badgeUpdates.add(() => getCurrentWindow().setBadgeCount(count || undefined)).promise;
}
