import { NetworkConfig, setFetchImplementation, type FetchImplementation } from '@argonprotocol/apps-core';
import { decodeAddress, EvmContracts } from '@argonprotocol/mainchain';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  decodeFunctionData,
  keccak256,
  TransactionNotFoundError,
  TransactionReceiptNotFoundError,
  type Hex,
  toHex,
} from 'viem';
import {
  createEthereumPublicClient,
  EthereumClient,
  EthereumTransactionRevertedError,
  getEthereumUserErrorMessage,
  submitEthereumTransaction,
} from '../lib/EthereumClient.ts';
import { createMockWalletKeys } from './helpers/wallet.ts';

const runtimeFetchMock = vi.fn();

describe('EthereumClient', () => {
  beforeEach(() => {
    runtimeFetchMock.mockReset();
    setFetchImplementation();
    NetworkConfig.setRuntimeOverride('dev-docker', {
      ethereumNetwork: {
        executionRpcUrls: ['https://ethereum.test'],
      },
    });
  });

  afterEach(() => {
    setFetchImplementation();
    NetworkConfig.clearRuntimeOverride('dev-docker');
  });

  it('prefers the short viem error message over raw RPC request details', () => {
    const error = Object.assign(
      new Error(
        [
          'Missing or invalid parameters.',
          'Double check you have provided the correct parameters.',
          '',
          'URL: https://ethereum-sepolia-rpc.publicnode.com',
          'Request body: {"method":"eth_sendRawTransaction"}',
        ].join('\n'),
      ),
      {
        shortMessage: 'Missing or invalid parameters. Double check you have provided the correct parameters.',
      },
    );

    expect(getEthereumUserErrorMessage(error, 'fallback')).toBe(
      'Missing or invalid parameters. Double check you have provided the correct parameters.',
    );
  });

  it('falls back to the first paragraph when no short message exists', () => {
    const error = new Error(
      ['Ethereum RPC rejected the transaction.', '', 'URL: https://ethereum-sepolia-rpc.publicnode.com'].join('\n'),
    );

    expect(getEthereumUserErrorMessage(error, 'fallback')).toBe('Ethereum RPC rejected the transaction.');
  });

  it('recovers the derived hash when sendRawTransaction errored after propagation', async () => {
    const serializedTransaction = '0x1234';
    const publicClient = {
      sendRawTransaction: async () => {
        throw new Error('Missing or invalid parameters.\n\nRequest body: {"method":"eth_sendRawTransaction"}');
      },
      getTransaction: async ({ hash }: { hash: string }) => ({ hash }),
      getTransactionReceipt: async () => {
        throw new TransactionReceiptNotFoundError({ hash: keccak256(serializedTransaction) });
      },
    };

    await expect(
      submitEthereumTransaction({
        publicClient,
        serializedTransaction,
        fallbackErrorMessage: 'fallback',
      }),
    ).resolves.toBe(keccak256(serializedTransaction));
  });

  it('surfaces a sanitized error when the transaction never becomes visible', async () => {
    const serializedTransaction = '0x1234';
    const publicClient = {
      sendRawTransaction: async () => {
        throw Object.assign(
          new Error('Missing or invalid parameters.\n\nRequest body: {"method":"eth_sendRawTransaction"}'),
          {
            shortMessage: 'Missing or invalid parameters. Double check you have provided the correct parameters.',
          },
        );
      },
      getTransaction: async () => {
        throw new TransactionNotFoundError({ hash: keccak256(serializedTransaction) });
      },
      getTransactionReceipt: async () => {
        throw new TransactionReceiptNotFoundError({ hash: keccak256(serializedTransaction) });
      },
    };

    await expect(
      submitEthereumTransaction({
        publicClient,
        serializedTransaction,
        fallbackErrorMessage: 'fallback',
      }),
    ).rejects.toThrow('Missing or invalid parameters. Double check you have provided the correct parameters.');
  });

  it('routes Ethereum balance requests through plugin-http', async () => {
    runtimeFetchMock.mockResolvedValue(
      new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x2a' }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
        },
      }),
    );
    setFetchImplementation(runtimeFetchMock as unknown as FetchImplementation);

    const publicClient = createEthereumPublicClient();

    await expect(publicClient.getBalance({ address: '0x0000000000000000000000000000000000000001' })).resolves.toBe(42n);
    expect(String(runtimeFetchMock.mock.calls[0][0])).toBe('https://ethereum.test/');
    const requestBody = JSON.parse(String(runtimeFetchMock.mock.calls[0][1]?.body));
    expect(requestBody.method).toBe('eth_getBalance');
    expect(requestBody.params).toEqual(['0x0000000000000000000000000000000000000001', 'latest']);
  });

  it('uses the configured RPC before the built-in fallbacks', async () => {
    NetworkConfig.setRuntimeOverride('dev-docker', {
      ethereumNetwork: {
        executionRpcUrls: ['https://ethereum-fallback.test'],
      },
    });
    runtimeFetchMock.mockResolvedValueOnce(new Response('unavailable', { status: 503 })).mockResolvedValueOnce(
      new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x2a' }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
        },
      }),
    );
    setFetchImplementation(runtimeFetchMock as unknown as FetchImplementation);

    const publicClient = createEthereumPublicClient(undefined, 'https://ethereum-configured.test');

    await expect(publicClient.getBalance({ address: '0x0000000000000000000000000000000000000001' })).resolves.toBe(42n);
    expect(runtimeFetchMock.mock.calls.map(call => String(call[0]))).toEqual([
      'https://ethereum-configured.test/',
      'https://ethereum-fallback.test/',
    ]);
  });

  it('rejects a reverted receipt instead of counting its confirmations', async () => {
    const txHash = `0x${'11'.repeat(32)}` as const;
    const ethereumClient = new EthereumClient(createMockWalletKeys(), 'https://ethereum.test');
    const getBlockNumber = vi.fn(async () => 100n);

    Object.assign(ethereumClient, {
      createExecutionClient: async () => ({
        publicClient: {
          getTransactionReceipt: vi.fn(async () => ({
            blockNumber: 90n,
            blockHash: `0x${'22'.repeat(32)}`,
            transactionHash: txHash,
            status: 'reverted',
          })),
          getBlockNumber,
        },
      }),
    });

    await expect(ethereumClient.getTransactionProgress({ txHash })).rejects.toThrow(EthereumTransactionRevertedError);
    expect(getBlockNumber).not.toHaveBeenCalled();
  });

  // The published mainchain declarations reference a missing generated module, so ESLint sees these
  // native EvmContracts helpers as error-typed even though the runtime exports are present.
  /* eslint-disable @typescript-eslint/no-unsafe-call */
  it('relays a council rotation and the next contiguous ready update', async () => {
    const fixture = createCouncilRotationRelayFixture();
    const receipt = await fixture.ethereumClient.applyReadyGatewayUpdates(
      fixture.finalizedClient as any,
      fixture.walletKeys.vaultingAddress,
      {
        address: fixture.walletKeys.ethereumAddress,
        hdPath: `m/44'/60'/0'/0'`,
      },
      { allowUncompensatedRelay: true },
    );
    const decoded = decodeFunctionData({
      abi: EvmContracts.mintingGatewayAbi,
      data: fixture.submittedTransaction.data!,
    });

    expect(receipt?.transactionHash).toBe(fixture.transactionHash);
    expect(fixture.sendRawTransaction).toHaveBeenCalledOnce();
    expect(decoded.functionName).toBe('applyGatewayUpdates');
    expect(decoded.args?.[0]).toEqual(fixture.currentCouncil);
    expect(decoded.args?.[1]).toEqual([
      {
        queueNonce: 1n,
        kind: EvmContracts.MINTING_GATEWAY_UPDATE_KINDS.globalIssuanceCouncilRotate,
        payload: EvmContracts.encodeMintingGatewayGlobalIssuanceCouncilRotateTarget(fixture.rotationTarget),
        signatures: fixture.currentCouncilSignatures,
      },
      {
        queueNonce: 2n,
        kind: EvmContracts.MINTING_GATEWAY_UPDATE_KINDS.mintingAuthorityActivate,
        payload: EvmContracts.encodeMintingGatewayMintingAuthorityActivationTarget(fixture.activationTarget),
        signatures: fixture.rotatedCouncilSignatures,
      },
    ]);
  });

  it.each([
    ['target council hash', 'council', 'target council hash does not match council'],
    ['target payload hash', 'payload', 'target payload hash does not match council'],
    ['approval hash', 'approval', 'approval hash does not match council rotation'],
  ] as const)('rejects a rotation whose %s is invalid', async (_label, corruption, expectedError) => {
    const fixture = createCouncilRotationRelayFixture(corruption);

    await expect(
      fixture.ethereumClient.applyReadyGatewayUpdates(
        fixture.finalizedClient as any,
        fixture.walletKeys.vaultingAddress,
        {
          address: fixture.walletKeys.ethereumAddress,
          hdPath: `m/44'/60'/0'/0'`,
        },
        { allowUncompensatedRelay: true },
      ),
    ).rejects.toThrow(`Queue nonce 1 ${expectedError}`);
    expect(fixture.sendRawTransaction).not.toHaveBeenCalled();
  });
  /* eslint-enable @typescript-eslint/no-unsafe-call */
});

