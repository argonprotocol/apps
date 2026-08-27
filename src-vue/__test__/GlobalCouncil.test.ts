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
          hasReadyGatewayUpdates: boolean;
          sharedRelayQueueKey?: string;
        }) => Promise<void>;
      }
    ).syncApprovedGatewayRelay.bind(globalCouncil);

    await syncApprovedGatewayRelay({
      councilSigner: '0xabc',
      hasReadyGatewayUpdates: true,
      sharedRelayQueueKey: undefined,
    });

    expect(getReadyGatewayRelayPreview).not.toHaveBeenCalled();
    expect(relayApprovedGatewayUpdates).toHaveBeenCalledTimes(1);
    expect(relayApprovedGatewayUpdates).toHaveBeenCalledWith({
      allowUncompensatedRelay: true,
      onlyThroughOwnedUpdate: true,
    });
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
            hasReadyGatewayUpdates: boolean;
            sharedRelayQueueKey?: string;
          }) => Promise<void>;
        }
      ).syncApprovedGatewayRelay.bind(globalCouncil);

      await syncApprovedGatewayRelay({
        councilSigner: '0xabc',
        hasReadyGatewayUpdates: false,
        sharedRelayQueueKey: '9:9',
      });
      await vi.advanceTimersByTimeAsync(getEthereumFinalityMillis() * 3);
      await syncApprovedGatewayRelay({
        councilSigner: '0xabc',
        hasReadyGatewayUpdates: false,
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
            hasReadyGatewayUpdates: boolean;
            sharedRelayQueueKey?: string;
          }) => Promise<void>;
        }
      ).syncApprovedGatewayRelay.bind(globalCouncil);

      await syncApprovedGatewayRelay({
        councilSigner: '0xabc',
        hasReadyGatewayUpdates: true,
        sharedRelayQueueKey: '9:9',
      });
      await vi.advanceTimersByTimeAsync(getEthereumFinalityMillis() * 3);
      await syncApprovedGatewayRelay({
        councilSigner: '0xabc',
        hasReadyGatewayUpdates: true,
        sharedRelayQueueKey: '9:9',
      });

      expect(getReadyGatewayRelayPreview).toHaveBeenCalledTimes(1);
      expect(relayApprovedGatewayUpdates).toHaveBeenNthCalledWith(1, {
        allowUncompensatedRelay: true,
        onlyThroughOwnedUpdate: true,
      });
      expect(relayApprovedGatewayUpdates).toHaveBeenNthCalledWith(2, {
        allowUncompensatedRelay: true,
        onlyThroughOwnedUpdate: true,
      });
      expect(relayApprovedGatewayUpdates).toHaveBeenNthCalledWith(3);
      expect(relayApprovedGatewayUpdates).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('describes every pending gateway update', async () => {
    const globalCouncil = new GlobalCouncil(
      Promise.resolve({
        walletHdKeysTable: {
          upsert: vi.fn(async () => undefined),
        },
      } as any),
      {
        councilSignerEthereumHdPath: `m/44'/60'/1'/0'`,
        vaultingAddress: '5existing',
        getEthereumAddresses: vi.fn(async () => ['0xabc']),
      } as any,
      {} as any,
    );
    const syncApprovedGatewayRelay = vi
      .spyOn(
        globalCouncil as unknown as {
          syncApprovedGatewayRelay: (args: {
            councilSigner?: string;
            hasReadyGatewayUpdates: boolean;
            sharedRelayQueueKey?: string;
          }) => Promise<void>;
        },
        'syncApprovedGatewayRelay',
      )
      .mockResolvedValue(undefined);

    const approvalHashOne = '0x11';
    const approvalHashTwo = '0x22';
    const approvalHashThree = '0x33';
    const finalizedClient = {
      query: {
        crosschainTransfer: {
          councilSignerByDestinationChainAndAccountId: vi.fn(async () => some(hexValue('0xabc'))),
          councilApprovalCursorByDestinationChainAndAccountId: vi.fn(async () => some(bigintValue(0n))),
          gatewayStateBySourceChain: vi.fn(async () =>
            some({ argonApprovalsNonce: bigintValue(0n), gatewayActivityNonce: bigintValue(47n) }),
          ),
          nextCouncilApprovalQueueNonceByDestinationChain: vi.fn(async () => bigintValue(33n)),
          activeGlobalIssuanceCouncilByDestinationChain: vi.fn(async () => some(hexValue('0xactive'))),
          transferOutQuoteMicrogonsPerArgonotByDestinationChain: vi.fn(async () => some(bigintValue(750_000n))),
          globalIssuanceCouncilByHash: {
            multi: vi.fn(async (hashes: string[]) =>
              hashes.map(hash =>
                some(
                  council(
                    hash === '0xactive' ? ['5existing', '5leaving'] : ['5existing', '5new-one', '5new-two'],
                    hash === '0xactive' ? 1_000_000n : 2_000_000n,
                  ),
                ),
              ),
            ),
          },
          mintingAuthoritiesBySigner: {
            multi: vi.fn(async (signers: string[]) => signers.map(signer => some({ accountId: `owner-${signer}` }))),
          },
          councilApprovalQueueByDestinationChainAndNonce: {
            multi: vi.fn(async (keys: Array<[string, bigint]>) =>
              keys.map(([, nonce]) => {
                if (nonce === 1n) {
                  return some({
                    approvingCouncilHash: hexValue('0xactive'),
                    approvedTotalWeight: bigintValue(0n),
                    signatures: {},
                    target: { type: 'MintingAuthorityActivation', value: '0xaaaa' },
                    approvalHash: approvalHashOne,
                  });
                }
                if (nonce === 2n) {
                  return some({
                    approvingCouncilHash: hexValue('0xactive'),
                    approvedTotalWeight: bigintValue(0n),
                    signatures: {},
                    target: { type: 'MintingAuthorityDeactivation', value: '0xbbbb' },
                    approvalHash: approvalHashTwo,
                  });
                }
                if (nonce === 3n) {
                  return some({
                    approvingCouncilHash: hexValue('0xactive'),
                    approvedTotalWeight: bigintValue(0n),
                    signatures: {},
                    target: { type: 'GlobalIssuanceCouncilRotation', value: '0xcccc' },
                    approvalHash: approvalHashThree,
                  });
                }
                if (nonce <= 33n) {
                  return some({
                    approvingCouncilHash: hexValue('0xactive'),
                    approvedTotalWeight: bigintValue(0n),
                    signatures: {},
                    target: {
                      type: 'MintingAuthorityActivation',
                      value: `0x${nonce.toString(16).padStart(4, '0')}`,
                    },
                    approvalHash: hexValue(`0x${nonce.toString(16).padStart(2, '0')}`),
                  });
                }
                return none();
              }),
            ),
          },
        },
      },
    };

    const pendingApprovals = await globalCouncil.refresh(finalizedClient as any);

    expect(pendingApprovals.slice(0, 3)).toEqual([
      {
        approvalHash: '0x11',
        queueNonce: 1n,
        targetKind: 'mintingAuthorityActivation',
        targetSigningKey: '0xaaaa',
        authorityOwnerAccount: 'owner-0xaaaa',
      },
      {
        approvalHash: '0x22',
        queueNonce: 2n,
        targetKind: 'mintingAuthorityDeactivation',
        targetSigningKey: '0xbbbb',
        authorityOwnerAccount: 'owner-0xbbbb',
      },
      {
        approvalHash: '0x33',
        queueNonce: 3n,
        targetKind: 'globalIssuanceCouncilRotation',
        targetCouncilHash: '0xcccc',
        councilChange: {
          vaultCount: 3,
          newVaultCount: 2,
          leavingVaultCount: 1,
          epochMicrogonsPerArgonot: 2_000_000n,
        },
      },
    ]);
    expect(pendingApprovals).toHaveLength(33);
    expect(globalCouncil.data.gatewayActivityCount).toBe(47n);
    expect(globalCouncil.data.isActiveCouncilMember).toBe(true);
    expect(globalCouncil.data.activeEpochMicrogonsPerArgonot).toBe(1_000_000n);
    expect(globalCouncil.data.transferOutMicrogonsPerArgonot).toBe(750_000n);
    expect(
      finalizedClient.query.crosschainTransfer.councilApprovalQueueByDestinationChainAndNonce.multi,
    ).toHaveBeenCalledTimes(2);
    expect(syncApprovedGatewayRelay).toHaveBeenCalledWith({
      councilSigner: '0xabc',
      hasReadyGatewayUpdates: false,
      sharedRelayQueueKey: undefined,
    });
  });

  it('signs enriched approvals with their original approval hashes', async () => {
    const signEthereumPersonalMessage = vi.fn(async (approvalHash: string) => `signature-${approvalHash}`);
    const globalCouncil = new GlobalCouncil(
      Promise.resolve({} as any),
      {
        councilSignerEthereumHdPath: `m/44'/60'/1'/0'`,
        signEthereumPersonalMessage,
      } as any,
      {} as any,
    );

    const approveQueueEntries = vi.fn((_chain: string, signatures: string[]) => ({ signatures }));
    await globalCouncil.buildApprovePendingGatewayUpdateTxs(
      {
        consts: { crosschainTransfer: { maxQueueApprovalsPerCall: { toNumber: () => 10 } } },
        createType: vi.fn((_type: string, signatures: string[]) => signatures),
        tx: { crosschainTransfer: { approveQueueEntries } },
      } as any,
      [
        {
          approvalHash: '0x33',
          queueNonce: 3n,
          targetKind: 'globalIssuanceCouncilRotation',
          targetCouncilHash: '0xcccc',
        },
      ],
    );

    expect(signEthereumPersonalMessage).toHaveBeenCalledOnce();
    expect(signEthereumPersonalMessage).toHaveBeenCalledWith('0x33', `m/44'/60'/1'/0'`, 'argon');
  });

  it('marks a signed gateway update ready only after the council reaches quorum', async () => {
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
            hasReadyGatewayUpdates: boolean;
            sharedRelayQueueKey?: string;
          }) => Promise<void>;
        },
        'syncApprovedGatewayRelay',
      )
      .mockResolvedValue(undefined);

    let approvedWeight = 0n;
    const finalizedClient = {
      query: {
        crosschainTransfer: {
          councilSignerByDestinationChainAndAccountId: vi.fn(async () => some(hexValue('0xabc'))),
          councilApprovalCursorByDestinationChainAndAccountId: vi.fn(async () => some(bigintValue(2n))),
          gatewayStateBySourceChain: vi.fn(async () => some({ argonApprovalsNonce: bigintValue(1n) })),
          nextCouncilApprovalQueueNonceByDestinationChain: vi.fn(async () => bigintValue(2n)),
          activeGlobalIssuanceCouncilByDestinationChain: vi.fn(async () => none()),
          transferOutQuoteMicrogonsPerArgonotByDestinationChain: vi.fn(async () => none()),
          globalIssuanceCouncilByHash: {
            multi: vi.fn(async () => [some(council(['5council-member'], 1_000_000n))]),
          },
          mintingAuthoritiesBySigner: {
            multi: vi.fn(async () => [some({ accountId: '5authority-owner' })]),
          },
          councilApprovalQueueByDestinationChainAndNonce: {
            multi: vi.fn(async () => [
              some({
                approvingCouncilHash: hexValue('0xapproving'),
                approvedTotalWeight: bigintValue(approvedWeight),
                signatures: { '0xabc': '0xsig' },
                target: { type: 'MintingAuthorityActivation', value: '0xaaaa' },
                approvalHash: hexValue('0x11'),
              }),
            ]),
          },
        },
      },
    };

    await expect(globalCouncil.refresh(finalizedClient as any)).resolves.toEqual([]);
    expect(globalCouncil.data.approvalQueue).toMatchObject([
      {
        approvalHash: '0x11',
        approvalProgress: {
          approvedWeight: 0n,
          totalWeight: 1n,
          signatureCount: 1,
          memberCount: 1,
        },
        queueNonce: 2n,
        status: 'awaitingCouncilQuorum',
        targetKind: 'mintingAuthorityActivation',
        targetSigningKey: '0xaaaa',
        authorityOwnerAccount: '5authority-owner',
      },
    ]);
    expect(syncApprovedGatewayRelay).toHaveBeenLastCalledWith({
      councilSigner: '0xabc',
      hasReadyGatewayUpdates: false,
      sharedRelayQueueKey: undefined,
    });

    approvedWeight = 1n;
    await globalCouncil.refresh(finalizedClient as any);

    expect(globalCouncil.data.approvalQueue[0]).toMatchObject({
      approvalProgress: { approvedWeight: 1n },
      status: 'readyForRelay',
    });
    expect(syncApprovedGatewayRelay).toHaveBeenLastCalledWith({
      councilSigner: '0xabc',
      hasReadyGatewayUpdates: true,
      sharedRelayQueueKey: '1:2',
    });
  });
});

function bigintValue(value: bigint) {
  return value;
}

function hexValue(value: string) {
  return value;
}

function some<T>(value: T) {
  return value;
}

function none() {
  return null;
}

function council(accountIds: string[], epochMicrogonsPerArgonot: bigint) {
  return {
    members: Object.fromEntries(accountIds.map((accountId, index) => [`0x${index}`, { accountId }])),
    totalWeight: BigInt(accountIds.length),
    epochMicrogonsPerArgonot,
  };
}
