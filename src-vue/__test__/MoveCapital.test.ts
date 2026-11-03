import { MoveFrom, MoveTo, MoveToken, TxResult, type ArgonClient, type BlockWatch } from '@argonprotocol/apps-core';
import * as Vue from 'vue';
import { describe, expect, it, vi } from 'vitest';

import { MoveCapital } from '../lib/MoveCapital.ts';
import { TransactionInfo } from '../lib/TransactionInfo.ts';
import { TransactionTracker, TxAttemptState } from '../lib/TransactionTracker.ts';
import { existentialDepositMicronots } from '../lib/WalletForArgon.ts';
import { WalletKeys } from '../lib/WalletKeys.ts';
import { ExtrinsicType, type ITransactionRecord, TransactionStatus } from '../lib/db/TransactionsTable.ts';
import type { IAllocationChange, ITransactionMoveMetadata } from '../lib/txs/Balance.transfer.ts';
import { getOfflineRegistry, hexToU8a, u8aToHex, type KeyringPair } from '@argonprotocol/mainchain';
import { signatureVerify } from '@polkadot/util-crypto';
import type { SignerOptions } from '@polkadot/api-base/types';
import { createTestDb } from './helpers/db.ts';
import * as mainchain from '../stores/mainchain.ts';

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

  it('removes a finalized allocation from pending state before its transaction record catches up', async () => {
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
        accountAddress: 'default-address',
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
    const moveCapital = new MoveCapital({} as WalletKeys, transactionTracker, async () => {});
    moveCapital.data = Vue.shallowReactive(moveCapital.data);
    const observedPendingIds: (number | undefined)[] = [];
    const stopObserving = Vue.watch(
      () => moveCapital.data.pendingAllocationChange,
      pending => observedPendingIds.push(pending?.tx.id),
      { immediate: true },
    );

    await moveCapital.load();
    expect(moveCapital.data.pendingAllocationChange).toBe(txInfo);

    txResult.isFinalized = true;
    resolveFinalization();
    await txInfo.waitForPostProcessing;
    await Vue.nextTick();

    expect(txInfo.tx.isFinalized).toBe(false);
    expect(moveCapital.data.pendingAllocationChange).toBeUndefined();
    expect(observedPendingIds).toEqual([undefined, 1, undefined]);
    stopObserving();
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
        blockExtrinsicErrorJson: { message: 'ARGNOT return failed.' },
        metadataJson: {
          ...allocationChange.legs[1],
          allocationChange: { ...allocationChange, legIndex: 1 },
        },
      },
      txResult: { extrinsicError: new Error('ARGNOT return failed.') },
      hasPendingPostProcessing: false,
    } as unknown as TransactionInfo<ITransactionMoveMetadata>;
    const moveCapital = new MoveCapital(
      { defaultArgonAddress: 'default-address' } as WalletKeys,
      {
        data: { txInfos: [failedLeg, root] },
        pendingBlockTxInfosAtLoad: [],
        load: vi.fn().mockResolvedValue(undefined),
      } as unknown as TransactionTracker,
      async () => {},
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
      async () => {},
    );

    await moveCapital.load();
    await expect(txInfo.waitForPostProcessing).rejects.toThrow(transferError.message);
    await Promise.resolve();

    expect(moveCapital.data.allocationError).toBeUndefined();
  });

  it('continues a missing allocation leg after restart using session signing', async () => {
    const db = await createTestDb();
    const mnemonic = 'test test test test test test test test test test test junk';
    const keys = WalletKeys.fromMnemonic(mnemonic);
    const authenticate = vi.fn(async () => {
      throw new Error('Internal allocation must not prompt');
    });
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
    const first = await db.transactionsTable.insert({
      extrinsicHash: `0x${'01'.repeat(32)}`,
      extrinsicMethodJson: {},
      metadataJson: { ...allocationChange.legs[0], allocationChange },
      extrinsicType: ExtrinsicType.Transfer,
      accountAddress: keys.defaultArgonAddress,
      submittedAtBlockHeight: 1,
      submittedAtTime: new Date(),
      txNonce: 0,
    });
    const block = { blockNumber: 1, blockHash: `0x${'10'.repeat(32)}`, blockTime: new Date() };
    await db.transactionsTable.recordInBlock(first, {
      ...block,
      tip: 0n,
      feePlusTip: 1n,
      extrinsicIndex: 0,
      transactionEvents: [],
    });
    await db.transactionsTable.markFinalized(first, block);

    const payload = '0x010203';
    const signatures: { signature: string; address: string }[] = [];
    const extrinsic = {
      paymentInfo: async () => ({ partialFee: { toBigInt: () => 1n } }),
      signAsync: async (keypair: KeyringPair, options: SignerOptions) => {
        const address = keypair.address;
        const signature = u8aToHex(keypair.sign(hexToU8a(payload), { withType: true }));
        signatures.push({ signature, address });
        return {
          hash: { toHex: () => `0x${'02'.repeat(32)}` },
          method: { toHuman: () => ({}) },
          nonce: { toNumber: () => 0 },
          era: options.era,
          send: async () => {
            throw new Error('Chain rejected the follow-on');
          },
        };
      },
    };
    const tx = Object.assign((value: unknown) => value, {
      ownership: { transferAllowDeath: () => extrinsic },
      balances: { transferAllowDeath: () => extrinsic },
    });
    const client = {
      tx,
      registry: getOfflineRegistry(),
      consts: { system: { blockHashCount: 256 } },
      derive: { tx: { signingInfo: async () => ({ nonce: 0, mortalLength: 64 }) } },
      query: { system: { account: async () => ({ data: { free: 1_000n } }) } },
      rpc: {
        system: { accountNextIndex: async () => ({ toNumber: () => 0 }) },
        chain: { getHeader: async () => ({ number: { toNumber: () => 2 } }) },
      },
    } as unknown as ArgonClient;
    const chain = vi.spyOn(mainchain, 'getMainchainClient').mockResolvedValue(client);
    const blockWatch = {
      start: async () => undefined,
      bestBlockHeader: block,
      finalizedBlockHeader: block,
      events: { on: () => () => undefined },
    } as unknown as BlockWatch;
    const tracker = new TransactionTracker(Promise.resolve(db), blockWatch);
    const moveCapital = new MoveCapital(keys, tracker, authenticate);
    try {
      await moveCapital.load();
      await vi.waitFor(() => expect(moveCapital.data.allocationError).toBe('Chain rejected the follow-on'));
      expect(moveCapital.data.pendingAllocationChange).toBeUndefined();
      expect(authenticate).not.toHaveBeenCalled();
      expect(signatures).toHaveLength(1);
      expect(signatureVerify(payload, signatures[0].signature, keys.miningBotAddress).isValid).toBe(true);
      const rows = await db.transactionsTable.fetchAll();
      expect(rows).toHaveLength(2);
      expect(rows.find(row => row.id === first.id)?.followOnTxId).toBe(rows.find(row => row.id !== first.id)?.id);
      expect(rows.find(row => row.id !== first.id)?.submissionErrorJson?.message).toBe('Chain rejected the follow-on');
    } finally {
      await tracker.shutdown();
      chain.mockRestore();
      await db.close();
    }
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
    const moveCapital = new MoveCapital({} as WalletKeys, transactionTracker, async () => {});
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
    async () => {},
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
