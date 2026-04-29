import { beforeAll, describe, expect, it, vi } from 'vitest';
import { MoveFrom, MoveTo } from '@argonprotocol/apps-core';
import { MoveCapital } from '../lib/MoveCapital.ts';
import { existentialDepositMicrogons, miningHoldOperationalReserveMicrogons } from '../lib/WalletForArgon.ts';
import { type IWallet } from '../lib/Wallet.ts';
import { buildOperatorAccountRegistrationTx } from '../lib/OperationalAccount.ts';
import { Config } from '../lib/Config.ts';
import { WalletKeys } from '../lib/WalletKeys.ts';
import { createTestDb } from './helpers/db.ts';
import { setDbPromise } from '../stores/helpers/dbPromise.ts';
import { createMockWalletKeys } from './helpers/wallet.ts';
import { ExtrinsicType, TransactionStatus } from '../lib/db/TransactionsTable.ts';
import { TxAttemptState } from '../lib/TransactionTracker.ts';

vi.mock('../lib/OperationalAccount.ts', () => ({
  buildOperatorAccountRegistrationTx: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../stores/mainchain.ts', () => ({
  getMainchainClient: vi.fn().mockResolvedValue({}),
}));

type MockTxInfo = {
  tx: {
    id: number;
    extrinsicType?: ExtrinsicType;
    metadataJson?: {
      moveFrom?: MoveFrom;
      moveTo?: MoveTo;
    };
  };
};

