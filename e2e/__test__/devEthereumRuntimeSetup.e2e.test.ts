import { describe, expect, it, vi } from 'vitest';
import { EvmContracts } from '@argonprotocol/mainchain';
import { getAddress, type Hex, type PublicClient } from 'viem';
import { syncEthereumGatewayActiveCouncilToArgon } from '../devEthereumRuntimeSetup.ts';

describe('syncEthereumGatewayActiveCouncilToArgon', () => {
  it('resyncs when the gateway only matches an older microgons-per-argonot floor', async () => {
    const signerA = `0x${'11'.repeat(20)}`;
    const signerB = `0x${'22'.repeat(20)}`;
    const oldMicrogonsPerArgonot = 3n;
    const nextMicrogonsPerArgonot = 5n;
    const currentCouncil = {
      signers: [getAddress(signerA), getAddress(signerB)],
      weights: [7n, 4n],
    };
    const hashCouncil = EvmContracts.hashMintingGatewayGlobalIssuanceCouncil as (args: {
      signers: `0x${string}`[];
      weights: bigint[];
      epochMicrogonsPerArgonot: bigint;
    }) => `0x${string}`;
    const staleGatewayHash = hashCouncil({
      ...currentCouncil,
      epochMicrogonsPerArgonot: oldMicrogonsPerArgonot,
    });
    const staleGatewayCouncil = [11n, 2n, staleGatewayHash, oldMicrogonsPerArgonot] as const;
    const sendCurrentCouncil = vi.fn(async () => `0x${'ab'.repeat(32)}`) as (
      currentCouncil: { signers: `0x${string}`[]; weights: bigint[] },
      nextMicrogonsPerArgonot: bigint,
    ) => Promise<Hex>;
    const waitForTransactionReceipt = vi.fn(
      async () => ({ status: 'success' }) as Awaited<ReturnType<PublicClient['waitForTransactionReceipt']>>,
    );
    const publicClient = {
      readContract: vi.fn(async () => staleGatewayCouncil),
      waitForTransactionReceipt,
    } as Pick<PublicClient, 'readContract' | 'waitForTransactionReceipt'>;

    const result = await syncEthereumGatewayActiveCouncilToArgon({
      finalizedClient: {
        query: {
          crosschainTransfer: {
            activeGlobalIssuanceCouncilByDestinationChain: vi.fn(async () => ({
              isNone: false,
              unwrap: () => `0x${'99'.repeat(32)}`,
            })),
            globalIssuanceCouncilByHash: vi.fn(async () => ({
              isNone: false,
              unwrap: () => ({
                epochMicrogonsPerArgonot: { toBigInt: () => nextMicrogonsPerArgonot },
                members: new Map([
                  [{ toHex: () => signerB }, { weight: { toBigInt: () => 4n } }],
                  [{ toHex: () => signerA }, { weight: { toBigInt: () => 7n } }],
                ]),
              }),
            })),
          },
        },
      } as any,
      gatewayAddress: getAddress(`0x${'33'.repeat(20)}`),
      publicClient,
      sendCurrentCouncil,
    });

    expect(result).toEqual({
      status: 'synced',
      hash: `0x${'ab'.repeat(32)}`,
    });
    expect(sendCurrentCouncil).toHaveBeenCalledWith(currentCouncil, nextMicrogonsPerArgonot);
    expect(waitForTransactionReceipt).toHaveBeenCalledWith({ hash: `0x${'ab'.repeat(32)}` });
  });

  it('stays already-matching when the gateway hash includes the current floor', async () => {
    const signer = `0x${'44'.repeat(20)}`;
    const currentCouncil = {
      signers: [getAddress(signer)],
      weights: [1n],
    };
    const microgonsPerArgonot = 8n;
    const hashCouncil = EvmContracts.hashMintingGatewayGlobalIssuanceCouncil as (args: {
      signers: `0x${string}`[];
      weights: bigint[];
      epochMicrogonsPerArgonot: bigint;
    }) => `0x${string}`;
    const currentHash = hashCouncil({
      ...currentCouncil,
      epochMicrogonsPerArgonot: microgonsPerArgonot,
    });
    const currentGatewayCouncil = [1n, 1n, currentHash, microgonsPerArgonot] as const;
    const sendCurrentCouncil = vi.fn() as (
      currentCouncil: { signers: `0x${string}`[]; weights: bigint[] },
      nextMicrogonsPerArgonot: bigint,
    ) => Promise<Hex>;
    const publicClient = {
      readContract: vi.fn(async () => currentGatewayCouncil),
      waitForTransactionReceipt: vi.fn(),
    } as Pick<PublicClient, 'readContract' | 'waitForTransactionReceipt'>;

    const result = await syncEthereumGatewayActiveCouncilToArgon({
      finalizedClient: {
        query: {
          crosschainTransfer: {
            activeGlobalIssuanceCouncilByDestinationChain: vi.fn(async () => ({
              isNone: false,
              unwrap: () => `0x${'77'.repeat(32)}`,
            })),
            globalIssuanceCouncilByHash: vi.fn(async () => ({
              isNone: false,
              unwrap: () => ({
                epochMicrogonsPerArgonot: { toBigInt: () => microgonsPerArgonot },
                members: new Map([[{ toHex: () => signer }, { weight: { toBigInt: () => 1n } }]]),
              }),
            })),
          },
        },
      } as any,
      gatewayAddress: getAddress(`0x${'55'.repeat(20)}`),
      publicClient,
      sendCurrentCouncil,
    });

    expect(result).toEqual({ status: 'already-matching' });
    expect(sendCurrentCouncil).not.toHaveBeenCalled();
  });
});
