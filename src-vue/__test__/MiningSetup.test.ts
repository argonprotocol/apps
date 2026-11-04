// prettier-ignore
import { MoveFrom, MoveTo, MoveToken, TxSigner, type ArgonClient } from '@argonprotocol/apps-core';
import { describe, expect, it, vi } from 'vitest';

import { MiningSetupStatus, ServerType } from '../interfaces/IConfig.ts';
import { getMiningFundingState } from '../screens/mining-screen/miningFunding.ts';
import { MiningSetup, type MiningSetupInput } from '../lib/MiningSetup.ts';
import type { TransactionInfo } from '../lib/TransactionInfo.ts';
import { defaultArgonOperationalReserveMicrogons, existentialDepositMicronots } from '../lib/WalletForArgon.ts';
import { ExtrinsicType } from '../lib/db/TransactionsTable.ts';
import { TxAttemptState, type TransactionTracker } from '../lib/TransactionTracker.ts';
import { BalanceTransfer, type ITransactionMoveMetadata } from '../lib/txs/Balance.transfer.ts';
import { WalletKeys } from '../lib/WalletKeys.ts';
import { WalletSecrets } from '../lib/WalletSecrets.ts';
import { signatureVerify } from '@polkadot/util-crypto';
import { MiningBidProxySetup } from '../lib/txs/MiningBidProxy.setup.ts';
import * as mainchainStore from '../stores/mainchain.ts';
import { Config } from '../lib/Config.ts';
import { createTestDb } from './helpers/db.ts';

it('treats setup fees as a startup budget rather than unspent capital after installation starts', () => {
  const funding = {
    hasSavedBiddingRules: true,
    miningMicrogonsOnHand: 4_000_000n,
    miningMicronotsOnHand: 10_000n,
    initialMicrogonRequirement: 1_000_000n,
    initialMicronotRequirement: 10_000n,
  };
  const before = getMiningFundingState({ ...funding, miningSetupStatus: MiningSetupStatus.Checklist });
  expect(before.requiredMicrogons).toBe(4_000_000n);
  expect(before.isFullyFunded).toBe(true);

  // The proxy receives its float and setup spends fees; the bid capital remains available.
  const afterSetup = { ...funding, miningMicrogonsOnHand: 2_990_000n };
  for (const status of [MiningSetupStatus.Installing, MiningSetupStatus.Finished]) {
    const state = getMiningFundingState({ ...afterSetup, miningSetupStatus: status });
    expect(state.requiredMicrogons).toBe(1_000_000n);
    expect(state.additionalMicrogonsNeeded).toBe(0n);
    expect(state.isFullyFunded).toBe(true);
  }
});

