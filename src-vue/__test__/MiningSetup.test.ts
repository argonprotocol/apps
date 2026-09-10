import { MINING_BID_PROXY_FEE_FLOAT, MoveFrom, MoveTo, MoveToken } from '@argonprotocol/apps-core';
import { describe, expect, it, vi } from 'vitest';

import { MiningSetup, type MiningSetupInput } from '../lib/MiningSetup.ts';
import type { TransactionInfo } from '../lib/TransactionInfo.ts';
import { defaultArgonOperationalReserveMicrogons, existentialDepositMicronots } from '../lib/WalletForArgon.ts';
import { ExtrinsicType } from '../lib/db/TransactionsTable.ts';
import { TxAttemptState } from '../lib/TransactionTracker.ts';
import { BalanceTransfer, type ITransactionMoveMetadata } from '../lib/txs/Balance.transfer.ts';

describe('MiningSetup', () => {
  it('runs proxy setup as post-processing for the funding transaction', async () => {
    const funding = createTxInfo(1, ExtrinsicType.Transfer, {
      moveFrom: MoveFrom.DefaultArgon,
      moveTo: MoveTo.MiningBot,
      assetsToMove: {
        [MoveToken.ARGN]: 1_000_000n + MINING_BID_PROXY_FEE_FLOAT,
        [MoveToken.ARGNOT]: 1_000_000n,
      },
      workflow: 'miningSetup',
    });
    const proxy = createTxInfo(
      2,
      ExtrinsicType.MiningBidProxySetup,
      { fundingAccountId: 'mining-address', proxyAccountId: 'proxy-address' },
      true,
    );
    const followOn = { resolve: vi.fn(), reject: vi.fn() };
    const transactionTracker = createTransactionTracker([], followOn);
    const proxySetup = createProxySetup({ kind: 'transaction', txInfo: proxy });
    const miningSetup = new MiningSetup({} as any, transactionTracker as any, proxySetup as any);
    const fundingTransfer = getFundingTransfer(miningSetup);
    vi.spyOn(fundingTransfer, 'estimateFee').mockResolvedValue(25n);
    const submit = vi.spyOn(fundingTransfer, 'submit').mockImplementation(async () => {
      fundingTransfer.resume(funding as unknown as TransactionInfo<ITransactionMoveMetadata>);
      return funding as unknown as TransactionInfo<ITransactionMoveMetadata>;
    });

    const result = await miningSetup.ensure(createInput());

    expect(result.kind).toBe('transaction');
    if (result.kind !== 'transaction') throw new Error('Expected a setup transaction.');
    expect(result.txInfo).toBe(funding);
    expect(proxySetup.ensure).not.toHaveBeenCalled();

    funding.finish();
    await result.waitForCompletion;

    expect(proxySetup.ensure).toHaveBeenCalledOnce();
    expect(followOn.resolve).toHaveBeenCalledWith(proxy);
    expect(submit).toHaveBeenCalledWith(
      expect.objectContaining({
        moveFrom: MoveFrom.DefaultArgon,
        moveTo: MoveTo.MiningBot,
        workflow: 'miningSetup',
      }),
    );
  });

  it('resumes proxy setup from a finalized funding transaction after restart', async () => {
    const funding = createTxInfo(
      1,
      ExtrinsicType.Transfer,
      {
        moveFrom: MoveFrom.DefaultArgon,
        moveTo: MoveTo.MiningBot,
        assetsToMove: { [MoveToken.ARGN]: 2_000_000n },
        workflow: 'miningSetup',
      },
      true,
    );
    const proxy = createTxInfo(
      2,
      ExtrinsicType.MiningBidProxySetup,
      { fundingAccountId: 'mining-address', proxyAccountId: 'proxy-address' },
      true,
    );
    const followOn = { resolve: vi.fn(), reject: vi.fn() };
    const transactionTracker = createTransactionTracker([funding], followOn);
    const proxySetup = createProxySetup({ kind: 'transaction', txInfo: proxy });
    const miningSetup = new MiningSetup({} as any, transactionTracker as any, proxySetup as any);

    const result = await miningSetup.ensure(createInput({ miningBotMicrogons: 2_000_000n }));

    expect(result.kind).toBe('transaction');
    if (result.kind !== 'transaction') throw new Error('Expected the recovered setup transaction.');
    expect(result.txInfo).toBe(proxy);
    await result.waitForCompletion;
    expect(followOn.resolve).toHaveBeenCalledWith(proxy);
  });

  it('waits on the linked proxy transaction when restarting during phase two', async () => {
    const funding = createTxInfo(
      1,
      ExtrinsicType.Transfer,
      {
        moveFrom: MoveFrom.DefaultArgon,
        moveTo: MoveTo.MiningBot,
        assetsToMove: { [MoveToken.ARGN]: 2_000_000n },
        workflow: 'miningSetup',
      },
      true,
    );
    const proxy = createTxInfo(2, ExtrinsicType.MiningBidProxySetup, {
      fundingAccountId: 'mining-address',
      proxyAccountId: 'proxy-address',
    });
    funding.tx.followOnTxId = proxy.tx.id;
    funding.followOnTxInfo = Promise.resolve(proxy);
    const proxySetup = createProxySetup();
    const miningSetup = new MiningSetup(
      {} as any,
      createTransactionTracker([funding, proxy]) as any,
      proxySetup as any,
    );

    const result = await miningSetup.ensure(createInput({ miningBotMicrogons: 2_000_000n }));

    expect(result.kind).toBe('transaction');
    if (result.kind !== 'transaction') throw new Error('Expected the recovered setup transaction.');
    expect(proxySetup.ensure).not.toHaveBeenCalled();

    proxy.finish();
    await result.waitForCompletion;
  });

  it('retries a failed linked proxy transaction after restart', async () => {
    const funding = createTxInfo(
      1,
      ExtrinsicType.Transfer,
      {
        moveFrom: MoveFrom.DefaultArgon,
        moveTo: MoveTo.MiningBot,
        assetsToMove: { [MoveToken.ARGN]: 2_000_000n },
        workflow: 'miningSetup',
      },
      true,
    );
    const failedProxy = createTxInfo(
      2,
      ExtrinsicType.MiningBidProxySetup,
      { fundingAccountId: 'mining-address', proxyAccountId: 'proxy-address' },
      true,
    );
    failedProxy.txResult.extrinsicError = new Error('Proxy setup failed.');
    const replacementProxy = createTxInfo(
      3,
      ExtrinsicType.MiningBidProxySetup,
      { fundingAccountId: 'mining-address', proxyAccountId: 'proxy-address' },
      true,
    );
    funding.tx.followOnTxId = failedProxy.tx.id;
    funding.followOnTxInfo = Promise.resolve(failedProxy);
    const proxySetup = createProxySetup({ kind: 'transaction', txInfo: replacementProxy });
    const followOn = { resolve: vi.fn(), reject: vi.fn() };
    const miningSetup = new MiningSetup(
      {} as any,
      createTransactionTracker([funding, failedProxy], followOn) as any,
      proxySetup as any,
    );

    const result = await miningSetup.ensure(createInput({ miningBotMicrogons: 2_000_000n }));

    expect(result.kind).toBe('transaction');
    if (result.kind !== 'transaction') throw new Error('Expected the replacement proxy transaction.');
    expect(result.txInfo).toBe(replacementProxy);
    expect(proxySetup.ensure).toHaveBeenCalledOnce();
    expect(followOn.resolve).not.toHaveBeenCalled();
  });

  it('can retry proxy setup after the funding post-processor was blocked', async () => {
    const funding = createTxInfo(
      1,
      ExtrinsicType.Transfer,
      {
        moveFrom: MoveFrom.DefaultArgon,
        moveTo: MoveTo.MiningBot,
        assetsToMove: { [MoveToken.ARGN]: 2_000_000n },
        workflow: 'miningSetup',
      },
      true,
    );
    const proxy = createTxInfo(
      2,
      ExtrinsicType.MiningBidProxySetup,
      { fundingAccountId: 'mining-address', proxyAccountId: 'proxy-address' },
      true,
    );
    const followOn = { resolve: vi.fn(), reject: vi.fn() };
    const proxySetup = createProxySetup();
    proxySetup.ensure
      .mockResolvedValueOnce({ kind: 'insufficientFunds', error: 'Mining account needs more ARGN.' })
      .mockResolvedValueOnce({ kind: 'transaction', txInfo: proxy });
    const miningSetup = new MiningSetup(
      {} as any,
      createTransactionTracker([funding], followOn) as any,
      proxySetup as any,
    );

    getFundingTransfer(miningSetup).resume(funding as unknown as TransactionInfo<ITransactionMoveMetadata>);
    await expect(funding.waitForPostProcessing).rejects.toThrow('Mining account needs more ARGN.');

    const result = await miningSetup.ensure(createInput({ miningBotMicrogons: 2_000_000n }));

    expect(result.kind).toBe('transaction');
    if (result.kind !== 'transaction') throw new Error('Expected the proxy setup transaction.');
    expect(result.txInfo).toBe(proxy);
    expect(followOn.resolve).toHaveBeenCalledWith(proxy);
  });

  it('does not create a funding transaction when funding and proxy setup are ready', async () => {
    const proxySetup = createProxySetup({ kind: 'ready' });
    const miningSetup = new MiningSetup({} as any, createTransactionTracker([]) as any, proxySetup as any);
    const submit = vi.spyOn(getFundingTransfer(miningSetup), 'submit');

    const result = await miningSetup.ensure(
      createInput({ miningBotMicrogons: 2_000_000n, miningBotMicronots: 1_000_000n }),
    );

    expect(result).toEqual({ kind: 'ready' });
    expect(submit).not.toHaveBeenCalled();
  });
});

