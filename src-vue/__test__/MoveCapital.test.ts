import { beforeAll, describe, expect, it, vi } from 'vitest';
import { MoveFrom, MoveTo, MoveToken } from '@argonprotocol/apps-core';
import { MoveCapital } from '../lib/MoveCapital.ts';
import {
  existentialDepositMicrogons,
  existentialDepositMicronots,
  defaultArgonOperationalReserveMicrogons,
} from '../lib/WalletForArgon.ts';
import { type IWallet } from '../lib/Wallet.ts';
import * as MiningAccount from '../lib/MiningAccount.ts';
import { Config } from '../lib/Config.ts';
import { WalletKeys } from '../lib/WalletKeys.ts';
import { createTestDb } from './helpers/db.ts';
import { setDbPromise } from '../stores/helpers/dbPromise.ts';
import { createMockWalletKeys } from './helpers/wallet.ts';
import { ExtrinsicType, TransactionStatus } from '../lib/db/TransactionsTable.ts';
import { TxAttemptState } from '../lib/TransactionTracker.ts';

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

let config: Config;
let walletKeys: WalletKeys;

describe('MoveCapital', () => {
  beforeAll(async () => {
    const db = await createTestDb();
    setDbPromise(Promise.resolve(db));
    walletKeys = createMockWalletKeys();
    config = new Config(Promise.resolve(db), walletKeys);
    await config.load();
    config.biddingRules = {
      ...config.biddingRules,
      initialMicrogonRequirement: 1_000_000n,
      initialMicronotRequirement: 1_000_000n,
    };
  });

  it('submits vault security moves through the vault allocation path', async () => {
    const { moveCapital, myVault } = createMoveCapital();
    const txInfo = { tx: { id: 11 } } as any;
    myVault.increaseVaultSecuritization.mockResolvedValue(txInfo);
    const wallet = createWallet({ address: 'vaulting-address', availableMicrogons: 250n });

    const result = await moveCapital.move(
      MoveFrom.DefaultArgon,
      MoveTo.VaultingSecurity,
      { [MoveToken.ARGN]: 100n },
      wallet,
      'vaulting-address',
    );

    expect(myVault.increaseVaultSecuritization).toHaveBeenCalledWith({
      addedSecuritizationMicrogons: 100n,
      metadata: {
        moveFrom: MoveFrom.DefaultArgon,
        moveTo: MoveTo.VaultingSecurity,
        externalAddress: undefined,
        assetsToMove: { [MoveToken.ARGN]: 100n },
      },
    });
    expect(result).toBe(txInfo);
  });

  it('calculates vault security move fees from the actual allocation transaction', async () => {
    const { moveCapital, myVault } = createMoveCapital();
    const allocationTx = createMockFeeTx(7n);
    myVault.buildIncreaseBitcoinSecurityTx.mockResolvedValue(allocationTx);
    const buildTransactionSpy = vi.spyOn(moveCapital, 'buildTransaction');
    const wallet = createWallet({ address: 'vaulting-address', availableMicrogons: 250n });
    const client = { id: 'client' } as any;

    const fee = await moveCapital.calculateFee(
      MoveFrom.DefaultArgon,
      MoveTo.VaultingSecurity,
      { [MoveToken.ARGN]: 100n },
      wallet,
      'vaulting-address',
      [],
      client,
    );

    expect(myVault.buildIncreaseBitcoinSecurityTx).toHaveBeenCalledWith(100n, client);
    expect(allocationTx.paymentInfo).toHaveBeenCalledWith('vaulting-address');
    expect(buildTransactionSpy).not.toHaveBeenCalled();
    expect(fee).toBe(7n);
  });

  it('rejects argonot moves into vault security', async () => {
    const { moveCapital, myVault } = createMoveCapital();
    const wallet = createWallet({ address: 'vaulting-address', availableMicrogons: 250n, availableMicronots: 10n });

    await expect(
      moveCapital.move(
        MoveFrom.DefaultArgon,
        MoveTo.VaultingSecurity,
        { [MoveToken.ARGNOT]: 10n },
        wallet,
        'vaulting-address',
      ),
    ).rejects.toThrow('Only ARGN can be moved into vault allocations.');
    expect(myVault.increaseVaultSecuritization).not.toHaveBeenCalled();
  });

  it('does not treat Ethereum addresses as valid external move destinations', () => {
    const { moveCapital } = createMoveCapital();

    expect(moveCapital.checkAddressType('0x742d35Cc6634C0532925a3b844Bc454e4438f44e')).toEqual({
      isArgonAddress: false,
      addressWarning: 'The address entered is not a valid Argon address.',
    });
  });

  it('keeps the default wallet reserves when sweeping to the bot', async () => {
    const { moveCapital, transactionTracker, postProcessMiningBidProxySetupSpy } = createMoveCapital();
    postProcessMiningBidProxySetupSpy.mockRestore();
    const calculateFeeSpy = vi.spyOn(moveCapital, 'calculateFee').mockResolvedValue(5n);
    const buildTransactionSpy = vi.spyOn(moveCapital, 'buildTransaction').mockResolvedValue({
      tx: 'transfer-tx' as any,
      metadata: {
        moveFrom: MoveFrom.DefaultArgon,
        moveTo: MoveTo.MiningBot,
        assetsToMove: { ARGNOT: 7n },
      },
    });
    vi.spyOn(moveCapital as any, 'getSigner').mockResolvedValue('signer');
    let resolveProxySetup: () => void = () => undefined;
    const proxySetupWait = new Promise<void>(resolve => {
      resolveProxySetup = resolve;
    });
    const postProcessor = {
      resolve: vi.fn(),
      reject: vi.fn(),
    };
    const txInfo = {
      tx: { id: 1 },
      txResult: {
        waitForFinalizedBlock: Promise.resolve(undefined),
      },
      createPostProcessor: vi.fn().mockReturnValue(postProcessor),
    } as any;
    transactionTracker.submitAndWatch.mockResolvedValue(txInfo);
    vi.spyOn(MiningAccount, 'ensureMiningBidProxySetup').mockResolvedValue({
      kind: 'submitted',
      txInfo: {
        waitForPostProcessing: proxySetupWait,
      },
    } as any);
    const wallet = createWallet({
      availableMicrogons: 1_000_050n,
      availableMicronots: existentialDepositMicronots + 7n,
    });

    const result = await moveCapital.moveConfiguredDefaultArgonToBot(createMiningTransferArgs(wallet));

    expect(calculateFeeSpy).toHaveBeenCalledWith(
      MoveFrom.DefaultArgon,
      MoveTo.MiningBot,
      { ARGN: 50n, ARGNOT: 7n },
      wallet,
      'mining-bot-address',
      [],
      expect.anything(),
    );
    expect(buildTransactionSpy).toHaveBeenCalledWith(
      MoveFrom.DefaultArgon,
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
        moveFrom: MoveFrom.DefaultArgon,
        moveTo: MoveTo.MiningBot,
        assetsToMove: { ARGNOT: 7n },
      },
    });
    expect(result).toEqual({ kind: 'submitted', txInfo });

    await vi.waitFor(() => expect(MiningAccount.ensureMiningBidProxySetup).toHaveBeenCalledOnce());
    expect(postProcessor.resolve).not.toHaveBeenCalled();

    resolveProxySetup();

    await vi.waitFor(() => expect(postProcessor.resolve).toHaveBeenCalledOnce());
    expect(postProcessor.reject).not.toHaveBeenCalled();
  });

  it('moves the configured minimum mining balance and proxy reserve when the default wallet has more', async () => {
    const { moveCapital, transactionTracker } = createMoveCapital();
    vi.spyOn(moveCapital, 'calculateFee').mockResolvedValue(5n);
    const buildTransactionSpy = vi.spyOn(moveCapital, 'buildTransaction').mockResolvedValue({
      tx: 'transfer-tx' as any,
      metadata: {
        moveFrom: MoveFrom.DefaultArgon,
        moveTo: MoveTo.MiningBot,
        assetsToMove: { ARGN: 1_000_000n },
      },
    });
    vi.spyOn(moveCapital as any, 'getSigner').mockResolvedValue('signer');
    transactionTracker.submitAndWatch.mockResolvedValue({} as any);
    const wallet = createWallet({
      availableMicrogons: defaultArgonOperationalReserveMicrogons + 2_000_105n,
    });

    await moveCapital.moveConfiguredDefaultArgonToBot(createMiningTransferArgs(wallet));

    expect(buildTransactionSpy).toHaveBeenCalledWith(
      MoveFrom.DefaultArgon,
      MoveTo.MiningBot,
      { ARGN: 2_000_000n },
      'mining-bot-address',
      [],
      expect.anything(),
    );
  });

  it('retries the fee calculation without argons when only argonots should move', async () => {
    const { moveCapital, transactionTracker } = createMoveCapital();
    const calculateFeeSpy = vi.spyOn(moveCapital, 'calculateFee').mockResolvedValueOnce(5n).mockResolvedValueOnce(2n);
    const buildTransactionSpy = vi.spyOn(moveCapital, 'buildTransaction').mockResolvedValue({
      tx: 'transfer-tx' as any,
      metadata: {
        moveFrom: MoveFrom.DefaultArgon,
        moveTo: MoveTo.MiningBot,
        assetsToMove: { ARGNOT: 4n },
      },
    });
    vi.spyOn(moveCapital as any, 'getSigner').mockResolvedValue('signer');
    transactionTracker.submitAndWatch.mockResolvedValue({} as any);
    const wallet = createWallet({
      availableMicrogons: defaultArgonOperationalReserveMicrogons + 3n,
      availableMicronots: existentialDepositMicronots + 4n,
    });

    await moveCapital.moveConfiguredDefaultArgonToBot(createMiningTransferArgs(wallet));

    expect(calculateFeeSpy).toHaveBeenNthCalledWith(
      1,
      MoveFrom.DefaultArgon,
      MoveTo.MiningBot,
      { ARGN: 3n, ARGNOT: 4n },
      wallet,
      'mining-bot-address',
      [],
      expect.anything(),
    );
    expect(calculateFeeSpy).toHaveBeenNthCalledWith(
      2,
      MoveFrom.DefaultArgon,
      MoveTo.MiningBot,
      { ARGNOT: 4n },
      wallet,
      'mining-bot-address',
      [],
      expect.anything(),
    );
    expect(buildTransactionSpy).toHaveBeenCalledWith(
      MoveFrom.DefaultArgon,
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
        moveFrom: MoveFrom.DefaultArgon,
        moveTo: MoveTo.MiningBot,
        assetsToMove: { ARGNOT: 4n },
      },
    });
    vi.spyOn(moveCapital as any, 'getSigner').mockResolvedValue('signer');
    transactionTracker.submitAndWatch.mockResolvedValue({} as any);
    const wallet = createWallet({
      availableMicrogons: defaultArgonOperationalReserveMicrogons + existentialDepositMicrogons + 5n,
      availableMicronots: existentialDepositMicronots + 4n,
    });

    await moveCapital.moveConfiguredDefaultArgonToBot(createMiningTransferArgs(wallet));

    expect(calculateFeeSpy).toHaveBeenNthCalledWith(
      1,
      MoveFrom.DefaultArgon,
      MoveTo.MiningBot,
      { ARGN: existentialDepositMicrogons + 5n, ARGNOT: 4n },
      wallet,
      'mining-bot-address',
      [],
      expect.anything(),
    );
    expect(calculateFeeSpy).toHaveBeenNthCalledWith(
      2,
      MoveFrom.DefaultArgon,
      MoveTo.MiningBot,
      { ARGNOT: 4n },
      wallet,
      'mining-bot-address',
      [],
      expect.anything(),
    );
    expect(buildTransactionSpy).toHaveBeenCalledWith(
      MoveFrom.DefaultArgon,
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
    const wallet = createWallet({
      availableMicrogons: 10n,
      availableMicronots: existentialDepositMicronots + 4n,
    });

    const result = await moveCapital.moveConfiguredDefaultArgonToBot(createMiningTransferArgs(wallet));

    expect(buildTransactionSpy).not.toHaveBeenCalled();
    expect(transactionTracker.submitAndWatch).not.toHaveBeenCalled();
    expect(result).toEqual({
      kind: 'blocked',
      error: 'Your wallet has insufficient funds for this transaction.',
    });
  });

  it('reports a transaction error when the sweep fee exceeds the default Argon balance', async () => {
    const { moveCapital } = createMoveCapital();
    vi.spyOn(moveCapital, 'buildTransaction').mockResolvedValue({
      tx: createMockFeeTx(12n) as any,
      metadata: {
        moveFrom: MoveFrom.DefaultArgon,
        moveTo: MoveTo.MiningBot,
        assetsToMove: { ARGNOT: 4n },
      },
    });

    const fee = await moveCapital.calculateFee(
      MoveFrom.DefaultArgon,
      MoveTo.MiningBot,
      { ARGNOT: 4n },
      createWallet({ availableMicrogons: 10n, availableMicronots: 4n }),
      'mining-bot-address',
    );

    expect(fee).toBe(0n);
    expect(moveCapital.transactionError).toBe('Your wallet has insufficient funds for this transaction.');
  });

  it('skips the sweep when fee calculation fails', async () => {
    const { moveCapital, transactionTracker } = createMoveCapital();
    vi.spyOn(moveCapital, 'calculateFee').mockImplementation(async () => {
      moveCapital.transactionError = 'Unable to calculate transaction fee.';
      return 0n;
    });
    const buildTransactionSpy = vi.spyOn(moveCapital, 'buildTransaction');

    const result = await moveCapital.moveConfiguredDefaultArgonToBot(
      createMiningTransferArgs(createWallet({ availableMicronots: existentialDepositMicronots + 4n })),
    );

    expect(buildTransactionSpy).not.toHaveBeenCalled();
    expect(transactionTracker.submitAndWatch).not.toHaveBeenCalled();
    expect(result).toEqual({
      kind: 'blocked',
      error: 'Unable to calculate transaction fee.',
    });
  });

  it('skips the sweep when the mining bot already holds the configured requirement', async () => {
    const { moveCapital, transactionTracker } = createMoveCapital();
    const feeSpy = vi.spyOn(moveCapital, 'calculateFee');
    const buildTransactionSpy = vi.spyOn(moveCapital, 'buildTransaction');
    const defaultWallet = createWallet({
      availableMicrogons: defaultArgonOperationalReserveMicrogons + 5_000_000n,
      availableMicronots: existentialDepositMicronots + 5_000_000n,
    });
    const miningBotWallet = createWallet({
      address: 'mining-bot-address',
      reservedMicrogons: 2_000_000n,
      reservedMicronots: 1_000_000n,
    });

    const result = await moveCapital.moveConfiguredDefaultArgonToBot(
      createMiningTransferArgs(defaultWallet, miningBotWallet),
    );

    expect(feeSpy).not.toHaveBeenCalled();
    expect(buildTransactionSpy).not.toHaveBeenCalled();
    expect(transactionTracker.submitAndWatch).not.toHaveBeenCalled();
    expect(result).toEqual({ kind: 'noSpendableFundsToSweep' });
    expect(moveCapital.transactionError).toBe('');
  });

  it('reuses an in-flight default Argon mining transfer instead of submitting a duplicate move', async () => {
    const { moveCapital, transactionTracker } = createMoveCapital();
    vi.spyOn(moveCapital, 'calculateFee').mockResolvedValue(0n);
    vi.spyOn(moveCapital, 'buildTransaction').mockResolvedValue({
      tx: 'transfer-tx' as any,
      metadata: {
        moveFrom: MoveFrom.DefaultArgon,
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
      availableMicrogons: defaultArgonOperationalReserveMicrogons + 50n,
      availableMicronots: existentialDepositMicronots + 7n,
    });

    const transferArgs = createMiningTransferArgs(wallet);
    const firstSweep = moveCapital.moveConfiguredDefaultArgonToBot(transferArgs);
    const secondSweep = moveCapital.moveConfiguredDefaultArgonToBot(transferArgs);

    await vi.waitFor(() => expect(transactionTracker.submitAndWatch).toHaveBeenCalledOnce());

    resolveSubmit?.(txInfo);

    await expect(firstSweep).resolves.toEqual({ kind: 'submitted', txInfo });
    await expect(secondSweep).resolves.toEqual({ kind: 'submitted', txInfo });
  });

  it('follows an existing tracked default Argon mining transfer after reload', async () => {
    const existingTxInfo = {
      tx: {
        id: 7,
        extrinsicType: ExtrinsicType.Transfer,
        metadataJson: {
          moveFrom: MoveFrom.DefaultArgon,
          moveTo: MoveTo.MiningBot,
        },
      },
    } as any;
    const { moveCapital, transactionTracker } = createMoveCapital(existingTxInfo);
    transactionTracker.getTxAttemptState.mockResolvedValue(TxAttemptState.Follow);

    const result = await moveCapital.moveConfiguredDefaultArgonToBot(
      createMiningTransferArgs(
        createWallet({
          availableMicrogons: defaultArgonOperationalReserveMicrogons + 50n,
          availableMicronots: existentialDepositMicronots + 7n,
        }),
      ),
    );

    expect(transactionTracker.submitAndWatch).not.toHaveBeenCalled();
    expect(result).toEqual({
      kind: 'trackingExisting',
      txInfo: existingTxInfo,
    });
  });

  it('submits a new sweep after a prior default Argon mining transfer finalized', async () => {
    const existingTxInfo = {
      tx: {
        id: 7,
        extrinsicType: ExtrinsicType.Transfer,
        metadataJson: {
          moveFrom: MoveFrom.DefaultArgon,
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
        moveFrom: MoveFrom.DefaultArgon,
        moveTo: MoveTo.MiningBot,
        assetsToMove: { ARGN: 50n, ARGNOT: 7n },
      },
    });
    vi.spyOn(moveCapital as any, 'getSigner').mockResolvedValue('signer');
    const newTxInfo = { tx: { id: 8 } } as any;
    transactionTracker.submitAndWatch.mockResolvedValue(newTxInfo);

    const result = await moveCapital.moveConfiguredDefaultArgonToBot(
      createMiningTransferArgs(
        createWallet({
          availableMicrogons: defaultArgonOperationalReserveMicrogons + 50n,
          availableMicronots: existentialDepositMicronots + 7n,
        }),
      ),
    );

    expect(transactionTracker.submitAndWatch).toHaveBeenCalledOnce();
    expect(result).toEqual({ kind: 'submitted', txInfo: newTxInfo });
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
  const myVault = {
    increaseVaultSecuritization: vi.fn(),
    buildIncreaseBitcoinSecurityTx: vi.fn(),
    recordFinalizedVaultCapital: vi.fn(),
  };
  const moveCapitalWalletKeys = {
    miningBotAddress: 'mining-bot-address',
    getMiningBotKeypair: walletKeys.getMiningBotKeypair.bind(walletKeys),
    getMiningBidProxyKeypair: walletKeys.getMiningBidProxyKeypair.bind(walletKeys),
    getWalletKeypair: walletKeys.getWalletKeypair.bind(walletKeys),
  } as WalletKeys;
  const moveCapital = new MoveCapital(moveCapitalWalletKeys, transactionTracker as any, myVault as any);

  vi.spyOn(MiningAccount, 'ensureMiningBidProxySetup').mockResolvedValue({ kind: 'ready' });
  const postProcessMiningBidProxySetupSpy = vi
    .spyOn(moveCapital as any, 'postProcessMiningBidProxySetup')
    .mockResolvedValue(undefined);

  return {
    moveCapital,
    transactionTracker,
    myVault,
    postProcessMiningBidProxySetupSpy,
  };
}

type MockFeeTx = {
  paymentInfo: () => Promise<{ partialFee: { toBigInt: () => bigint } }>;
};

function createMockFeeTx(fee: bigint): MockFeeTx {
  return {
    paymentInfo: vi.fn().mockResolvedValue({
      partialFee: {
        toBigInt: () => fee,
      },
    }),
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

function createMiningTransferArgs(
  defaultWallet: IWallet,
  miningBotWallet = createWallet({ address: 'mining-bot-address' }),
) {
  return {
    defaultWallet,
    miningBotWallet,
    config,
  };
}
