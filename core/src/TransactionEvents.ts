import { type ExtrinsicError, type SignedBlock, u8aToHex } from '@argonprotocol/mainchain';
import type { HistoricalEvent, HistoricalQueryRecord } from '@argonprotocol/runtime-client';
import { BlockWatch, type IBlockHeaderInfo } from './BlockWatch.js';
import type { ArgonClient } from './MainchainClients.js';
import {
  findRuntimeModuleError,
  runtimeDispatchErrorToExtrinsicError,
  type RuntimeDispatchError,
} from './RuntimeDispatchError.js';

type RuntimeSystemEventRecord = HistoricalQueryRecord<'system', 'events'>[number];

type IsMatchingEventFn = (
  event: HistoricalEvent,
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
    events: RuntimeSystemEventRecord[];
  }): Promise<{ tip: bigint; fee: bigint; error?: ExtrinsicError; extrinsicEvents: HistoricalEvent[] }> {
    const { client, events, extrinsicIndex } = args;

    const applyExtrinsicEvents = events
      .filter(x => x.phase.type === 'ApplyExtrinsic' && x.phase.value === extrinsicIndex)
      .map(x => x.event);
    let fee = 0n;
    let tip = 0n;
    let extrinsicError: ExtrinsicError | undefined;

    for (const event of applyExtrinsicEvents) {
      if (event.section === 'transactionPayment' && event.method === 'TransactionFeePaid') {
        const { actualFee, tip: t } = event.data;
        fee = actualFee;
        tip = t;
      } else if (event.section === 'utility' && event.method === 'BatchInterrupted') {
        const { error, index } = event.data;
        extrinsicError = runtimeDispatchErrorToExtrinsicError(client, error, index);
      } else if (event.section === 'system' && event.method === 'ExtrinsicFailed') {
        const { dispatchError } = event.data;
        extrinsicError = runtimeDispatchErrorToExtrinsicError(client, dispatchError);
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
  }): Promise<{ tip: bigint; fee: bigint; error?: ExtrinsicError; extrinsicEvents: HistoricalEvent[] } | undefined> {
    const { client, blockHash, accountAddress, isMatchingEvent } = args;
    const api = await client.at(blockHash);

    const events = await api.query.system.events();
    const applyExtrinsicEvents = events.filter(x => x.phase.type === 'ApplyExtrinsic');
    for (const { event, phase } of applyExtrinsicEvents) {
      if (event.section !== 'transactionPayment' || event.method !== 'TransactionFeePaid') {
        continue;
      }
      const { who, actualFee, tip } = event.data;
      if (who !== accountAddress) {
        continue;
      }
      // now we're filtered to only fees paid by this account
      const extrinsicIndex = phase.type === 'ApplyExtrinsic' ? phase.value : -1;
      for (const extrinsicEvent of applyExtrinsicEvents) {
        // .. match only on the events for this extrinsic
        if (extrinsicEvent.phase.type !== 'ApplyExtrinsic' || extrinsicEvent.phase.value !== extrinsicIndex) continue;

        let dispatchError: RuntimeDispatchError | undefined;
        let batchInterruptedIndex: number | undefined;
        if (extrinsicEvent.event.section === 'utility' && extrinsicEvent.event.method === 'BatchInterrupted') {
          const { error, index } = extrinsicEvent.event.data;
          dispatchError = error;
          batchInterruptedIndex = index;
        }
        if (extrinsicEvent.event.section === 'system' && extrinsicEvent.event.method === 'ExtrinsicFailed') {
          ({ dispatchError } = extrinsicEvent.event.data);
        }

        const registryError = dispatchError ? findRuntimeModuleError(client, dispatchError) : undefined;
        if (isMatchingEvent(extrinsicEvent.event, registryError)) {
          const extrinsicError = dispatchError
            ? runtimeDispatchErrorToExtrinsicError(client, dispatchError, batchInterruptedIndex)
            : undefined;
          return {
            fee: actualFee,
            tip,
            error: extrinsicError,
            extrinsicEvents: applyExtrinsicEvents
              .filter(x => x.phase.type === 'ApplyExtrinsic' && x.phase.value === extrinsicIndex)
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
        extrinsicEvents: HistoricalEvent[];
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

      const found = await this.findByExtrinsicHashInBlock({
        blockWatch,
        extrinsicHash,
        block: header,
        blockCache,
      });
      if (found) {
        return found;
      }
    }

    return undefined;
  }

  public static async findByExtrinsicHashInBlock(args: {
    blockWatch: BlockWatch;
    extrinsicHash: string;
    block: Pick<IBlockHeaderInfo, 'blockNumber' | 'blockHash'>;
    blockCache?: IBlockCache;
  }): Promise<
    | {
        blockNumber: number;
        blockHash: string;
        blockTime: number;
        extrinsicIndex: number;
        fee: bigint;
        tip: bigint;
        error?: ExtrinsicError;
        extrinsicEvents: HistoricalEvent[];
      }
    | undefined
  > {
    const { blockWatch, extrinsicHash, block, blockCache } = args;
    const client = await blockWatch.getRpcClient(block.blockNumber);
    const signedBlock = blockCache?.get(block.blockHash) ?? (await blockWatch.getBlock(block));
    blockCache?.set(block.blockHash, signedBlock);
    const header = BlockWatch.readHeader(
      signedBlock.block.header,
      block.blockNumber <= blockWatch.finalizedBlockHeader.blockNumber,
    );

    for (const [index, extrinsic] of signedBlock.block.extrinsics.entries()) {
      if (u8aToHex(extrinsic.hash) !== extrinsicHash) continue;

      const events = await blockWatch.getEvents(header);
      const txEvents = await this.getErrorAndFeeForTransaction({
        client,
        extrinsicIndex: index,
        events,
      });

      return {
        blockNumber: header.blockNumber,
        blockHash: header.blockHash,
        blockTime: header.blockTime,
        extrinsicIndex: index,
        fee: txEvents.fee,
        tip: txEvents.tip,
        error: txEvents.error,
        extrinsicEvents: txEvents.extrinsicEvents,
      };
    }

    return undefined;
  }
}