function createInput(options: { miningBotMicrogons?: bigint; miningBotMicronots?: bigint } = {}): MiningSetupInput {
  return {
    defaultWallet: {
      availableMicrogons: defaultArgonOperationalReserveMicrogons + 5_000_000n,
      availableMicronots: existentialDepositMicronots + 2_000_000n,
    },
    miningBotWallet: {
      availableMicrogons: options.miningBotMicrogons ?? 0n,
      reservedMicrogons: 0n,
      availableMicronots: options.miningBotMicronots ?? 0n,
      reservedMicronots: 0n,
    },
    config: {
      biddingRules: {
        initialMicrogonRequirement: 1_000_000n,
        initialMicronotRequirement: 1_000_000n,
      },
    },
    client: {},
  } as unknown as MiningSetupInput;
}

function getFundingTransfer(miningSetup: MiningSetup): BalanceTransfer {
  return (miningSetup as unknown as { fundingTransfer: BalanceTransfer }).fundingTransfer;
}

function createProxySetup(result?: unknown) {
  return {
    load: vi.fn().mockResolvedValue(undefined),
    ensure: result === undefined ? vi.fn() : vi.fn().mockResolvedValue(result),
  };
}

function createTransactionTracker(txInfos: any[], followOn = { resolve: vi.fn(), reject: vi.fn() }) {
  return {
    data: { txInfos },
    pendingBlockTxInfosAtLoad: [],
    load: vi.fn().mockResolvedValue(undefined),
    getTxAttemptState: vi.fn().mockResolvedValue(TxAttemptState.Pending),
    createIntentForFollowOnTx: vi.fn().mockReturnValue(followOn),
  };
}

