import { afterEach, describe, expect, it, vi } from 'vitest';
import { computed, reactive } from 'vue';
import BigNumber from 'bignumber.js';
import { NetworkConfig, StabilizerBuyContracts, type BlockWatch } from '@argonprotocol/apps-core';
import { EvmContracts } from '@argonprotocol/mainchain';
import {
  getAddress,
  TransactionNotFoundError,
  TransactionReceiptNotFoundError,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionData,
  erc20Abi,
  keccak256,
  parseTransaction,
  serializeTransaction,
  type PublicClient,
  type Hash,
} from 'viem';
import { createTestDb } from './helpers/db.ts';
import { createMockWalletKeys } from './helpers/wallet.ts';
import { StabilizerBuys } from '../lib/StabilizerBuys.ts';
import { WalletsForEthereum } from '../lib/WalletsForEthereum.ts';
import { StabilizerBuyPurchases } from '../lib/StabilizerBuyPurchases.ts';
import { EthereumClient, EthereumTransactionRevertedError, toArgonAccountIdHex } from '../lib/EthereumClient.ts';
import { StabilizerBuyStatus, type IStabilizerBuyQuote } from '../interfaces/IStabilizerBuyPurchase.ts';
import { createStabilizerBuyFinancialPositions } from '../lib/financials/StabilizerBuys.ts';
import { calculatePositionReturn } from '../lib/financials/index.ts';

vi.mock('../stores/mainchain.ts', () => ({
  getMainchainClient: async () => ({
    raw: { at: async () => ({}) },
    rpc: { chain: { getFinalizedHead: async () => '0x00' } },
  }),
}));

