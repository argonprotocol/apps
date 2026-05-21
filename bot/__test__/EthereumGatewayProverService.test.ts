import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NetworkConfig } from '@argonprotocol/apps-core';

const mainchainMock = vi.hoisted(() => {
  const buildGatewayActivityProofPayload = vi.fn();
  const sign = vi.fn();
  const submitSigned = vi.fn();

  class TxSubmitter {
    public async sign(options?: { nonce?: number }): Promise<unknown> {
      return (await sign(options)) as unknown;
    }

    public async submitSigned(signedTx: unknown): Promise<unknown> {
      return (await submitSigned(signedTx)) as unknown;
    }
  }

  return {
    buildGatewayActivityProofPayload,
    sign,
    submitSigned,
    TxSubmitter,
  };
});

vi.mock('@argonprotocol/mainchain', async () => {
  const actual = await vi.importActual<typeof import('@argonprotocol/mainchain')>('@argonprotocol/mainchain');
  return {
    ...actual,
    buildGatewayActivityProofPayload: mainchainMock.buildGatewayActivityProofPayload,
    TxSubmitter: mainchainMock.TxSubmitter,
  };
});

import { DelegateSubmitLane } from '../src/DelegateSubmitLane.ts';
import { EthereumGatewayProverService } from '../src/EthereumGatewayProverService.ts';

const relayKeypair = { address: '5RelayDelegate' } as any;