describe('MiningSetup', () => {
  it('publishes bootstrap and configures the proxy using the unlocked session', async () => {
    const mnemonic = 'test test test test test test test test test test test junk';
    const walletKeys = new WalletKeys(
      WalletKeys.deriveIdentity(mnemonic),
      new WalletSecrets({ encryptedMnemonic: 'synthetic-encrypted-mnemonic' }),
    );
    walletKeys.initializeSession(mnemonic);
    const db = await createTestDb();
    const config = new Config(Promise.resolve(db));
    await config.load();
    config.isServerInstalled = true;
    config.biddingRules = {
      ...config.biddingRules,
      initialMicrogonRequirement: 1_000_000n,
      initialMicronotRequirement: 1_000_000n,
    };
    config.serverDetails = {
      ...config.serverDetails,
      type: ServerType.CustomServer,
      ipAddress: '203.0.113.10',
      sshUser: 'argon',
      sshPort: 22,
    };
    const tx = { paymentInfo: async () => ({ partialFee: { toBigInt: () => 25n } }) };
    const addProxy = vi.fn(() => tx);
    const client = {
      query: {
        system: { account: async () => ({ data: { free: 10_000_000n } }) },
        proxy: { proxies: async () => [[]] },
        bootstrap: {
          encryptedRecoveryPayloadByPubkey: async () => null,
          encryptedEndpointByPubkey: async () => null,
          endpointOwnerByPubkey: async () => null,
        },
      },
      tx: {
        proxy: { addProxy },
        balances: { transferAllowDeath: () => tx },
        ownership: { transferAllowDeath: () => tx },
        utility: { batchAll: () => tx },
        bootstrap: { setRecoveryPayload: () => tx, setEndpoint: () => tx },
      },
    } as unknown as ArgonClient;
    const mainchain = vi.spyOn(mainchainStore, 'getMainchainClient').mockResolvedValue(client);
    const followOn = { resolve: vi.fn(), reject: vi.fn() };
    const retained: TxSigner[] = [];
    const submittedTypes: ExtrinsicType[] = [];
    const challenge = new TextEncoder().encode('synthetic mining setup');
    let funding!: ReturnType<typeof createTxInfo>;
    let proxy!: ReturnType<typeof createTxInfo>;
    const transactionTracker = {
      ...createTransactionTracker([], followOn),
      findLatestTxAttempt: async () => undefined,
      submitAndWatch: async ({
        txSigner,
        extrinsicType,
        metadata,
      }: Parameters<TransactionTracker['submitAndWatch']>[0]) => {
        const expectedAddress =
          extrinsicType === ExtrinsicType.MiningBidProxySetup
            ? walletKeys.miningBotAddress
            : walletKeys.defaultArgonAddress;
        if (!(txSigner instanceof TxSigner)) throw new Error('Expected a wallet signer');
        expect(signatureVerify(challenge, txSigner.sign(challenge), expectedAddress).isValid).toBe(true);
        retained.push(txSigner);
        submittedTypes.push(extrinsicType);
        const submitted = createTxInfo(
          retained.length,
          extrinsicType,
          metadata,
          extrinsicType !== ExtrinsicType.Transfer,
        );
        transactionTracker.data.txInfos.push(submitted);
        if (extrinsicType === ExtrinsicType.Transfer) funding = submitted;
        else if (extrinsicType === ExtrinsicType.MiningBidProxySetup) proxy = submitted;
        return submitted as unknown as TransactionInfo;
      },
    };
    const tracker = transactionTracker as unknown as TransactionTracker;
    const proxySetup = new MiningBidProxySetup(walletKeys, tracker);
    const miningSetup = new MiningSetup(walletKeys, tracker, proxySetup, config);

    try {
      const result = await miningSetup.ensure({ ...createInput(), client });
      expect(result.kind).toBe('transaction');
      if (result.kind !== 'transaction') throw new Error('Expected a setup transaction.');
      expect(result.txInfo).toBe(funding);
      expect(funding.tx.metadataJson.assetsToMove).toEqual({
        [MoveToken.ARGN]: 4_000_000n,
        [MoveToken.ARGNOT]: 1_000_000n,
      });
      expect(retained.map(signer => signer.address)).toEqual([walletKeys.defaultArgonAddress]);

      funding.finish();
      await result.waitForCompletion;

      expect(retained.map(signer => signer.address)).toEqual([
        walletKeys.defaultArgonAddress,
        walletKeys.defaultArgonAddress,
        walletKeys.defaultArgonAddress,
        walletKeys.miningBotAddress,
      ]);
      expect(submittedTypes).toEqual([
        ExtrinsicType.Transfer,
        ExtrinsicType.BootstrapPublishRecovery,
        ExtrinsicType.BootstrapPublishEndpoint,
        ExtrinsicType.MiningBidProxySetup,
      ]);
      expect(config.serverDetails.bootstrapEndpointSequence).toBe(1);
      expect((await db.configTable.fetchAllAsObject()).serverDetails).toContain('"bootstrapEndpointSequence": 1');
      expect(addProxy).toHaveBeenCalledWith(
        (await walletKeys.getMiningBidProxySigner()).address,
        'MiningBidRealPaysFee',
        0,
      );
      expect(followOn.resolve).toHaveBeenCalledWith(proxy);
    } finally {
      mainchain.mockRestore();
      await db.close();
    }
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
    const miningSetup = new MiningSetup(
      {} as any,
      transactionTracker as any,
      proxySetup as any,
      { biddingRules: { initialMicrogonRequirement: 1_000_000n, initialMicronotRequirement: 1_000_000n } } as any,
    );

    const result = await miningSetup.ensure(createInput({ miningBotMicrogons: 2_000_000n }));

    expect(result.kind).toBe('transaction');
    if (result.kind !== 'transaction') throw new Error('Expected the recovered setup transaction.');
    expect(result.txInfo).toBe(proxy);
    await result.waitForCompletion;
    expect(followOn.resolve).toHaveBeenCalledWith(proxy);
  });

  it('resumes setup from a funding transaction created before workflow metadata was added', async () => {
    const funding = createTxInfo(
      1,
      ExtrinsicType.Transfer,
      {
        moveFrom: MoveFrom.DefaultArgon,
        moveTo: MoveTo.MiningBot,
        assetsToMove: { [MoveToken.ARGN]: 2_000_000n },
      },
      true,
    );
    const proxy = createTxInfo(
      2,
      ExtrinsicType.MiningBidProxySetup,
      { fundingAccountId: 'mining-address', proxyAccountId: 'proxy-address' },
      true,
    );
    const transactionTracker = createTransactionTracker([funding]);
    const proxySetup = createProxySetup({ kind: 'transaction', txInfo: proxy });
    const miningSetup = new MiningSetup(
      {} as any,
      transactionTracker as any,
      proxySetup as any,
      { biddingRules: { initialMicrogonRequirement: 1_000_000n, initialMicronotRequirement: 1_000_000n } } as any,
    );
    const submit = vi.spyOn(getFundingTransfer(miningSetup), 'submit');

    const result = await miningSetup.ensure(createInput({ miningBotMicrogons: 2_000_000n }));

    expect(result.kind).toBe('transaction');
    if (result.kind !== 'transaction') throw new Error('Expected the recovered proxy transaction.');
    expect(result.txInfo).toBe(proxy);
    expect(submit).not.toHaveBeenCalled();
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
      { biddingRules: { initialMicrogonRequirement: 1_000_000n, initialMicronotRequirement: 1_000_000n } } as any,
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
    Object.assign(failedProxy.tx, { blockExtrinsicErrorJson: { message: 'Proxy setup failed.' } });
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
      { biddingRules: { initialMicrogonRequirement: 1_000_000n, initialMicronotRequirement: 1_000_000n } } as any,
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
      { biddingRules: { initialMicrogonRequirement: 1_000_000n, initialMicronotRequirement: 1_000_000n } } as any,
    );

    getFundingTransfer(miningSetup).resume(funding as unknown as TransactionInfo<ITransactionMoveMetadata>);
    await expect(funding.waitForPostProcessing).rejects.toThrow('Mining account needs more ARGN.');

    const result = await miningSetup.ensure(createInput({ miningBotMicrogons: 2_000_000n }));

    expect(result.kind).toBe('transaction');
    if (result.kind !== 'transaction') throw new Error('Expected the proxy setup transaction.');
    expect(result.txInfo).toBe(proxy);
    expect(followOn.resolve).toHaveBeenCalledWith(proxy);
  });

  it.for([
    { balance: 4_000_000n, setupFeesPaid: false, proxyReady: true },
    { balance: 2_990_000n, setupFeesPaid: true, proxyReady: true },
    { balance: 2_990_000n, setupFeesPaid: true, proxyReady: false },
  ])('checks proxy readiness with $balance remaining ($proxyReady)', async ({ balance, setupFeesPaid, proxyReady }) => {
    const proxySetup = createProxySetup({ kind: 'ready' });
    if (!proxyReady) {
      proxySetup.ensure.mockResolvedValue({ kind: 'insufficientFunds', error: 'Proxy setup requires funding.' });
    }
    const miningSetup = new MiningSetup(
      {} as any,
      createTransactionTracker([]) as any,
      proxySetup as any,
      { biddingRules: { initialMicrogonRequirement: 1_000_000n, initialMicronotRequirement: 1_000_000n } } as any,
    );
    const submit = vi.spyOn(getFundingTransfer(miningSetup), 'submit');

    const input = createInput({ miningBotMicrogons: balance, miningBotMicronots: 1_000_000n });
    if (setupFeesPaid) {
      Object.assign(input.defaultWallet, {
        availableMicrogons: defaultArgonOperationalReserveMicrogons,
        availableMicronots: existentialDepositMicronots,
      });
    }
    const result = await miningSetup.ensure(input);

    expect(result.kind).toBe(proxyReady ? 'ready' : 'blocked');
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
