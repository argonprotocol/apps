import { MoveFrom, MoveTo, MoveToken, TxResult } from '@argonprotocol/apps-core';
import { describe, expect, it, vi } from 'vitest';

import { MoveCapital } from '../lib/MoveCapital.ts';
import { TransactionInfo } from '../lib/TransactionInfo.ts';
import type { TransactionTracker } from '../lib/TransactionTracker.ts';
import { TxAttemptState } from '../lib/TransactionTracker.ts';
import { existentialDepositMicronots } from '../lib/WalletForArgon.ts';
import type { WalletKeys } from '../lib/WalletKeys.ts';
import { ExtrinsicType, type ITransactionRecord, TransactionStatus } from '../lib/db/TransactionsTable.ts';
import type { IAllocationChange, ITransactionMoveMetadata } from '../lib/txs/Balance.transfer.ts';

const argonAddress = '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY';

describe('MoveCapital', () => {
  it('rejects a non-Argon external destination before preparing a transfer', async () => {
    const moveCapital = createMoveCapital();

    await expect(
      moveCapital.sendToAddress({
        destinationAddress: '0x742d35Cc6634C0532925a3b844Bc454e4438f44e',
        moveToken: MoveToken.ARGN,
        amount: 100n,
        availableMicrogons: 1_000n,
        availableMicronots: 0n,
      }),
    ).rejects.toThrow('Enter a valid Argon address.');
  });

  it('keeps the transfer fee out of the maximum external ARGN amount', async () => {
    const moveCapital = createMoveCapital();
    vi.spyOn(moveCapital, 'getTransferFee').mockResolvedValue(25n);

    await expect(
      moveCapital.getExternalTransferQuote({
        destinationAddress: argonAddress,
        moveToken: MoveToken.ARGN,
        availableMicrogons: 1_000n,
        availableMicronots: 0n,
      }),
    ).resolves.toEqual({ maximumAmount: 975n, transactionFeeMicrogons: 25n });
  });

  it('requires enough ARGN to pay the network fee for an ARGNOT transfer', async () => {
    const moveCapital = createMoveCapital();
    vi.spyOn(moveCapital, 'getTransferFee').mockResolvedValue(101n);

    await expect(
      moveCapital.getExternalTransferQuote({
        destinationAddress: argonAddress,
        moveToken: MoveToken.ARGNOT,
        availableMicrogons: 100n,
        availableMicronots: 1_000_000_000n,
      }),
    ).rejects.toThrow('Your wallet does not have enough ARGN to pay the network fee.');
  });

  it('does not reduce an allocation below funds already reserved by its wallet', async () => {
    const moveCapital = createMoveCapital();

    await expect(
      moveCapital.changeAllocation({
        targetMicrogons: 99n,
        targetMicronots: 100n,
        sourceWallet: { availableMicronots: existentialDepositMicronots } as any,
        allocatedWallet: {
          availableMicrogons: 0n,
          reservedMicrogons: 100n,
          availableMicronots: 0n,
          reservedMicronots: 100n,
        } as any,
        allocateFrom: MoveFrom.DefaultArgon,
        allocateTo: MoveTo.MiningBot,
      }),
    ).rejects.toThrow('Allocation cannot be lower than the ARGN currently reserved by this wallet.');
  });

  it('keeps the ARGNOT existential deposit in the allocated wallet', async () => {
    const moveCapital = createMoveCapital();
    const move = vi.spyOn(moveCapital, 'move').mockResolvedValue({} as TransactionInfo<ITransactionMoveMetadata>);

    await expect(
      moveCapital.changeAllocation({
        targetMicrogons: 0n,
        targetMicronots: existentialDepositMicronots - 1n,
        sourceWallet: { availableMicronots: existentialDepositMicronots } as any,
        allocatedWallet: {
          availableMicrogons: 0n,
          reservedMicrogons: 0n,
          availableMicronots: existentialDepositMicronots * 2n,
          reservedMicronots: 0n,
        } as any,
        allocateFrom: MoveFrom.DefaultArgon,
        allocateTo: MoveTo.MiningBot,
      }),
    ).rejects.toThrow('Each wallet must keep its minimum ARGNOT balance.');
    expect(move).not.toHaveBeenCalled();
  });

  it('keeps the ARGNOT existential deposit in the funding wallet', async () => {
    const moveCapital = createMoveCapital();
    const move = vi.spyOn(moveCapital, 'move').mockResolvedValue({} as TransactionInfo<ITransactionMoveMetadata>);

    await expect(
      moveCapital.changeAllocation({
        targetMicrogons: 0n,
        targetMicronots: 1n,
        sourceWallet: { availableMicronots: existentialDepositMicronots } as any,
        allocatedWallet: {
          availableMicrogons: 0n,
          reservedMicrogons: 0n,
          availableMicronots: 0n,
          reservedMicronots: 0n,
        } as any,
        allocateFrom: MoveFrom.DefaultArgon,
        allocateTo: MoveTo.MiningBot,
      }),
    ).rejects.toThrow('Each wallet must keep its minimum ARGNOT balance.');
    expect(move).not.toHaveBeenCalled();
  });

  it('returns ARGN first when the source wallet needs it to fund an ARGNOT allocation', async () => {
    const moveCapital = createMoveCapital();
    const submitted = {} as TransactionInfo<ITransactionMoveMetadata>;
    const move = vi.spyOn(moveCapital, 'move').mockResolvedValue(submitted);

    await expect(
      moveCapital.changeAllocation({
        targetMicrogons: 100n,
        targetMicronots: 50n,
        sourceWallet: { availableMicronots: existentialDepositMicronots + 50n } as any,
        allocatedWallet: {
          availableMicrogons: 200n,
          reservedMicrogons: 0n,
          availableMicronots: 0n,
          reservedMicronots: 0n,
        } as any,
        allocateFrom: MoveFrom.DefaultArgon,
        allocateTo: MoveTo.MiningBot,
      }),
    ).resolves.toBe(submitted);

    expect(move).toHaveBeenCalledWith(
      expect.objectContaining({
        moveFrom: MoveFrom.MiningBot,
        moveTo: MoveTo.DefaultArgon,
        assetsToMove: { [MoveToken.ARGN]: 100n },
        allocationChange: expect.objectContaining({
          legIndex: 0,
          legs: [
            {
              moveFrom: MoveFrom.MiningBot,
              moveTo: MoveTo.DefaultArgon,
              assetsToMove: { [MoveToken.ARGN]: 100n },
            },
            {
              moveFrom: MoveFrom.DefaultArgon,
              moveTo: MoveTo.MiningBot,
              assetsToMove: { [MoveToken.ARGNOT]: 50n },
            },
          ],
        }),
      }),
    );
  });

  it('removes a restored allocation change from pending state when post-processing completes', async () => {
    let resolveFinalization!: () => void;
    const waitForFinalizedBlock = new Promise<void>(resolve => {
      resolveFinalization = resolve;
    });
    const txResult = { waitForFinalizedBlock, isFinalized: false } as unknown as TxResult;
    const txInfo = new TransactionInfo<ITransactionMoveMetadata>({
      tx: {
        id: 1,
        status: TransactionStatus.Submitted,
        extrinsicType: ExtrinsicType.Transfer,
        isFinalized: false,
        metadataJson: {
          moveFrom: MoveFrom.DefaultArgon,
          moveTo: MoveTo.MiningBot,
          assetsToMove: { [MoveToken.ARGN]: 100n },
          allocationChange: {
            id: 'allocation-1',
            targetMicrogons: 100n,
            targetMicronots: 0n,
            legIndex: 0,
            legs: [
              {
                moveFrom: MoveFrom.DefaultArgon,
                moveTo: MoveTo.MiningBot,
                assetsToMove: { [MoveToken.ARGN]: 100n },
              },
            ],
          },
        },
        createdAt: new Date(),
      } as ITransactionRecord<ITransactionMoveMetadata>,
      txResult,
    });
    const transactionTracker = {
      data: { txInfos: [txInfo] },
      pendingBlockTxInfosAtLoad: [txInfo],
      load: vi.fn().mockResolvedValue(undefined),
      getTxAttemptState: vi.fn().mockResolvedValue(TxAttemptState.Pending),
    } as unknown as TransactionTracker;
    const moveCapital = new MoveCapital({} as WalletKeys, transactionTracker);

    await moveCapital.load();
    expect(moveCapital.data.pendingAllocationChange).toBe(txInfo);

    txInfo.tx.isFinalized = true;
    txResult.isFinalized = true;
    resolveFinalization();
    await txInfo.waitForPostProcessing;
    await Promise.resolve();

    expect(moveCapital.data.pendingAllocationChange).toBeUndefined();
  });

  it('restores the error from a failed allocation leg', async () => {
    const allocationChange = {
      id: 'allocation-1',
      targetMicrogons: 50n,
      targetMicronots: 50n,
      legIndex: 0,
      legs: [
        {
          moveFrom: MoveFrom.DefaultArgon,
          moveTo: MoveTo.MiningBot,
          assetsToMove: { [MoveToken.ARGN]: 50n },
        },
        {
          moveFrom: MoveFrom.MiningBot,
          moveTo: MoveTo.DefaultArgon,
          assetsToMove: { [MoveToken.ARGNOT]: 50n },
        },
      ],
    };
    const root = {
      tx: {
        id: 1,
        extrinsicType: ExtrinsicType.Transfer,
        isFinalized: true,
        followOnTxId: 2,
        metadataJson: { ...allocationChange.legs[0], allocationChange },
      },
      txResult: {},
      hasPendingPostProcessing: false,
    } as unknown as TransactionInfo<ITransactionMoveMetadata>;
    const failedLeg = {
      tx: {
        id: 2,
        extrinsicType: ExtrinsicType.Transfer,
        isFinalized: true,
        metadataJson: {
          ...allocationChange.legs[1],
          allocationChange: { ...allocationChange, legIndex: 1 },
        },
      },
      txResult: { extrinsicError: new Error('ARGNOT return failed.') },
      hasPendingPostProcessing: false,
    } as unknown as TransactionInfo<ITransactionMoveMetadata>;
    const moveCapital = new MoveCapital(
      {} as WalletKeys,
      {
        data: { txInfos: [failedLeg, root] },
        pendingBlockTxInfosAtLoad: [],
        load: vi.fn().mockResolvedValue(undefined),
      } as unknown as TransactionTracker,
    );

    await moveCapital.load();

    expect(moveCapital.data.pendingAllocationChange).toBeUndefined();
    expect(moveCapital.data.allocationError).toBe('ARGNOT return failed.');
  });

  it('does not report an external transfer failure as an allocation failure', async () => {
    const transferError = new Error('External transfer failed.');
    const txInfo = new TransactionInfo<ITransactionMoveMetadata>({
      tx: {
        id: 1,
        status: TransactionStatus.Submitted,
        extrinsicType: ExtrinsicType.Transfer,
        isFinalized: false,
        metadataJson: {
          moveFrom: MoveFrom.DefaultArgon,
          moveTo: MoveTo.External,
          externalAddress: argonAddress,
          assetsToMove: { [MoveToken.ARGN]: 100n },
        },
        createdAt: new Date(),
      } as ITransactionRecord<ITransactionMoveMetadata>,
      txResult: {
        waitForFinalizedBlock: Promise.reject(transferError),
        isFinalized: false,
      } as unknown as TxResult,
    });
    const moveCapital = new MoveCapital(
      {} as WalletKeys,
      {
        data: { txInfos: [txInfo] },
        pendingBlockTxInfosAtLoad: [txInfo],
        load: vi.fn().mockResolvedValue(undefined),
      } as unknown as TransactionTracker,
    );

    await moveCapital.load();
    await expect(txInfo.waitForPostProcessing).rejects.toThrow(transferError.message);
    await Promise.resolve();

    expect(moveCapital.data.allocationError).toBeUndefined();
  });

  it('continues a missing allocation leg after restart', async () => {
    const allocationChange: IAllocationChange = {
      id: 'allocation-1',
      targetMicrogons: 50n,
      targetMicronots: 50n,
      legIndex: 0,
      legs: [
        {
          moveFrom: MoveFrom.DefaultArgon,
          moveTo: MoveTo.MiningBot,
          assetsToMove: { [MoveToken.ARGN]: 50n },
        },
        {
          moveFrom: MoveFrom.MiningBot,
          moveTo: MoveTo.DefaultArgon,
          assetsToMove: { [MoveToken.ARGNOT]: 50n },
        },
      ],
    };
    const firstLeg = createAllocationTransaction(1, allocationChange);
    const secondLeg = createAllocationTransaction(2, { ...allocationChange, legIndex: 1 });
    const followOn = { resolve: vi.fn(), reject: vi.fn() };
    const transactionTracker = {
      data: { txInfos: [firstLeg] },
      pendingBlockTxInfosAtLoad: [],
      load: vi.fn().mockResolvedValue(undefined),
      getTxAttemptState: vi.fn().mockResolvedValue(TxAttemptState.Finalized),
      createIntentForFollowOnTx: vi.fn().mockReturnValue(followOn),
    } as unknown as TransactionTracker;
    const moveCapital = new MoveCapital({} as WalletKeys, transactionTracker);
    const move = vi.spyOn(moveCapital, 'move').mockImplementation(async () => {
      transactionTracker.data.txInfos.push(secondLeg);
      return secondLeg;
    });

    await moveCapital.load();
    await vi.waitFor(() => expect(move).toHaveBeenCalledOnce());
    await secondLeg.waitForPostProcessing;
    await Promise.resolve();

    expect(move).toHaveBeenCalledWith({
      ...allocationChange.legs[1],
      allocationChange: { ...allocationChange, legIndex: 1 },
      client: undefined,
    });
    expect(followOn.resolve).toHaveBeenCalledWith(secondLeg);
    await vi.waitFor(() => expect(moveCapital.data.pendingAllocationChange).toBeUndefined());
  });

  it('replaces the active allocation leg after restart', async () => {
    const allocationChange: IAllocationChange = {
      id: 'allocation-1',
      targetMicrogons: 50n,
      targetMicronots: 0n,
      legIndex: 0,
      legs: [
        {
          moveFrom: MoveFrom.DefaultArgon,
          moveTo: MoveTo.MiningBot,
          assetsToMove: { [MoveToken.ARGN]: 50n },
        },
      ],
    };
    const expiredLeg = createAllocationTransaction(1, allocationChange, false);
    const transactionTracker = {
      data: { txInfos: [expiredLeg] },
      pendingBlockTxInfosAtLoad: [],
      load: vi.fn().mockResolvedValue(undefined),
      getTxAttemptState: vi.fn().mockResolvedValue(TxAttemptState.Replace),
    } as unknown as TransactionTracker;
    const moveCapital = new MoveCapital({} as WalletKeys, transactionTracker);
    const move = vi.spyOn(moveCapital, 'move').mockResolvedValue(expiredLeg);

    await moveCapital.load();

    expect(move).toHaveBeenCalledWith({
      ...allocationChange.legs[0],
      allocationChange,
      client: undefined,
    });
    expect(moveCapital.data.pendingAllocationChange).toBe(expiredLeg);
  });
});

function createMoveCapital() {
  return new MoveCapital(
    {
      defaultArgonAddress: 'default-address',
      miningBotAddress: 'mining-address',
    } as any,
    {
      data: { txInfos: [] },
      pendingBlockTxInfosAtLoad: [],
      load: vi.fn().mockResolvedValue(undefined),
    } as any,
  );
}

function createAllocationTransaction(
  id: number,
  allocationChange: IAllocationChange,
  isFinalized = true,
): TransactionInfo<ITransactionMoveMetadata> {
  const leg = allocationChange.legs[allocationChange.legIndex];
  return new TransactionInfo<ITransactionMoveMetadata>({
    tx: {
      id,
      status: TransactionStatus.Submitted,
      extrinsicType: ExtrinsicType.Transfer,
      isFinalized,
      metadataJson: { ...leg, allocationChange },
      createdAt: new Date(),
    } as ITransactionRecord<ITransactionMoveMetadata>,
    txResult: {
      waitForFinalizedBlock: isFinalized ? Promise.resolve() : new Promise(() => undefined),
      isFinalized,
    } as unknown as TxResult,
  });
}