describe('EthereumGatewayProverService', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    NetworkConfig.setNetwork('dev-docker');
    NetworkConfig.setRuntimeOverride('dev-docker', {
      ethereumNetwork: {
        executionRpcUrl: 'http://ethereum.test',
      },
    });
  });

  it('returns Noop when the mainchain helper reports nothing new to prove', async () => {
    mainchainMock.buildGatewayActivityProofPayload.mockResolvedValue({
      latestGatewayActivityNonce: 6n,
      payloadUpToGatewayActivityNonce: 6n,
      payload: null,
    });
    const service = new EthereumGatewayProverService(createSubmitLane(createClient()));

    await expect(
      service.runToCheckpoint({
        sourceChain: 'Ethereum',
        throughGatewayActivityNonce: 6n,
      }),
    ).resolves.toEqual({
      outcome: 'Noop',
      throughGatewayActivityNonce: 6n,
    });
    expect(mainchainMock.buildGatewayActivityProofPayload).toHaveBeenCalledWith(expect.anything(), {
      executionRpcUrl: 'http://ethereum.test',
      gatewayAddress: '0xgateway',
    });
  });

  it('submits proveGatewayActivity through the delegate lane until a checkpoint is fully caught up', async () => {
    const signedTx = {
      method: { toHuman: () => ({ section: 'crosschainTransfer', method: 'proveGatewayActivity' }) },
      nonce: { toNumber: () => 9 },
    };
    const tx = {
      paymentInfo: vi.fn(async () => ({
        partialFee: {
          toBigInt: () => 11n,
        },
      })),
    };
    const client = createClient({ tx, accountNextNonce: 9 });
    const service = new EthereumGatewayProverService(createSubmitLane(client));

    mainchainMock.buildGatewayActivityProofPayload
      .mockResolvedValueOnce({
        latestGatewayActivityNonce: 9n,
        payloadUpToGatewayActivityNonce: 7n,
        payload: {
          previousGatewayActivityNonce: 6n,
          proof: { batch: 'proof-1' },
          activities: [{ gatewayState: { gatewayActivityNonce: 7n } }],
        },
      })
      .mockResolvedValueOnce({
        latestGatewayActivityNonce: 9n,
        payloadUpToGatewayActivityNonce: 9n,
        payload: {
          previousGatewayActivityNonce: 7n,
          proof: { batch: 'proof-2' },
          activities: [{ gatewayState: { gatewayActivityNonce: 9n } }],
        },
      });
    mainchainMock.sign.mockResolvedValue(signedTx);
    mainchainMock.submitSigned.mockResolvedValue({
      extrinsic: {
        signedHash: '0xrelaytx',
        submittedAtBlockNumber: 321,
        submittedTime: new Date('2026-05-13T16:00:00.000Z'),
      },
      blockNumber: 321,
      waitForInFirstBlock: Promise.resolve(new Uint8Array([1])),
    });

    await expect(
      service.runToCheckpoint({ sourceChain: 'Ethereum', throughGatewayActivityNonce: 9n }),
    ).resolves.toEqual({
      outcome: 'Submitted',
      delegateAddress: '5RelayDelegate',
      argonTxHash: '0xrelaytx',
      extrinsicMethodJson: { section: 'crosschainTransfer', method: 'proveGatewayActivity' },
      txNonce: 9,
      txSubmittedAtBlockHeight: 321,
      txSubmittedAtTime: new Date('2026-05-13T16:00:00.000Z'),
      estimatedFee: 11n,
      throughGatewayActivityNonce: 9n,
    });
    expect(mainchainMock.sign).toHaveBeenCalledTimes(2);
  });

  it('maps stale duplicate submits back to Noop', async () => {
    const client = createClient();
    const service = new EthereumGatewayProverService(createSubmitLane(client));

    mainchainMock.buildGatewayActivityProofPayload.mockResolvedValue({
      latestGatewayActivityNonce: 7n,
      payloadUpToGatewayActivityNonce: 7n,
      payload: {
        previousGatewayActivityNonce: 6n,
        proof: { batch: 'proof' },
        activities: [{ gatewayState: { gatewayActivityNonce: 7n } }],
      },
    });
    mainchainMock.sign.mockResolvedValue({
      method: { toHuman: () => ({}) },
      nonce: { toNumber: () => 4 },
    });
    mainchainMock.submitSigned.mockResolvedValue({
      extrinsic: {
        signedHash: '0xrelaytx',
        submittedAtBlockNumber: 321,
        submittedTime: new Date('2026-05-13T16:00:00.000Z'),
      },
      waitForInFirstBlock: Promise.reject(new Error('Invalid Transaction: Stale')),
    });

    await expect(
      service.runToCheckpoint({ sourceChain: 'Ethereum', throughGatewayActivityNonce: 7n }),
    ).resolves.toEqual({
      outcome: 'Noop',
      throughGatewayActivityNonce: 7n,
    });
  });

  it('rejects when the delegate cannot afford the relay reserve', async () => {
    const client = createClient({
      balance: 12n,
      existentialDeposit: 10n,
      tx: {
        paymentInfo: vi.fn(async () => ({
          partialFee: {
            toBigInt: () => 5n,
          },
        })),
      },
    });
    const service = new EthereumGatewayProverService(createSubmitLane(client));

    mainchainMock.buildGatewayActivityProofPayload.mockResolvedValue({
      latestGatewayActivityNonce: 7n,
      payloadUpToGatewayActivityNonce: 7n,
      payload: {
        previousGatewayActivityNonce: 6n,
        proof: { batch: 'proof' },
        activities: [{ gatewayState: { gatewayActivityNonce: 7n } }],
      },
    });

    await expect(
      service.runToCheckpoint({ sourceChain: 'Ethereum', throughGatewayActivityNonce: 7n }),
    ).resolves.toEqual({
      outcome: 'Rejected',
      reason: 'Vault delegate cannot afford Ethereum gateway relay. Balance=12 required=15.',
      estimatedFee: 5n,
      throughGatewayActivityNonce: 7n,
    });
    expect(mainchainMock.sign).not.toHaveBeenCalled();
  });

  it('reports relay readiness without submitting work', async () => {
    const service = new EthereumGatewayProverService(createSubmitLane(createClient({ balance: 1_000_000n })));

    await expect(service.getRelayStatus()).resolves.toEqual({
      isReady: true,
    });
  });

  it('skips proof building when the runtime nonce already covers the requested checkpoint', async () => {
    const service = new EthereumGatewayProverService(
      createSubmitLane(createClient({ runtimeGatewayActivityNonce: 7n })),
    );

    await expect(
      service.runToCheckpoint({ sourceChain: 'Ethereum', throughGatewayActivityNonce: 7n }),
    ).resolves.toEqual({
      outcome: 'Noop',
      throughGatewayActivityNonce: 7n,
    });
    expect(mainchainMock.buildGatewayActivityProofPayload).not.toHaveBeenCalled();
  });

  it('coalesces concurrent catch-up requests into one submission', async () => {
    const signedTx = {
      method: { toHuman: () => ({ section: 'crosschainTransfer', method: 'proveGatewayActivity' }) },
      nonce: { toNumber: () => 4 },
    };
    const client = createClient();
    const service = new EthereumGatewayProverService(createSubmitLane(client));
    let releaseBuildProofPlan!: (value: unknown) => void;
    const buildProofPlan = new Promise(resolve => {
      releaseBuildProofPlan = resolve;
    });

    mainchainMock.buildGatewayActivityProofPayload.mockReturnValueOnce(buildProofPlan);
    mainchainMock.sign.mockResolvedValue(signedTx);
    mainchainMock.submitSigned.mockResolvedValue({
      extrinsic: {
        signedHash: '0xrelaytx',
        submittedAtBlockNumber: 321,
        submittedTime: new Date('2026-05-13T16:00:00.000Z'),
      },
      blockNumber: 321,
      waitForInFirstBlock: Promise.resolve(new Uint8Array([1])),
    });

    const first = service.runToCheckpoint({ sourceChain: 'Ethereum', throughGatewayActivityNonce: 7n });
    const second = service.runToCheckpoint({ sourceChain: 'Ethereum', throughGatewayActivityNonce: 7n });

    releaseBuildProofPlan({
      latestGatewayActivityNonce: 7n,
      payloadUpToGatewayActivityNonce: 7n,
      payload: {
        previousGatewayActivityNonce: 6n,
        proof: { batch: 'proof' },
        activities: [{ gatewayState: { gatewayActivityNonce: 7n } }],
      },
    });

    await expect(Promise.all([first, second])).resolves.toEqual([
      {
        outcome: 'Submitted',
        delegateAddress: '5RelayDelegate',
        argonTxHash: '0xrelaytx',
        extrinsicMethodJson: { section: 'crosschainTransfer', method: 'proveGatewayActivity' },
        txNonce: 4,
        txSubmittedAtBlockHeight: 321,
        txSubmittedAtTime: new Date('2026-05-13T16:00:00.000Z'),
        estimatedFee: 7n,
        throughGatewayActivityNonce: 7n,
      },
      {
        outcome: 'Submitted',
        delegateAddress: '5RelayDelegate',
        argonTxHash: '0xrelaytx',
        extrinsicMethodJson: { section: 'crosschainTransfer', method: 'proveGatewayActivity' },
        txNonce: 4,
        txSubmittedAtBlockHeight: 321,
        txSubmittedAtTime: new Date('2026-05-13T16:00:00.000Z'),
        estimatedFee: 7n,
        throughGatewayActivityNonce: 7n,
      },
    ]);
    expect(mainchainMock.buildGatewayActivityProofPayload).toHaveBeenCalledTimes(1);
    expect(mainchainMock.sign).toHaveBeenCalledTimes(1);
  });

  it('sweeps relay backlog on the background loop', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);

    const signedTx = {
      method: { toHuman: () => ({ section: 'crosschainTransfer', method: 'proveGatewayActivity' }) },
      nonce: { toNumber: () => 5 },
    };
    const client = createClient({ runtimeGatewayActivityNonce: 6n, accountNextNonce: 5 });
    const service = new EthereumGatewayProverService(createSubmitLane(client));

    mainchainMock.buildGatewayActivityProofPayload
      .mockResolvedValueOnce({
        latestGatewayActivityNonce: 7n,
        payloadUpToGatewayActivityNonce: 7n,
        payload: {
          previousGatewayActivityNonce: 6n,
          proof: { batch: 'proof' },
          activities: [{ gatewayState: { gatewayActivityNonce: 7n } }],
        },
      })
      .mockResolvedValueOnce({
        latestGatewayActivityNonce: 7n,
        payloadUpToGatewayActivityNonce: 7n,
        payload: {
          previousGatewayActivityNonce: 6n,
          proof: { batch: 'proof' },
          activities: [{ gatewayState: { gatewayActivityNonce: 7n } }],
        },
      });
    mainchainMock.sign.mockResolvedValue(signedTx);
    mainchainMock.submitSigned.mockResolvedValue({
      extrinsic: {
        signedHash: '0xrelaytx',
        submittedAtBlockNumber: 321,
        submittedTime: new Date('2026-05-13T16:00:00.000Z'),
      },
      blockNumber: 321,
      waitForInFirstBlock: Promise.resolve(new Uint8Array([1])),
    });

    await service.start();
    await vi.advanceTimersByTimeAsync(1);

    await vi.waitFor(() => {
      expect(mainchainMock.sign).toHaveBeenCalledTimes(1);
    });

    await service.shutdown();
  });
});