describe('MoveCapital', () => {
  let config: Config;
  let walletKeys: WalletKeys;
  beforeAll(async () => {
    const db = await createTestDb();
    setDbPromise(Promise.resolve(db));
    walletKeys = createMockWalletKeys();
    config = new Config(Promise.resolve(db), walletKeys);
  });
  it('keeps the mining hold operational reserve when sweeping to the bot', async () => {
    const { moveCapital, transactionTracker } = createMoveCapital();
    const calculateFeeSpy = vi.spyOn(moveCapital, 'calculateFee').mockResolvedValue(5n);
    const buildTransactionSpy = vi.spyOn(moveCapital, 'buildTransaction').mockResolvedValue({
      tx: 'transfer-tx' as any,
      metadata: {
        moveFrom: MoveFrom.MiningHold,
        moveTo: MoveTo.MiningBot,
        assetsToMove: { ARGNOT: 7n },
      },
    });
    vi.spyOn(moveCapital as any, 'getSigner').mockResolvedValue('signer');
    const txInfo = { tx: { id: 1 } } as any;
    transactionTracker.submitAndWatch.mockResolvedValue(txInfo);
    const wallet = createWallet({
      availableMicrogons: miningHoldOperationalReserveMicrogons + 50n,
      availableMicronots: 7n,
    });

    const result = await moveCapital.moveAvailableMiningHoldToBot(wallet, walletKeys, config);

    expect(calculateFeeSpy).toHaveBeenCalledWith(
      MoveFrom.MiningHold,
      MoveTo.MiningBot,
      { ARGN: 50n, ARGNOT: 7n },
      wallet,
      'mining-bot-address',
      [],
      expect.anything(),
    );
    expect(buildTransactionSpy).toHaveBeenCalledWith(
      MoveFrom.MiningHold,
      MoveTo.MiningBot,
      { ARGNOT: 7n },
      'mining-bot-address',
      [],
      expect.anything(),
    );
    expect(transactionTracker.submitAndWatch).toHaveBeenCalledWith({
      tx: 'transfer-tx',
      txSigner: 'signer',
      useLatestNonce: true,
      extrinsicType: ExtrinsicType.Transfer,
      metadata: {
        moveFrom: MoveFrom.MiningHold,
        moveTo: MoveTo.MiningBot,
        assetsToMove: { ARGNOT: 7n },
      },
    });
    expect(buildOperatorAccountRegistrationTx).toHaveBeenCalledOnce();
    expect(result).toBe(txInfo);
  });

  it('retries the fee calculation without argons when only argonots should move', async () => {
    const { moveCapital, transactionTracker } = createMoveCapital();
    const calculateFeeSpy = vi.spyOn(moveCapital, 'calculateFee').mockResolvedValueOnce(5n).mockResolvedValueOnce(2n);
    const buildTransactionSpy = vi.spyOn(moveCapital, 'buildTransaction').mockResolvedValue({
      tx: 'transfer-tx' as any,
      metadata: {
        moveFrom: MoveFrom.MiningHold,
        moveTo: MoveTo.MiningBot,
        assetsToMove: { ARGNOT: 4n },
      },
    });
    vi.spyOn(moveCapital as any, 'getSigner').mockResolvedValue('signer');
    transactionTracker.submitAndWatch.mockResolvedValue({} as any);
    const wallet = createWallet({
      availableMicrogons: miningHoldOperationalReserveMicrogons + 3n,
      availableMicronots: 4n,
    });

    await moveCapital.moveAvailableMiningHoldToBot(wallet, walletKeys, config);

    expect(calculateFeeSpy).toHaveBeenNthCalledWith(
      1,
      MoveFrom.MiningHold,
      MoveTo.MiningBot,
      { ARGN: 3n, ARGNOT: 4n },
      wallet,
      'mining-bot-address',
      [],
      expect.anything(),
    );
    expect(calculateFeeSpy).toHaveBeenNthCalledWith(
      2,
      MoveFrom.MiningHold,
      MoveTo.MiningBot,
      { ARGNOT: 4n },
      wallet,
      'mining-bot-address',
      [],
      expect.anything(),
    );
    expect(buildTransactionSpy).toHaveBeenCalledWith(
      MoveFrom.MiningHold,
      MoveTo.MiningBot,
      { ARGNOT: 4n },
      'mining-bot-address',
      [],
      expect.anything(),
    );
  });

  it('does not send argons below existential deposit when sweeping argonots', async () => {
    const { moveCapital, transactionTracker } = createMoveCapital();
    const calculateFeeSpy = vi.spyOn(moveCapital, 'calculateFee').mockResolvedValueOnce(15n).mockResolvedValueOnce(2n);
    const buildTransactionSpy = vi.spyOn(moveCapital, 'buildTransaction').mockResolvedValue({
      tx: 'transfer-tx' as any,
      metadata: {
        moveFrom: MoveFrom.MiningHold,
        moveTo: MoveTo.MiningBot,
        assetsToMove: { ARGNOT: 4n },
      },
    });
    vi.spyOn(moveCapital as any, 'getSigner').mockResolvedValue('signer');
    transactionTracker.submitAndWatch.mockResolvedValue({} as any);
    const wallet = createWallet({
      availableMicrogons: miningHoldOperationalReserveMicrogons + existentialDepositMicrogons + 5n,
      availableMicronots: 4n,
    });

    await moveCapital.moveAvailableMiningHoldToBot(wallet, walletKeys, config);

    expect(calculateFeeSpy).toHaveBeenNthCalledWith(
      1,
      MoveFrom.MiningHold,
      MoveTo.MiningBot,
      { ARGN: existentialDepositMicrogons + 5n, ARGNOT: 4n },
      wallet,
      'mining-bot-address',
      [],
      expect.anything(),
    );
    expect(calculateFeeSpy).toHaveBeenNthCalledWith(
      2,
      MoveFrom.MiningHold,
      MoveTo.MiningBot,
      { ARGNOT: 4n },
      wallet,
      'mining-bot-address',
      [],
      expect.anything(),
    );
    expect(buildTransactionSpy).toHaveBeenCalledWith(
      MoveFrom.MiningHold,
      MoveTo.MiningBot,
      { ARGNOT: 4n },
      'mining-bot-address',
      [],
      expect.anything(),
    );
  });

  it('skips the sweep when fee calculation reports insufficient funds', async () => {
    const { moveCapital, transactionTracker } = createMoveCapital();
    vi.spyOn(moveCapital, 'calculateFee').mockImplementation(async () => {
      moveCapital.transactionError = 'Your wallet has insufficient funds for this transaction.';
      return 0n;
    });
    const buildTransactionSpy = vi.spyOn(moveCapital, 'buildTransaction');
    const wallet = createWallet({ availableMicrogons: 10n, availableMicronots: 4n });

    const result = await moveCapital.moveAvailableMiningHoldToBot(wallet, walletKeys, config);

    expect(buildTransactionSpy).not.toHaveBeenCalled();
    expect(transactionTracker.submitAndWatch).not.toHaveBeenCalled();
    expect(result).toBeUndefined();
  });

  it('skips the sweep when fee calculation fails', async () => {
    const { moveCapital, transactionTracker } = createMoveCapital();
    vi.spyOn(moveCapital, 'calculateFee').mockImplementation(async () => {
      moveCapital.transactionError = 'Unable to calculate transaction fee.';
      return 0n;
    });
    const buildTransactionSpy = vi.spyOn(moveCapital, 'buildTransaction');

    const result = await moveCapital.moveAvailableMiningHoldToBot(
      createWallet({ availableMicronots: 4n }),
      walletKeys,
      config,
    );

    expect(buildTransactionSpy).not.toHaveBeenCalled();
    expect(transactionTracker.submitAndWatch).not.toHaveBeenCalled();
    expect(result).toBeUndefined();
  });

  it('skips the sweep when there is nothing available to move', async () => {
    const { moveCapital, transactionTracker } = createMoveCapital();
    const feeSpy = vi.spyOn(moveCapital, 'calculateFee').mockResolvedValue(0n);
    const buildTransactionSpy = vi.spyOn(moveCapital, 'buildTransaction');

    const result = await moveCapital.moveAvailableMiningHoldToBot(
      createWallet({ availableMicrogons: miningHoldOperationalReserveMicrogons }),
      walletKeys,
      config,
    );

    expect(feeSpy).not.toHaveBeenCalled();
    expect(buildTransactionSpy).not.toHaveBeenCalled();
    expect(transactionTracker.submitAndWatch).not.toHaveBeenCalled();
    expect(result).toBeUndefined();
  });

  it('reuses an in-flight mining hold sweep instead of submitting a duplicate move', async () => {
    const { moveCapital, transactionTracker } = createMoveCapital();
    vi.spyOn(moveCapital, 'calculateFee').mockResolvedValue(0n);
    vi.spyOn(moveCapital, 'buildTransaction').mockResolvedValue({
      tx: 'transfer-tx' as any,
      metadata: {
        moveFrom: MoveFrom.MiningHold,
        moveTo: MoveTo.MiningBot,
        assetsToMove: { ARGN: 50n, ARGNOT: 7n },
      },
    });
    vi.spyOn(moveCapital as any, 'getSigner').mockResolvedValue('signer');

    let resolveSubmit: ((value: any) => void) | undefined;
    const txInfo = {
      tx: {
        id: 1,
        status: TransactionStatus.Submitted,
        accountAddress: 'mining-hold-address',
      },
    } as any;
    transactionTracker.submitAndWatch.mockImplementation(
      () =>
        // eslint-disable-next-line @typescript-eslint/no-unsafe-return
        new Promise(resolve => {
          resolveSubmit = resolve;
        }) as any,
    );
    const wallet = createWallet({
      availableMicrogons: miningHoldOperationalReserveMicrogons + 50n,
      availableMicronots: 7n,
    });

    const firstSweep = moveCapital.moveAvailableMiningHoldToBot(wallet, walletKeys, config);
    const secondSweep = moveCapital.moveAvailableMiningHoldToBot(wallet, walletKeys, config);

    await vi.waitFor(() => expect(transactionTracker.submitAndWatch).toHaveBeenCalledOnce());

    resolveSubmit?.(txInfo);

    await expect(firstSweep).resolves.toBe(txInfo);
    await expect(secondSweep).resolves.toBe(txInfo);
  });

  it('follows an existing tracked mining hold sweep after reload', async () => {
    const existingTxInfo = {
      tx: {
        id: 7,
        extrinsicType: ExtrinsicType.Transfer,
        metadataJson: {
          moveFrom: MoveFrom.MiningHold,
          moveTo: MoveTo.MiningBot,
        },
      },
    } as any;
    const { moveCapital, transactionTracker } = createMoveCapital(existingTxInfo);
    transactionTracker.getTxAttemptState.mockResolvedValue(TxAttemptState.Follow);

    const result = await moveCapital.moveAvailableMiningHoldToBot(
      createWallet({
        availableMicrogons: miningHoldOperationalReserveMicrogons + 50n,
        availableMicronots: 7n,
      }),
      walletKeys,
      config,
    );

    expect(transactionTracker.submitAndWatch).not.toHaveBeenCalled();
    expect(result).toBe(existingTxInfo);
  });

  it('submits a new sweep after a prior mining hold sweep finalized', async () => {
    const existingTxInfo = {
      tx: {
        id: 7,
        extrinsicType: ExtrinsicType.Transfer,
        metadataJson: {
          moveFrom: MoveFrom.MiningHold,
          moveTo: MoveTo.MiningBot,
        },
      },
    } as any;
    const { moveCapital, transactionTracker } = createMoveCapital(existingTxInfo);
    transactionTracker.getTxAttemptState.mockResolvedValue(TxAttemptState.Finalized);
    vi.spyOn(moveCapital, 'calculateFee').mockResolvedValue(0n);
    vi.spyOn(moveCapital, 'buildTransaction').mockResolvedValue({
      tx: 'transfer-tx' as any,
      metadata: {
        moveFrom: MoveFrom.MiningHold,
        moveTo: MoveTo.MiningBot,
        assetsToMove: { ARGN: 50n, ARGNOT: 7n },
      },
    });
    vi.spyOn(moveCapital as any, 'getSigner').mockResolvedValue('signer');
    const newTxInfo = { tx: { id: 8 } } as any;
    transactionTracker.submitAndWatch.mockResolvedValue(newTxInfo);

    const result = await moveCapital.moveAvailableMiningHoldToBot(
      createWallet({
        availableMicrogons: miningHoldOperationalReserveMicrogons + 50n,
        availableMicronots: 7n,
      }),
      walletKeys,
      config,
    );

    expect(transactionTracker.submitAndWatch).toHaveBeenCalledOnce();
    expect(result).toBe(newTxInfo);
  });
});