const ZERO_HASH = repeatHex('00', 32);

function repeatHex(byte: string, count: number): Hex {
  return `0x${byte.repeat(count)}`;
}

function amount(value: bigint) {
  return {
    toBigInt: () => value,
  };
}

function hexValue(value: Hex) {
  return {
    toHex: () => value,
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

// The published mainchain declarations reference a missing generated module, so ESLint sees these
// native EvmContracts helpers as error-typed even though the runtime exports are present.
/* eslint-disable @typescript-eslint/no-unsafe-call */
function createCouncilRotationRelayFixture(corruption?: 'council' | 'payload' | 'approval') {
  const gatewayAddress = repeatHex('11', 20);
  const authoritySigningKey = repeatHex('22', 20);
  const currentCouncilSignerA = repeatHex('33', 20);
  const currentCouncilSignerB = repeatHex('44', 20);
  const rotatedCouncilSignerA = repeatHex('55', 20);
  const rotatedCouncilSignerB = repeatHex('66', 20);
  const currentCouncil = {
    signers: [currentCouncilSignerA, currentCouncilSignerB],
    weights: [70n, 30n],
  };
  const currentCouncilHash = EvmContracts.hashMintingGatewayGlobalIssuanceCouncil({
    ...currentCouncil,
    epochMicrogonsPerArgonot: 2_000_000n,
  });
  const rotationTarget: Parameters<typeof EvmContracts.encodeMintingGatewayGlobalIssuanceCouncilRotateTarget>[0] = {
    council: {
      signers: [rotatedCouncilSignerA, rotatedCouncilSignerB],
      weights: [60n, 40n],
    },
    epochMicrogonsPerArgonot: 6_000_000n,
  };
  const rotatedCouncilHash = EvmContracts.hashMintingGatewayGlobalIssuanceCouncil({
    ...rotationTarget.council,
    epochMicrogonsPerArgonot: rotationTarget.epochMicrogonsPerArgonot,
  });
  const queuedRotatedCouncilHash = corruption === 'council' ? repeatHex('77', 32) : rotatedCouncilHash;
  const hashContext = { chainId: 1n, gatewayAddress };
  const rotationPayloadHash = EvmContracts.hashMintingGatewayRotateGlobalIssuanceCouncil(hashContext, rotationTarget);
  const rotationApprovalHash = EvmContracts.hashMintingGatewayRotateGlobalIssuanceCouncilApproval(hashContext, {
    queueNonce: 1n,
    approvingCouncilHash: currentCouncilHash,
    previousUpdateHash: ZERO_HASH,
    target: rotationTarget,
  });
  const queuedRotationApprovalHash = corruption === 'approval' ? repeatHex('88', 32) : rotationApprovalHash;
  const activationTarget = {
    microgonCollateral: 1_500n,
    micronotCollateral: 250n,
    signingKey: authoritySigningKey,
  };
  const activationPayloadHash = EvmContracts.hashMintingGatewayActivateMintingAuthority(hashContext, activationTarget);
  const activationApprovalHash = EvmContracts.hashMintingGatewayActivateMintingAuthorityApproval(hashContext, {
    queueNonce: 2n,
    approvingCouncilHash: rotatedCouncilHash,
    previousUpdateHash: queuedRotationApprovalHash,
    target: activationTarget,
  });
  const currentCouncilSignatures = [repeatHex('99', 65), repeatHex('aa', 65)];
  const rotatedCouncilSignatures = [repeatHex('bb', 65), repeatHex('cc', 65)];
  const entries = new Map([
    [
      1n,
      {
        approvingCouncilHash: hexValue(currentCouncilHash),
        target: {
          isGlobalIssuanceCouncilRotation: true,
          isMintingAuthorityActivation: false,
          isMintingAuthorityDeactivation: false,
          asGlobalIssuanceCouncilRotation: hexValue(queuedRotatedCouncilHash),
          type: 'GlobalIssuanceCouncilRotation',
        },
        targetPayloadHash: hexValue(corruption === 'payload' ? repeatHex('dd', 32) : rotationPayloadHash),
        previousApprovalHash: hexValue(ZERO_HASH),
        approvalHash: hexValue(queuedRotationApprovalHash),
        signatures: new Map([
          [hexValue(currentCouncilSignerB), hexValue(currentCouncilSignatures[1])],
          [hexValue(currentCouncilSignerA), hexValue(currentCouncilSignatures[0])],
        ]),
      },
    ],
    [
      2n,
      {
        approvingCouncilHash: hexValue(rotatedCouncilHash),
        target: {
          isGlobalIssuanceCouncilRotation: false,
          isMintingAuthorityActivation: true,
          isMintingAuthorityDeactivation: false,
          asMintingAuthorityActivation: hexValue(authoritySigningKey),
          type: 'MintingAuthorityActivation',
        },
        targetPayloadHash: hexValue(activationPayloadHash),
        previousApprovalHash: hexValue(queuedRotationApprovalHash),
        approvalHash: hexValue(activationApprovalHash),
        signatures: new Map([
          [hexValue(rotatedCouncilSignerB), hexValue(rotatedCouncilSignatures[1])],
          [hexValue(rotatedCouncilSignerA), hexValue(rotatedCouncilSignatures[0])],
        ]),
      },
    ],
  ]);
  const walletKeys = createMockWalletKeys();
  const finalizedClient = {
    query: {
      crosschainTransfer: {
        activeGlobalIssuanceCouncilByDestinationChain: async () => some(hexValue(currentCouncilHash)),
        globalIssuanceCouncilByHash: async (hash: Hex) => {
          if (hash === currentCouncilHash) {
            return some({
              epochMicrogonsPerArgonot: amount(2_000_000n),
              totalWeight: amount(100n),
              members: new Map([
                [hexValue(currentCouncilSignerB), { weight: amount(30n) }],
                [hexValue(currentCouncilSignerA), { weight: amount(70n) }],
              ]),
            });
          }

          return some({
            epochMicrogonsPerArgonot: amount(rotationTarget.epochMicrogonsPerArgonot),
            totalWeight: amount(100n),
            members: new Map([
              [hexValue(rotatedCouncilSignerB), { weight: amount(40n) }],
              [hexValue(rotatedCouncilSignerA), { weight: amount(60n) }],
            ]),
          });
        },
        mintingAuthorityActivationRepaymentPricingByDestinationChain: async () => none(),
        councilApprovalQueueByDestinationChainAndNonce: async (_chain: string, nonce: bigint) =>
          entries.has(nonce) ? some(entries.get(nonce)) : none(),
        mintingAuthoritiesBySigner: async () =>
          some({
            accountId: hexValue(toHex(decodeAddress(walletKeys.vaultingAddress), { size: 32 })),
            destinationChain: { type: 'Ethereum' },
            gatewayRemainingMicrogonCollateral: amount(activationTarget.microgonCollateral),
            gatewayRemainingMicronotCollateral: amount(activationTarget.micronotCollateral),
            activationBaseRepaymentQuote: amount(0n),
            activationSignatureRepaymentQuote: amount(0n),
          }),
      },
    },
  };
  const submittedTransaction: { data?: Hex } = {};
  const transactionHash = repeatHex('ee', 32);
  const sendRawTransaction = vi.fn(async () => transactionHash);
  const publicClient = {
    readContract: async ({ functionName }: { functionName: string }) => {
      if (functionName === 'argonApprovalsNonce') return 0n;
      if (functionName === 'argonApprovalsHash') return ZERO_HASH;
      if (functionName === 'paused') return false;
      throw new Error(`Unexpected function ${functionName}`);
    },
    getBalance: async () => 1_000_000n,
    getTransactionCount: async () => 0,
    estimateGas: async ({ data }: { data: Hex }) => {
      submittedTransaction.data = data;
      return 100_000n;
    },
    estimateFeesPerGas: async () => ({
      gasPrice: 1n,
      maxFeePerGas: 1n,
      maxPriorityFeePerGas: 1n,
    }),
    sendRawTransaction,
    waitForTransactionReceipt: async () => ({
      blockNumber: 1n,
      status: 'success',
      transactionHash,
    }),
  };
  const ethereumClient = new EthereumClient(walletKeys, 'https://ethereum.test');

  Object.assign(ethereumClient, {
    loadChainConfig: async () => ({
      chainId: 1,
      gatewayAddress,
      argonTokenAddress: repeatHex('ff', 20),
      argonotTokenAddress: repeatHex('ee', 20),
    }),
    createExecutionClient: async () => ({
      chain: { id: 1 },
      publicClient,
    }),
  });

  return {
    activationTarget,
    currentCouncil,
    currentCouncilSignatures,
    ethereumClient,
    finalizedClient,
    rotatedCouncilSignatures,
    rotationTarget,
    sendRawTransaction,
    submittedTransaction,
    transactionHash,
    walletKeys,
  };
}
/* eslint-enable @typescript-eslint/no-unsafe-call */