function createSubmitLane(client: ReturnType<typeof createClient>) {
  const lane = new DelegateSubmitLane(relayKeypair);
  lane.client = client as any;
  return lane;
}

function createClient(
  args: {
    tx?: { paymentInfo: ReturnType<typeof vi.fn> };
    accountNextNonce?: number;
    balance?: bigint;
    existentialDeposit?: bigint;
    runtimeGatewayActivityNonce?: bigint;
  } = {},
) {
  const tx =
    args.tx ??
    ({
      paymentInfo: vi.fn(async () => ({
        partialFee: {
          toBigInt: () => 7n,
        },
      })),
    } as const);

  return {
    tx: {
      crosschainTransfer: {
        proveGatewayActivity: vi.fn(() => tx),
      },
    },
    query: {
      crosschainTransfer: {
        gatewayStateBySourceChain: vi.fn(async () => ({
          isNone: args.runtimeGatewayActivityNonce == null,
          unwrap: () => ({
            gatewayActivityNonce: {
              toBigInt: () => args.runtimeGatewayActivityNonce ?? 0n,
            },
          }),
        })),
        chainConfigBySourceChain: vi.fn(async () => ({
          isNone: false,
          unwrap: () => ({
            isEthereum: true,
            asEthereum: {
              gateway: {
                toHex: () => '0xgateway',
              },
            },
          }),
        })),
      },
      system: {
        account: vi.fn(async () => ({
          data: {
            free: {
              toBigInt: () => args.balance ?? 1_000_000n,
            },
          },
        })),
      },
    },
    consts: {
      balances: {
        existentialDeposit: {
          toBigInt: () => args.existentialDeposit ?? 10_000n,
        },
      },
    },
    rpc: {
      system: {
        accountNextIndex: vi.fn(async () => ({
          toNumber: () => args.accountNextNonce ?? 4,
        })),
      },
    },
  };
}
