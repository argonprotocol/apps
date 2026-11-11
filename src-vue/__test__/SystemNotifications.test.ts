import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { isPermissionGranted, requestPermission, sendNotification, onAction } from '@tauri-apps/plugin-notification';
import { buyOpportunity, bidOpportunity } from './helpers/stabilizerBuy.ts';
import { PluginListener } from '@tauri-apps/api/core';

vi.mock('@tauri-apps/api/core', async importOriginal => ({
  ...(await importOriginal<typeof import('@tauri-apps/api/core')>()),
  isTauri: () => true,
}));

vi.mock('@tauri-apps/plugin-notification', () => ({
  isPermissionGranted: vi.fn(),
  requestPermission: vi.fn(),
  sendNotification: vi.fn(),
  onAction: vi.fn(),
}));
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.mocked(onAction).mockResolvedValue(new PluginListener('notification', 'actionPerformed', 1));
});
afterEach(() => vi.restoreAllMocks());

it('shares a pending permission request and sends market and bidding opportunities', async () => {
  vi.mocked(isPermissionGranted).mockResolvedValue(false);
  vi.mocked(requestPermission).mockResolvedValue('granted');
  const { notifyStabilizerBuyOpportunity } = await import('../lib/SystemNotifications.ts');
  await Promise.all([
    notifyStabilizerBuyOpportunity(() => ({ ...buyOpportunity, apy: 57.8 })),
    notifyStabilizerBuyOpportunity(() => bidOpportunity),
  ]);
  expect(requestPermission).toHaveBeenCalledTimes(1);
  expect(vi.mocked(sendNotification).mock.calls.map(([notification]) => notification)).toEqual([
    {
      id: 1,
      extra: { stabilizerBuyNoticeKey: buyOpportunity.key, expiresAt: buyOpportunity.expiresAt },
      title: 'ARGN is below target',
      body: '58% estimated APY · 8% below target. Current quote: 110 ARGN.',
    },
    {
      id: 2,
      extra: { stabilizerBuyNoticeKey: bidOpportunity.key, expiresAt: undefined },
      title: 'Stabilizer Buy bonus bid at risk',
      body: 'Your 100% bid currently qualifies for an estimated ₳12.00 of ₳40.00 in bonuses. Review your bid in Market Stabilizers before bidding closes.',
    },
  ]);
});

it('respects permission denial and checks permission again for a later opportunity', async () => {
  vi.mocked(isPermissionGranted).mockResolvedValue(false);
  vi.mocked(requestPermission).mockResolvedValue('denied');
  const { notifyStabilizerBuyOpportunity } = await import('../lib/SystemNotifications.ts');
  await notifyStabilizerBuyOpportunity(() => buyOpportunity);
  expect(sendNotification).not.toHaveBeenCalled();

  vi.mocked(isPermissionGranted).mockResolvedValue(true);
  await notifyStabilizerBuyOpportunity(() => bidOpportunity);
  expect(sendNotification).toHaveBeenCalledWith({
    id: 2,
    extra: { stabilizerBuyNoticeKey: bidOpportunity.key, expiresAt: undefined },
    title: 'Stabilizer Buy bonus bid at risk',
    body: 'Your 100% bid currently qualifies for an estimated ₳12.00 of ₳40.00 in bonuses. Review your bid in Market Stabilizers before bidding closes.',
  });
});

it('waits for desktop click registration and withholds a notice that expires during the permission prompt', async () => {
  let ready!: (listener: Awaited<ReturnType<typeof onAction>>) => void;
  vi.mocked(onAction).mockReturnValueOnce(
    new Promise(resolve => {
      ready = resolve;
    }),
  );
  vi.mocked(isPermissionGranted).mockResolvedValue(false);
  let finishPermission!: (permission: Awaited<ReturnType<typeof requestPermission>>) => void;
  vi.mocked(requestPermission).mockReturnValueOnce(
    new Promise(resolve => {
      finishPermission = resolve;
    }),
  );
  let isCurrent = true;
  const { notifyStabilizerBuyOpportunity } = await import('../lib/SystemNotifications.ts');
  const pending = notifyStabilizerBuyOpportunity(() => (isCurrent ? buyOpportunity : undefined));
  await vi.waitFor(() => expect(onAction).toHaveBeenCalledOnce());
  expect(requestPermission).not.toHaveBeenCalled();
  expect(sendNotification).not.toHaveBeenCalled();

  ready(new PluginListener('notification', 'actionPerformed', 1));
  await vi.waitFor(() => expect(requestPermission).toHaveBeenCalledOnce());
  isCurrent = false;
  finishPermission('granted');
  await pending;
  expect(sendNotification).not.toHaveBeenCalled();
});