function createTxInfo(id: number, extrinsicType: ExtrinsicType, metadataJson: any, finalized = false) {
  let resolveFinalization!: () => void;
  const waitForFinalizedBlock = finalized
    ? Promise.resolve()
    : new Promise<void>(resolve => {
        resolveFinalization = resolve;
      });
  let postProcessor:
    | {
        isSettled: boolean;
        promise: Promise<void>;
        resolve: () => void;
        reject: (error: Error) => void;
      }
    | undefined;

  const txInfo = {
    tx: { id, extrinsicType, metadataJson, isFinalized: finalized, followOnTxId: undefined as number | undefined },
    txResult: { waitForFinalizedBlock, isFinalized: finalized, extrinsicError: undefined as Error | undefined },
    followOnTxInfo: Promise.resolve(undefined) as Promise<any>,
    get hasPendingPostProcessing() {
      return postProcessor ? !postProcessor.isSettled : false;
    },
    get isPostProcessed() {
      return postProcessor?.isSettled ?? true;
    },
    get waitForPostProcessing() {
      return postProcessor?.promise ?? waitForFinalizedBlock;
    },
    createPostProcessor() {
      if (postProcessor) return postProcessor;

      let resolvePromise!: () => void;
      let rejectPromise!: (error: Error) => void;
      const promise = new Promise<void>((resolve, reject) => {
        resolvePromise = resolve;
        rejectPromise = reject;
      });
      postProcessor = {
        isSettled: false,
        promise,
        resolve: () => {
          postProcessor!.isSettled = true;
          resolvePromise();
        },
        reject: error => {
          postProcessor!.isSettled = true;
          rejectPromise(error);
        },
      };
      return postProcessor;
    },
    finish() {
      txInfo.tx.isFinalized = true;
      txInfo.txResult.isFinalized = true;
      resolveFinalization?.();
    },
  };
  return txInfo;
}