function createMoveCapital(existingTxInfo?: MockTxInfo) {
  const transactionTracker = {
    load: vi.fn().mockResolvedValue(undefined),
    data: { txInfos: existingTxInfo ? [existingTxInfo] : [] },
    findLatestTxInfo: vi.fn((matcher: (txInfo: MockTxInfo) => boolean) => {
      if (!existingTxInfo) return undefined;
      return matcher(existingTxInfo) ? existingTxInfo : undefined;
    }),
    getTxAttemptState: vi.fn(),
    createIntentForFollowOnTx: vi.fn(),
    submitAndWatch: vi.fn(),
  };

  return {
    moveCapital: new MoveCapital(
      { miningBotAddress: 'mining-bot-address' } as any,
      transactionTracker as any,
      {} as any,
    ),
    transactionTracker,
  };
}

function createWallet(partial: Partial<IWallet>): IWallet {
  return {
    address: 'mining-hold-address',
    availableMicrogons: 0n,
    availableMicronots: 0n,
    reservedMicrogons: 0n,
    reservedMicronots: 0n,
    totalMicrogons: partial.availableMicrogons ?? 0n,
    totalMicronots: partial.availableMicronots ?? 0n,
    fetchErrorMsg: '',
    otherTokens: [],
    ...partial,
  };
}
