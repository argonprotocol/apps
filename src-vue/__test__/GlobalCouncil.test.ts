import { describe, expect, it, vi } from 'vitest';
import { GlobalCouncil } from '../lib/GlobalCouncil.ts';
import { getEthereumFinalityMillis } from '../lib/EthereumClient.ts';

describe('GlobalCouncil', () => {
  it('relays immediately when our signed approvals are awaiting Ethereum relay', async () => {
    const globalCouncil = new GlobalCouncil(Promise.resolve({} as any), {} as any, {} as any);
    const getReadyGatewayRelayPreview = vi
      .spyOn(globalCouncil, 'getReadyGatewayRelayPreview')
      .mockResolvedValue({ canRelay: true } as any);
    const relayApprovedGatewayUpdates = vi
      .spyOn(globalCouncil, 'relayApprovedGatewayUpdates')
      .mockResolvedValue({ transactionHash: '0x1234' } as any);
    const syncApprovedGatewayRelay = (
      globalCouncil as unknown as {
        syncApprovedGatewayRelay: (args: {
          councilSigner?: string;
          hasSignedApprovalsAwaitingRelay: boolean;
          sharedRelayQueueKey?: string;
        }) => Promise<void>;
      }
    ).syncApprovedGatewayRelay.bind(globalCouncil);

    await syncApprovedGatewayRelay({
      councilSigner: '0xabc',
      hasSignedApprovalsAwaitingRelay: true,
      sharedRelayQueueKey: undefined,
    });

    expect(getReadyGatewayRelayPreview).not.toHaveBeenCalled();
    expect(relayApprovedGatewayUpdates).toHaveBeenCalledTimes(1);
  });

  it('waits before relaying a shared ready batch that is not ours', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-02T17:00:00Z'));

    try {
      const globalCouncil = new GlobalCouncil(Promise.resolve({} as any), {} as any, {} as any);
      const getReadyGatewayRelayPreview = vi.spyOn(globalCouncil, 'getReadyGatewayRelayPreview').mockResolvedValue({
        canRelay: true,
        firstQueueNonce: 9n,
        lastQueueNonce: 9n,
        updateCount: 1,
      } as any);
      const relayApprovedGatewayUpdates = vi
        .spyOn(globalCouncil, 'relayApprovedGatewayUpdates')
        .mockResolvedValue({ transactionHash: '0x1234' } as any);
      const syncApprovedGatewayRelay = (
        globalCouncil as unknown as {
          syncApprovedGatewayRelay: (args: {
            councilSigner?: string;
            hasSignedApprovalsAwaitingRelay: boolean;
            sharedRelayQueueKey?: string;
          }) => Promise<void>;
        }
      ).syncApprovedGatewayRelay.bind(globalCouncil);

      await syncApprovedGatewayRelay({
        councilSigner: '0xabc',
        hasSignedApprovalsAwaitingRelay: false,
        sharedRelayQueueKey: '9:9',
      });
      await vi.advanceTimersByTimeAsync(getEthereumFinalityMillis() * 3);
      await syncApprovedGatewayRelay({
        councilSigner: '0xabc',
        hasSignedApprovalsAwaitingRelay: false,
        sharedRelayQueueKey: '9:9',
      });

      expect(getReadyGatewayRelayPreview).toHaveBeenCalledTimes(1);
      expect(relayApprovedGatewayUpdates).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
