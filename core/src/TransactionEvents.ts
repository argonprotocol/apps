import {
  type ArgonClient,
  dispatchErrorToExtrinsicError,
  type ExtrinsicError,
  type FrameSystemEventRecord,
  type GenericEvent,
  type SignedBlock,
  type SpRuntimeDispatchError,
  u8aToHex,
} from '@argonprotocol/mainchain';
import type { BlockWatch } from './BlockWatch.js';

type IsMatchingEventFn = (
  event: GenericEvent,
  registryError?: { section: string; method: string; index: number; name: string },
) => boolean;

type IBlockCache = {
  get(key: string): SignedBlock | undefined;
  set(key: string, value: SignedBlock): unknown;
};

export class TransactionEvents {
  public static async getErrorAndFeeForTransaction(args: {
    client: ArgonClient;
    extrinsicIndex: number;
    events: FrameSystemEventRecord[];
  }): Promise<{ tip: bigint; fee: bigint; error?: ExtrinsicError; extrinsicEvents: GenericEvent[] }> {
    const { client, events, extrinsicIndex } = args;

    const applyExtrinsicEvents = events
      .filter(x => x.phase.isApplyExtrinsic && x.phase.asApplyExtrinsic.toNumber() === extrinsicIndex)
      .map(x => x.event);
    let fee = 0n;
    let tip = 0n;
    let extrinsicError: ExtrinsicError | undefined;

    for (const event of applyExtrinsicEvents) {
      if (client.events.transactionPayment.TransactionFeePaid.is(event)) {
        const { actualFee, tip: t } = event.data;
        fee = actualFee.toBigInt();
        tip = t.toBigInt();
      } else if (client.events.utility.BatchInterrupted.is(event)) {
        const { error, index } = event.data;
        extrinsicError = dispatchErrorToExtrinsicError(client, error as any, index.toNumber());
      } else if (client.events.system.ExtrinsicFailed.is(event)) {
        const { dispatchError } = event.data;
        extrinsicError = dispatchErrorToExtrinsicError(client, dispatchError as any);
      }
    }

    return {
      fee: fee,
      tip: tip,
      error: extrinsicError,
      extrinsicEvents: applyExtrinsicEvents,
    };
  }

  public static async findFromFeePaidEvent(args: {
    client: ArgonClient;
    blockHash: Uint8Array;
    accountAddress: string;
    isMatchingEvent: IsMatchingEventFn;
  }): Promise<{ tip: bigint; fee: bigint; error?: ExtrinsicError; extrinsicEvents: GenericEvent[] } | undefined> {
    const { client, blockHash, accountAddress, isMatchingEvent } = args;
    const api = await client.at(blockHash);

    const events = await api.query.system.events();
    const applyExtrinsicEvents = events.filter(x => x.phase.isApplyExtrinsic);
    for (const { event, phase } of applyExtrinsicEvents) {
      if (!client.events.transactionPayment.TransactionFeePaid.is(event)) {
        continue;
      }
      const { who, actualFee, tip } = event.data;
      if (who.toHuman() !== accountAddress) {
        continue;
      }
      // now we're filtered to only fees paid by this account
      const extrinsicIndex = phase.asApplyExtrinsic.toNumber();
      for (const extrinsicEvent of applyExtrinsicEvents) {
        // .. match only on the events for this extrinsic
        if (extrinsicEvent.phase.asApplyExtrinsic.toNumber() !== extrinsicIndex) continue;

        let dispatchError: SpRuntimeDispatchError | undefined;
        let batchInterruptedIndex: number | undefined;
        if (client.events.utility.BatchInterrupted.is(extrinsicEvent.event)) {
          const { error, index } = extrinsicEvent.event.data;
          dispatchError = error;
          batchInterruptedIndex = index.toNumber();
        }
        if (client.events.system.ExtrinsicFailed.is(extrinsicEvent.event)) {
          ({ dispatchError } = extrinsicEvent.event.data);
        }

        const registryError = dispatchError?.isModule
          ? client.registry.findMetaError(dispatchError.asModule)
          : undefined;
        if (isMatchingEvent(extrinsicEvent.event, registryError)) {
          const extrinsicError = dispatchError
            ? dispatchErrorToExtrinsicError(client, dispatchError as any, batchInterruptedIndex)
            : undefined;
          return {
            fee: actualFee.toBigInt(),
            tip: tip.toBigInt(),
            error: extrinsicError,
            extrinsicEvents: applyExtrinsicEvents
              .filter(x => x.phase.asApplyExtrinsic.toNumber() === extrinsicIndex)
              .map(event => event.event),
          };
        }
      }
    }
    return undefined;
  }

  public static async findByExtrinsicHash(args: {
    blockWatch: BlockWatch;
    extrinsicHash: string;
    searchStartBlockHeight: number;
    bestBlockHeight: number;
    maxBlocksToCheck?: number;
    blockCache?: IBlockCache;
    ignoreHeaderErrors?: boolean;
  }): Promise<
    | {
        blockNumber: number;
        blockHash: string;
        blockTime: number;
        extrinsicIndex: number;
        fee: bigint;
        tip: bigint;
        error?: ExtrinsicError;
        extrinsicEvents: GenericEvent[];
      }
    | undefined
  > {
    const { blockWatch, extrinsicHash, searchStartBlockHeight, bestBlockHeight, blockCache, ignoreHeaderErrors } = args;
    if (searchStartBlockHeight > bestBlockHeight) {
      return undefined;
    }

    const maxBlocksToCheck = args.maxBlocksToCheck ?? Math.max(0, bestBlockHeight - searchStartBlockHeight);

    for (let i = 0; i <= maxBlocksToCheck; i++) {
      const blockHeight = searchStartBlockHeight + i;
      if (blockHeight > bestBlockHeight) {
        return undefined;
      }

      const header = await blockWatch.getHeader(blockHeight).catch(error => {
        if (ignoreHeaderErrors) return null;
        throw error;
      });
      if (!header) continue;

      const client = await blockWatch.getRpcClient(blockHeight);
      const block = await this.getBlock(client, header.blockHash, blockCache);

      for (const [index, extrinsic] of block.block.extrinsics.entries()) {
        if (u8aToHex(extrinsic.hash) !== extrinsicHash) continue;

        const events = await blockWatch.getEvents(header);
        const txEvents = await this.getErrorAndFeeForTransaction({
          client,
          extrinsicIndex: index,
          events,
        });

        return {
          blockNumber: blockHeight,
          blockHash: header.blockHash,
          blockTime: header.blockTime,
          extrinsicIndex: index,
          fee: txEvents.fee,
          tip: txEvents.tip,
          error: txEvents.error,
          extrinsicEvents: txEvents.extrinsicEvents,
        };
      }
    }

    return undefined;
  }

  private static async getBlock(
    client: ArgonClient,
    blockHash: string,
    blockCache?: IBlockCache,
  ): Promise<SignedBlock> {
    const cached = blockCache?.get(blockHash);
    if (cached) return cached;

    const block = await client.rpc.chain.getBlock(blockHash);
    blockCache?.set(blockHash, block);
    return block;
  }
}