describe('Stabilizer Buy background purchases', { tags: ['no-argon-network'] }, () => {
  const owners: StabilizerBuys[] = [];
  const operations: StabilizerBuyPurchases[] = [];
  afterEach(async () => {
    await Promise.all(operations.splice(0).map(operation => operation.close()));
    await Promise.all(owners.splice(0).map(owner => owner.close()));
    vi.restoreAllMocks();
    NetworkConfig.clearRuntimeOverride('dev-docker');
  });

  it('preserves a buy across approval restart and records actual financial facts', async () => {
    NetworkConfig.setNetwork('dev-docker');
    NetworkConfig.setRuntimeOverride('dev-docker', { ethereumNetwork: { finalityBlocks: 2 } });
    const db = await createTestDb();
    const walletKeys = createMockWalletKeys();
    const blockWatch = {
      start: vi.fn(async () => {
        throw new Error('Native block watcher offline');
      }),
    } as unknown as BlockWatch;
    const wallets = new WalletsForEthereum(
      walletKeys,
      Promise.resolve(db),
      Promise.resolve(db.financialCacheTable),
      async (_reason, operation) => operation({}),
    );
    const ethereum = new EthereumClient(walletKeys, 'http://ethereum.test');
    const first = new StabilizerBuys(blockWatch, walletKeys.defaultArgonAddress, Promise.resolve(db));
    owners.push(first);
    first.data = reactive(first.data) as StabilizerBuys['data'];
    const command = new StabilizerBuyPurchases(first, walletKeys, ethereum, wallets);
    operations.push(command);
    const quote: IStabilizerBuyQuote = {
      chainId: 1,
      gatewayAddress: `0x${'11'.repeat(20)}`,
      adapterAddress: `0x${'22'.repeat(20)}`,
      quoterAddress: `0x${'33'.repeat(20)}`,
      sourceAddress: getAddress(walletKeys.coreEthereumAddress),
      poolId: `0x${'44'.repeat(32)}`,
      poolManager: `0x${'55'.repeat(20)}`,
      usdcToken: `0x${'66'.repeat(20)}`,
      poolKey: {
        currency0: `0x${'66'.repeat(20)}`,
        currency1: `0x${'77'.repeat(20)}`,
        fee: 8_388_608,
        tickSpacing: 60,
        hooks: `0x${'88'.repeat(20)}`,
      },
      request: {
        repayLiquidId: 0n,
        repaySignature: '0x' as const,
        argonAccountId: toArgonAccountIdHex(walletKeys.defaultArgonAddress),
        maxUsdcIn: 1_000_000n,
        minMicrogonsOut: 1_000_000n,
        deadline: 2_000_000_000n,
      },
      quotedMicrogonsOut: 1_050_000n,
      sqrtPriceX96After: 100n,
      swapGasEstimate: 100_000n,
      minimumRewardPrincipal: 1_000_000n,
      qualifiesForRewards: true,
      prices: {
        tick: 100,
        argonUsdTargetPrice: BigNumber(2),
        usdcUsdPrice: BigNumber(1),
        ethereumUsdPrice: BigNumber(1000),
      },
    };
    Object.assign(ethereum, {
      loadChainConfig: async () => ({
        chainId: quote.chainId,
        gatewayAddress: quote.gatewayAddress,
        argonTokenAddress: quote.poolKey.currency1,
        argonotTokenAddress: `0x${'aa'.repeat(20)}`,
      }),
    });
    // The real Anvil scenario verifies quote selection. Here the external quoter supplies a fixed market.
    vi.spyOn(StabilizerBuyContracts.prototype, 'quote').mockResolvedValue(quote);
    type Receipt = Awaited<ReturnType<PublicClient['getTransactionReceipt']>>;
    const receipts = new Map<Hash, Receipt>();
    let allowance = 0n;
    let interruptApproval = true;
    let finishInterruptedApproval: (() => void) | undefined;
    let revertPurchase = false;
    let failedFeeRead = false;
    let failedReceiptReads = 0;
    let invisibleReceiptReads = 2;
    let transactionLookups = 0;
    const abiEvent = EvmContracts.mintingGatewayAbi.find(
      event => event.type === 'event' && event.name === 'TransferToArgonFromSwapStarted',
    )!;
    const activity: EvmContracts.MintingGatewayTransferToArgonFromSwapStarted = {
      token: quote.poolKey.currency1,
      amount: 1_040_000n,
      gatewayState: { gatewayActivityNonce: 7n, argonApprovalsNonce: 1n, argonCirculation: 0n, argonotCirculation: 0n },
      purchase: {
        repayLiquidId: 0n,
        repaySignature: '0x' as const,
        timestamp: 1_700_000_000n,
        buyer: quote.sourceAddress,
        argonAccountId: quote.request.argonAccountId,
        usdcToken: quote.usdcToken,
        usdcSpent: quote.request.maxUsdcIn,
        argonBought: 1_040_000n * 10n ** 12n + 10n,
        poolManager: quote.poolManager,
        poolId: quote.poolId,
        sqrtPriceBeforeX96: 99n,
        sqrtPriceAfterX96: 100n,
      },
    };
    const publicClient = {
      getChainId: async () => 1,
      readContract: async ({ functionName }: { functionName: string }) =>
        functionName === 'allowance' ? allowance : 100_000_000n,
      getBalance: async () => 10n ** 18n,
      getTransactionCount: async () => receipts.size,
      estimateGas: async () => 100_000n,
      estimateFeesPerGas: async () => ({ maxFeePerGas: 2n, maxPriorityFeePerGas: 1n }),
      getGasPrice: async () => 2n,
      getBlockNumber: async () => 44n,
      getTransaction: async ({ hash }: { hash: Hash }) => {
        if (transactionLookups++ > 0 && invisibleReceiptReads > 0) throw new TransactionNotFoundError({ hash });
        return { hash, from: quote.sourceAddress, nonce: receipts.size - 1, blockNumber: null };
      },
      sendRawTransaction: async ({ serializedTransaction }: { serializedTransaction: `0x${string}` }) => {
        const hash = keccak256(serializedTransaction);
        const transaction = parseTransaction(serializedTransaction);
        const approval = transaction.to!.toLowerCase() === quote.usdcToken.toLowerCase();
        if (approval) allowance = quote.request.maxUsdcIn;
        else if (!revertPurchase) allowance = 0n;
        const logs = [];
        if (!approval && !revertPurchase) {
          logs.push({
            address: quote.gatewayAddress,
            topics: encodeEventTopics({
              abi: EvmContracts.mintingGatewayAbi,
              eventName: 'TransferToArgonFromSwapStarted',
            }),
            data: encodeAbiParameters(abiEvent.inputs, [
              activity.purchase,
              activity.token,
              activity.amount,
              activity.gatewayState,
            ]),
          });
        }

        receipts.set(hash, {
          transactionHash: hash,
          blockNumber: 42n,
          blockHash: `0x${'99'.repeat(32)}`,
          from: quote.sourceAddress,
          to: transaction.to,
          status: !approval && revertPurchase ? 'reverted' : 'success',
          gasUsed: approval ? 10n : 20n,
          effectiveGasPrice: 2n,
          logs,
        } as Receipt);
        if (approval && interruptApproval) {
          interruptApproval = false;
          return new Promise<Hash>(resolve => {
            finishInterruptedApproval = () => resolve(hash);
          });
        }
        if (!approval && !revertPurchase) throw new Error('RPC response lost after broadcast');
        return hash;
      },
      getTransactionReceipt: async ({ hash }: { hash: Hash }) => {
        const receipt = receipts.get(hash)!;
        if (
          receipt.status !== 'reverted' &&
          receipt.to?.toLowerCase() === quote.adapterAddress.toLowerCase() &&
          invisibleReceiptReads > 0
        ) {
          invisibleReceiptReads -= 1;
          throw new TransactionReceiptNotFoundError({ hash });
        }
        if (receipt.status === 'reverted' && ++failedReceiptReads === 2) {
          failedFeeRead = true;
          throw new Error('Receipt RPC busy');
        }
        return receipt;
      },
    } as unknown as PublicClient;
    Object.defineProperty(ethereum, 'publicClient', { configurable: true, value: publicClient });
    vi.spyOn(ethereum, 'getTransactionFinalityWaitEstimateMs').mockReturnValue(60_000);
    vi.spyOn(ethereum, 'getTransactionFinalityPollMs').mockReturnValue(1);
    const ethereumWallet = (await wallets.resolve(quote.sourceAddress))!;
    await expect(
      command.purchase({
        id: 'expired-buy',
        ethereumQuote: {
          ...quote,
          request: { ...quote.request, deadline: BigInt(Math.floor(Date.now() / 1000)) },
        },
        ethereumMaxFeeWei: 1_000_000_000_000_000_001n,
        ethereumWallet,
      }),
    ).rejects.toThrow('This quote has expired');
    expect(first.data.buys).toEqual([]);
    expect((await db.stabilizerBuysTable.fetchAll(first.accountAddress)).buys).toEqual([]);
    expect(receipts.size).toBe(0);

    await command.purchase({
      id: 'synthetic-buy',
      ethereumQuote: quote,
      ethereumMaxFeeWei: 1_000_000_000_000_000_001n,
      ethereumWallet,
    });
    await vi.waitFor(() => expect(receipts.size).toBe(1));
    expect(first.data.buys[0].status).toBe(StabilizerBuyStatus.ConfirmingUsdcApprovalOnEthereum);
    await command.close();
    finishInterruptedApproval!();
    await first.close();
    const savedApproval = first.data.buys[0];
    await db.stabilizerBuysTable.saveBuy({ ...savedApproval, createdAt: new Date(1_000) });

    const restored = new StabilizerBuys(blockWatch, walletKeys.defaultArgonAddress, Promise.resolve(db));
    owners.push(restored);
    restored.data = reactive(restored.data) as StabilizerBuys['data'];
    const restoredCommand = new StabilizerBuyPurchases(restored, walletKeys, ethereum, wallets);
    restoredCommand.data = reactive(restoredCommand.data);
    const observedApproval = computed(
      () => restoredCommand.data.transactionProgressByHash[savedApproval.usdcApprovalTxHash!],
    );
    expect(observedApproval.value).toBeUndefined();
    operations.push(restoredCommand);
    const failedRead = vi
      .spyOn(db.sql, 'select')
      .mockRejectedValueOnce(new Error('Purchase records are temporarily unavailable'));
    const startup = restoredCommand.start();
    void restoredCommand.start();
    await startup;
    failedRead.mockRestore();
    const rows = computed(() => restored.data.buys);
    await expect(restored.load()).rejects.toThrow('Native block watcher offline');
    await vi.waitFor(() => expect(rows.value[0].status).toBe(StabilizerBuyStatus.WaitingForArgonRecognition));
    const confirmed = rows.value[0];
    expect(observedApproval.value).toMatchObject({
      confirmations: 2,
      expectedConfirmations: 2,
      progressPct: 100,
      isFinalized: true,
    });
    expect(
      StabilizerBuyPurchases.getProgress(savedApproval, restoredCommand.data.transactionProgressByHash)
        .overallProgressPct,
    ).toBeCloseTo(100 / 6);
    expect(
      StabilizerBuyPurchases.getProgress(confirmed, restoredCommand.data.transactionProgressByHash).steps[1].status,
    ).toBe('active');
    expect(confirmed.usdcApprovalTxHash).toBe(savedApproval.usdcApprovalTxHash);
    expect(confirmed.usdcApprovalFeeWei).toBe(20n);
    expect(confirmed.ethereumFeeWei).toBe(40n);
    expect(confirmed.ethereumMaxFeeWei).toBe(1_000_000_000_000_000_001n);
    expect(confirmed.purchaseEthereumBlockNumber).toBe(42);
    expect(confirmed.purchaseEthereumBlockHash).toBe(`0x${'99'.repeat(32)}`);
    expect(confirmed).toMatchObject({
      spentMicrogons: 500_000n,
      ethereumFeeMicrogons: 1n,
      usdcApprovalFeeMicrogons: 1n,
    });
    expect(confirmed.usdcApprovalPrices).toEqual(quote.prices);
    expect(confirmed.ethereumPrices).toEqual(quote.prices);
    expect(confirmed.ethereumGatewayActivity).toMatchObject(activity);
    expect(confirmed.ethereumSubmittedAt!.getTime()).toBeGreaterThan(confirmed.createdAt.getTime());
    expect((await db.stabilizerBuysTable.fetchAll(walletKeys.defaultArgonAddress)).buys[0]).toMatchObject(confirmed);
    await restoredCommand.purchase({
      id: confirmed.id,
      ethereumQuote: quote,
      ethereumMaxFeeWei: 1_000_000n,
      ethereumWallet,
    });
    expect(receipts.size).toBe(2);
    expect(await db.crosschainInboundTransfersTable.fetchAll()).toEqual([]);

    revertPurchase = true;
    const execute = db.sql.execute.bind(db.sql);
    let failedWrite = false;
    vi.spyOn(db.sql, 'execute').mockImplementation(async (query, params) => {
      const result = await execute(query, params);
      if (
        query.includes('INSERT INTO StabilizerBuys') &&
        !failedWrite &&
        params?.includes(StabilizerBuyStatus.Failed)
      ) {
        failedWrite = true;
        throw new Error('Receipt write failed');
      }
      return result;
    });
    await restoredCommand.purchase({
      id: 'synthetic-failed-buy',
      ethereumQuote: quote,
      ethereumMaxFeeWei: 1_000_000n,
      ethereumWallet,
    });
    await vi.waitFor(() =>
      expect(rows.value.find(buy => buy.id === 'synthetic-failed-buy')?.status).toBe(StabilizerBuyStatus.Failed),
    );
    const failed = rows.value.find(buy => buy.id === 'synthetic-failed-buy')!;
    expect(failed).toMatchObject({ usdcApprovalFeeWei: 20n, ethereumFeeWei: 40n });
    expect(failed.statusError).toContain('reverted');
    expect(calculatePositionReturn(createStabilizerBuyFinancialPositions(restored.snapshot))).toMatchObject({
      availability: 'available',
      returnAmount: -2n,
    });
    expect(failedFeeRead && failedWrite).toBe(true);
    expect(receipts.size).toBe(4);
    expect(
      (await db.stabilizerBuysTable.fetchAll(walletKeys.defaultArgonAddress)).buys.find(buy => buy.id === failed.id),
    ).toMatchObject(failed);
    expect(rows.value.find(buy => buy.id === confirmed.id)?.status).toBe(
      StabilizerBuyStatus.WaitingForArgonRecognition,
    );
    await restoredCommand.close();
    await restored.close();
    await db.sql.close();
  });
});
