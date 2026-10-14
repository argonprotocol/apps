import { MoveToken, NetworkConfig } from '@argonprotocol/apps-core';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EthereumOutboundTransferTracker } from '../lib/EthereumOutboundTransferTracker.ts';

import { WalletForEthereum } from '../lib/WalletForEthereum.ts';
import { EthereumClient } from '../lib/EthereumClient.ts';

import { WalletType } from '../lib/Wallet.ts';

import { createTestDb } from './helpers/db.ts';
import { createMockWalletKeys } from './helpers/wallet.ts';

const { getEthereumGatewayPauseReasonMock, getMainchainClientMock } = vi.hoisted(() => ({
  getEthereumGatewayPauseReasonMock: vi.fn(),
  getMainchainClientMock: vi.fn(),
}));

vi.mock('../stores/mainchain.ts', () => ({
  getMainchainClient: getMainchainClientMock,
  getEthereumGatewayPauseReason: getEthereumGatewayPauseReasonMock,
}));

describe('EthereumOutboundTransferTracker decisions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getEthereumGatewayPauseReasonMock.mockResolvedValue(undefined);
    NetworkConfig.setNetwork('dev-docker');
    NetworkConfig.setRuntimeOverride('dev-docker', {
      ethereumNetwork: { executionRpcUrls: ['https://ethereum.test'] },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    NetworkConfig.clearRuntimeOverride('dev-docker');
  });

  it('adds outbound costs to the requested amount and caps only at the available balance', async () => {
    getMainchainClientMock.mockResolvedValue(createMainchainClient());
    const walletKeys = createMockWalletKeys();

    const tracker = new EthereumOutboundTransferTracker(
      Promise.resolve(await createTestDb()),
      { data: { txInfos: [] } } as any,
      { start: vi.fn(async () => {}) } as any,
      walletKeys,
      new EthereumClient(walletKeys, 'https://ethereum.test'),
    );

    const ethereumWallet = new WalletForEthereum('0x0000000000000000000000000000000000000001');
    const availableAmount = 3_930_212_614n;
    const amount = 100_000_000n;
    const quote = await tracker.quoteTransferOut({
      amount,
      availableAmount,
      moveToken: MoveToken.ARGN,
      sourceWalletType: WalletType.argon,
      ethereumWallet,
    });
    const senderDebit = (amount: bigint) => amount + (amount * 10n) / 10_000n + 2_070n;
    expect(quote.amountToTransfer).toBe(amount);
    expect(quote.mintingAuthorityTip).toBe(100_000n);
    expect(quote.transactionFeeMicrogons).toBe(2_070n);
    expect(quote.amountToSpend).toBe(senderDebit(amount));
    await expect(
      tracker.startMove({
        moveToken: MoveToken.ARGN,
        amount: quote.amountToTransfer,
        amountToSpend: senderDebit(quote.amountToTransfer) - 1n,
        sourceWalletType: WalletType.argon,
        ethereumWallet,
      }),
    ).rejects.toThrow('network fee changed');

    const argonotQuote = await tracker.quoteTransferOut({
      amount,
      availableAmount,
      moveToken: MoveToken.ARGNOT,
      sourceWalletType: WalletType.argon,
      ethereumWallet,
    });
    expect(argonotQuote.amountToTransfer).toBe(amount);
    expect(argonotQuote.amountToSpend).toBe(amount + 100_000n);
    await expect(
      tracker.startMove({
        moveToken: MoveToken.ARGNOT,
        amount: argonotQuote.amountToTransfer,
        amountToSpend: argonotQuote.amountToSpend,
        availableArgonAmount: 1_000n,
        sourceWalletType: WalletType.argon,
        ethereumWallet,
      }),
    ).rejects.toThrow('not have enough ARGN');

    const maximumQuote = await tracker.quoteTransferOut({
      amount: availableAmount,
      availableAmount,
      moveToken: MoveToken.ARGN,
      sourceWalletType: WalletType.argon,
      ethereumWallet,
    });
    const maximumAmount = maximumQuote.amountToTransfer;
    const totalCost = (amount: bigint) => amount + (amount * 10n) / 10_000n + 2_070n + 10_000n;
    expect(totalCost(maximumAmount)).toBeLessThanOrEqual(availableAmount);
    expect(totalCost(maximumAmount + 1n)).toBeGreaterThan(availableAmount);

    await expect(
      tracker.startMove({
        moveToken: MoveToken.ARGN,
        amount: maximumAmount + 1n,
        availableAmount,
        sourceWalletType: WalletType.argon,
        ethereumWallet,
      }),
    ).rejects.toThrow('network fee');

    const maximumArgonotQuote = await tracker.quoteTransferOut({
      amount: 205293660000n,
      availableAmount: 205293660000n,
      moveToken: MoveToken.ARGNOT,
      sourceWalletType: WalletType.argon,
      ethereumWallet,
    });
    expect(maximumArgonotQuote.amountToTransfer).toBe(205088561439n);
  });

  it('rejects an outbound amount that would dip below the minimum balance', async () => {
    getMainchainClientMock.mockResolvedValue(createMainchainClient());
    const walletKeys = createMockWalletKeys();

    const tracker = new EthereumOutboundTransferTracker(
      Promise.resolve(await createTestDb()),
      { data: { txInfos: [] } } as any,
      { start: vi.fn(async () => {}) } as any,
      walletKeys,
      new EthereumClient(walletKeys, 'https://ethereum.test'),
    );

    await expect(
      tracker.startMove({
        moveToken: MoveToken.ARGNOT,
        amount: 205088571428n,
        availableAmount: 205293660000n,
        sourceWalletType: WalletType.argon,
        ethereumWallet: new WalletForEthereum('0x0000000000000000000000000000000000000001'),
      }),
    ).rejects.toThrow('Leave enough ARGNOT for the transfer');
  });
});

function createMainchainClient() {
  const now = BigInt(Date.now());

  return {
    rpc: { author: { pendingExtrinsics: vi.fn(async () => []) } },
    tx: {
      crosschainTransfer: {
        transferOut: vi.fn(() => ({
          kind: 'transferOut',
          paymentInfo: vi.fn(async () => ({ partialFee: { toBigInt: () => 2_070n } })),
        })),
      },
    },
    query: {
      ethereumVerifier: {
        latestExecutionHeaderAnchorBlockHash: vi.fn(async () => `0x${'aa'.repeat(32)}`),
        executionHeaderAnchors: vi.fn(async () => ({ timestampMillis: now })),
      },
    },
    consts: {
      crosschainTransfer: {
        maxVerifiedExecutionBlockAgeTicks: 60n,
        transferOutMintingAuthorityTipBasisPoints: 10,
      },
    },
    events: {
      crosschainTransfer: {
        TransferOutStarted: {
          is: (event: { section: string; method: string }) =>
            event.section === 'crosschainTransfer' && event.method === 'TransferOutStarted',
        },
      },
    },
  };
}
