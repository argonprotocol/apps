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
    expect(relayApprovedGatewayUpdates).toHaveBeenCalledWith({ allowUncompensatedRelay: true });
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

  it('falls back to the shared relay path when signed approvals are not ours', async () => {
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
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce({ transactionHash: '0x1234' } as any);
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
        sharedRelayQueueKey: '9:9',
      });
      await vi.advanceTimersByTimeAsync(getEthereumFinalityMillis() * 3);
      await syncApprovedGatewayRelay({
        councilSigner: '0xabc',
        hasSignedApprovalsAwaitingRelay: true,
        sharedRelayQueueKey: '9:9',
      });

      expect(getReadyGatewayRelayPreview).toHaveBeenCalledTimes(1);
      expect(relayApprovedGatewayUpdates).toHaveBeenNthCalledWith(1, { allowUncompensatedRelay: true });
      expect(relayApprovedGatewayUpdates).toHaveBeenNthCalledWith(2, { allowUncompensatedRelay: true });
      expect(relayApprovedGatewayUpdates).toHaveBeenNthCalledWith(3);
      expect(relayApprovedGatewayUpdates).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('includes deactivation approvals in the pending queue', async () => {
    const globalCouncil = new GlobalCouncil(
      Promise.resolve({
        walletHdKeysTable: {
          upsert: vi.fn(async () => undefined),
        },
      } as any),
      {
        councilSignerEthereumHdPath: `m/44'/60'/1'/0'`,
        vaultingAddress: '5vault',
        getEthereumAddresses: vi.fn(async () => ['0xabc']),
      } as any,
      {} as any,
    );
    const syncApprovedGatewayRelay = vi
      .spyOn(
        globalCouncil as unknown as {
          syncApprovedGatewayRelay: (args: {
            councilSigner?: string;
            hasSignedApprovalsAwaitingRelay: boolean;
            sharedRelayQueueKey?: string;
          }) => Promise<void>;
        },
        'syncApprovedGatewayRelay',
      )
      .mockResolvedValue(undefined);

    const approvalHashOne = { toHex: () => '0x11' };
    const approvalHashTwo = { toHex: () => '0x22' };
    const finalizedClient = {
      query: {
        crosschainTransfer: {
          councilSignerByDestinationChainAndAccountId: vi.fn(async () => some(hexValue('0xabc'))),
          councilApprovalCursorByDestinationChainAndAccountId: vi.fn(async () => some(bigintValue(0n))),
          gatewayStateBySourceChain: vi.fn(async () => some({ argonApprovalsNonce: bigintValue(0n) })),
          nextCouncilApprovalQueueNonceByDestinationChain: vi.fn(async () => bigintValue(2n)),
          councilApprovalQueueByDestinationChainAndNonce: vi.fn(async (_chain: string, nonce: bigint) => {
            if (nonce === 1n) {
              return some({
                target: {
                  isMintingAuthorityActivation: true,
                  isMintingAuthorityDeactivation: false,
                },
                approvalHash: approvalHashOne,
              });
            }
            if (nonce === 2n) {
              return some({
                target: {
                  isMintingAuthorityActivation: false,
                  isMintingAuthorityDeactivation: true,
                },
                approvalHash: approvalHashTwo,
              });
            }
            return none();
          }),
        },
      },
    };

    await expect(globalCouncil.refresh(finalizedClient as any)).resolves.toEqual([
      { approvalHash: '0x11' },
      { approvalHash: '0x22' },
    ]);
    expect(syncApprovedGatewayRelay).toHaveBeenCalledWith({
      councilSigner: '0xabc',
      hasSignedApprovalsAwaitingRelay: false,
      sharedRelayQueueKey: undefined,
    });
  });

  it('keeps the shared relay queue key when signed approvals are already awaiting Ethereum relay', async () => {
    const globalCouncil = new GlobalCouncil(
      Promise.resolve({
        walletHdKeysTable: {
          upsert: vi.fn(async () => undefined),
        },
      } as any),
      {
        councilSignerEthereumHdPath: `m/44'/60'/1'/0'`,
        vaultingAddress: '5vault',
        getEthereumAddresses: vi.fn(async () => ['0xabc']),
      } as any,
      {} as any,
    );
    const syncApprovedGatewayRelay = vi
      .spyOn(
        globalCouncil as unknown as {
          syncApprovedGatewayRelay: (args: {
            councilSigner?: string;
            hasSignedApprovalsAwaitingRelay: boolean;
            sharedRelayQueueKey?: string;
          }) => Promise<void>;
        },
        'syncApprovedGatewayRelay',
      )
      .mockResolvedValue(undefined);

    const finalizedClient = {
      query: {
        crosschainTransfer: {
          councilSignerByDestinationChainAndAccountId: vi.fn(async () => some(hexValue('0xabc'))),
          councilApprovalCursorByDestinationChainAndAccountId: vi.fn(async () => some(bigintValue(2n))),
          gatewayStateBySourceChain: vi.fn(async () => some({ argonApprovalsNonce: bigintValue(1n) })),
          nextCouncilApprovalQueueNonceByDestinationChain: vi.fn(async () => bigintValue(2n)),
          councilApprovalQueueByDestinationChainAndNonce: vi.fn(async () => none()),
        },
      },
    };

    await expect(globalCouncil.refresh(finalizedClient as any)).resolves.toEqual([]);
    expect(syncApprovedGatewayRelay).toHaveBeenCalledWith({
      councilSigner: '0xabc',
      hasSignedApprovalsAwaitingRelay: true,
      sharedRelayQueueKey: '1:2',
    });
  });
});

function bigintValue(value: bigint) {
  return {
    toBigInt: () => value,
  };
}

function hexValue(value: string) {
  return {
    toHex: () => value,
    toLowerCase: () => value.toLowerCase(),
  };
}

function some<T>(value: T) {
  return {
    isSome: true,
    isNone: false,
    unwrap: () => value,
  };
}

function none() {
  return {
    isSome: false,
    isNone: true,
  };
}
