import { NetworkConfig, setFetchImplementation, type FetchImplementation } from '@argonprotocol/apps-core';
import { decodeAddress, EvmContracts } from '@argonprotocol/mainchain';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  getAddress,
  keccak256,
  parseTransaction,
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

  it('reserves distinct Ethereum nonces for concurrent outbound finalizations', async () => {
    const walletKeys = createMockWalletKeys();
    const ethereumClient = new EthereumClient(walletKeys, 'https://ethereum.test');
    const gatewayAddress = repeatHex('11', 20);
    const submittedNonces: number[] = [];
    let nextNonce = 3;
    const publicClient = {
      getTransactionCount: vi.fn(async () => nextNonce),
      estimateGas: vi.fn(async () => 100_000n),
      estimateFeesPerGas: vi.fn(async () => ({
        gasPrice: 1n,
        maxFeePerGas: 1n,
        maxPriorityFeePerGas: 1n,
      })),
      sendRawTransaction: vi.fn(async ({ serializedTransaction }: { serializedTransaction: Hex }) => {
        const nonce = parseTransaction(serializedTransaction).nonce!;
        submittedNonces.push(nonce);
        nextNonce = nonce + 1;
        return toHex(nonce, { size: 32 });
      }),
    };
    Object.assign(ethereumClient, {
      loadChainConfig: async () => ({
        chainId: 1,
        gatewayAddress,
        argonTokenAddress: repeatHex('22', 20),
        argonotTokenAddress: repeatHex('33', 20),
      }),
      createExecutionClient: async () => ({
        chain: { id: 1 },
        publicClient,
      }),
    });
    const proof = {
      authorizations: [
        {
          microgonCollateral: 100n,
          micronotCollateral: 0n,
          signature: `${repeatHex('00', 64)}1c` as const,
        },
      ],
    };

    await Promise.all(
      [1n, 2n].map(argonTransferNonce =>
        ethereumClient.finalizeTransferOutOfArgon({
          request: {
            argonAccountId: repeatHex('44', 32),
            argonTransferNonce,
            chainId: 1n,
            microgonsPerArgonot: 3n,
            recipient: getAddress(walletKeys.coreEthereumAddress),
            validUntilBlock: 500n,
            token: repeatHex('22', 20),
            amount: 100n,
            mintingAuthorityTip: 1n,
          },
          proof,
        }),
      ),
    );

    expect(submittedNonces).toEqual([3, 4]);
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

  it('falls back from the configured RPC when it returns a provider error', async () => {
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

  it('relays a council rotation and the next contiguous ready update', async () => {
    const fixture = createCouncilRotationRelayFixture();
    const receipt = await fixture.ethereumClient.applyReadyGatewayUpdates(
      fixture.finalizedClient as any,
      fixture.walletKeys.vaultingAddress,
      {
        address: fixture.walletKeys.coreEthereumAddress,
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

  it('reads the gateway approval nonce currently applied on Ethereum', async () => {
    const fixture = createCouncilRotationRelayFixture();

    await expect(fixture.ethereumClient.getGatewayApprovalNonce()).resolves.toBe(0n);
  });

  it('hydrates Ethereum block numbers for live gateway approval rows in one block-range lookup', async () => {
    const fixture = createCouncilRotationRelayFixture();
    const zeroHash: Hex = `0x${'00'.repeat(32)}`;
    const signingKey: Hex = `0x${'11'.repeat(20)}`;
    const topics = encodeEventTopics({
      abi: EvmContracts.mintingGatewayAbi,
      eventName: 'MintingAuthorityDeactivated',
      args: { signingKey },
    });
    const data = encodeAbiParameters(
      [
        { name: 'microgonCollateral', type: 'uint128' },
        { name: 'micronotCollateral', type: 'uint128' },
        { name: 'approvalHash', type: 'bytes32' },
        { name: 'relayerArgonAccountId', type: 'bytes32' },
        {
          name: 'gatewayState',
          type: 'tuple',
          components: [
            { name: 'gatewayActivityNonce', type: 'uint64' },
            { name: 'argonApprovalsNonce', type: 'uint64' },
            { name: 'argonCirculation', type: 'uint128' },
            { name: 'argonotCirculation', type: 'uint128' },
          ],
        },
      ],
      [
        0n,
        0n,
        zeroHash,
        zeroHash,
        {
          gatewayActivityNonce: 7n,
          argonApprovalsNonce: 8n,
          argonCirculation: 0n,
          argonotCirculation: 0n,
        },
      ],
    );
    const getLogs = vi.fn(async () => [{ data, topics, blockNumber: 120n }]);
    const publicClient = {
      readContract: vi.fn(async ({ functionName }: { functionName: string }) => {
        if (functionName === 'latestActivityBlockLocatorIndex') return 4n;
        if (functionName === 'activityBlockLocators') return [120n, 7n, 7n, zeroHash];
        throw new Error(`Unexpected function ${functionName}`);
      }),
      getLogs,
    };
    Object.assign(fixture.ethereumClient, {
      createExecutionClient: async () => ({ publicClient }),
    });

    await expect(fixture.ethereumClient.getGatewayApprovalBlockNumbers([8n], 115n)).resolves.toEqual(
      new Map([[8n, 120n]]),
    );
    expect(getLogs).toHaveBeenCalledWith({
      address: fixture.gatewayAddress,
      fromBlock: 116n,
      toBlock: 120n,
    });
  });

  it('relays a standalone council rotation when an unreimbursed relay is explicitly allowed', async () => {
    const fixture = createCouncilRotationRelayFixture();
    fixture.entries.delete(2n);

    const receipt = await fixture.ethereumClient.applyReadyGatewayUpdates(
      fixture.finalizedClient as any,
      fixture.walletKeys.vaultingAddress,
      {
        address: fixture.walletKeys.coreEthereumAddress,
        hdPath: `m/44'/60'/0'/0'`,
      },
      { allowUncompensatedRelay: true },
    );

    expect(receipt?.transactionHash).toBe(fixture.transactionHash);

    const decoded = decodeFunctionData({
      abi: EvmContracts.mintingGatewayAbi,
      data: fixture.submittedTransaction.data!,
    });

    expect(decoded.functionName).toBe('applyGatewayUpdates');
    expect(decoded.args?.[1]).toEqual([
      {
        queueNonce: 1n,
        kind: EvmContracts.MINTING_GATEWAY_UPDATE_KINDS.globalIssuanceCouncilRotate,
        payload: EvmContracts.encodeMintingGatewayGlobalIssuanceCouncilRotateTarget(fixture.rotationTarget),
        signatures: fixture.currentCouncilSignatures,
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
          address: fixture.walletKeys.coreEthereumAddress,
          hdPath: `m/44'/60'/0'/0'`,
        },
        { allowUncompensatedRelay: true },
      ),
    ).rejects.toThrow(`Queue nonce 1 ${expectedError}`);
    expect(fixture.sendRawTransaction).not.toHaveBeenCalled();
  });
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
    entries,
    ethereumClient,
    finalizedClient,
    gatewayAddress,
    rotatedCouncilSignatures,
    rotationTarget,
    sendRawTransaction,
    submittedTransaction,
    transactionHash,
    walletKeys,
  };
}
